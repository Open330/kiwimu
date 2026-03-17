"""kiwimu CLI - Turn textbooks and web content into your own interlinked wiki."""

from __future__ import annotations

import http.server
import functools
import socketserver
from datetime import date
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from .config import DB_FILE, KiwiConfig, find_project_root
from .store.store import Store

console = Console()


def get_store(root: Path) -> Store:
    store = Store(root / DB_FILE)
    return store


@click.group()
@click.version_option(package_name="kiwimu")
def main():
    """🥝 kiwimu - 나만의 학습 위키를 만드세요"""
    pass


@main.command()
@click.argument("name", default="My Kiwi")
def init(name: str):
    """빈 키위(위키 프로젝트)를 생성합니다."""
    root = Path.cwd()

    if (root / "kiwi.toml").exists():
        console.print("[yellow]이미 초기화된 프로젝트입니다.[/yellow]")
        return

    config = KiwiConfig(name=name, created=str(date.today()))
    config.save(root)

    store = Store(root / DB_FILE)
    store.init_schema()
    store.close()

    console.print(f"[green]🥝 '{name}' 키위가 생성되었습니다![/green]")
    console.print("  다음 단계: [bold]kiwimu add <URL 또는 PDF>[/bold]")


@main.command()
@click.argument("source")
def add(source: str):
    """URL 또는 PDF 파일을 추가합니다."""
    root = find_project_root()
    store = get_store(root)

    is_url = source.startswith("http://") or source.startswith("https://")
    is_pdf = source.lower().endswith(".pdf")

    if is_url:
        _add_url(store, source)
    elif is_pdf:
        _add_pdf(store, source)
    else:
        console.print(f"[red]지원하지 않는 소스 형식: {source}[/red]")
        console.print("URL (http/https) 또는 PDF 파일을 입력해주세요.")
        return

    store.close()


def _add_url(store: Store, url: str):
    from .ingest.web import extract_sections, fetch_page
    from .pipeline.chunker import chunk_sections

    console.print(f"[blue]📥 URL 가져오는 중: {url}[/blue]")
    title, html = fetch_page(url)
    console.print(f"  제목: {title}")

    source = store.add_source(uri=url, type="web", title=title, raw_content=html)

    console.print("[blue]📄 문서 분할 중...[/blue]")
    sections = extract_sections(html)
    count = chunk_sections(sections, source.id, store)
    console.print(f"[green]✅ {count}개 문서가 생성되었습니다.[/green]")

    # Auto-link
    _run_linker(store)


def _add_pdf(store: Store, pdf_path: str):
    from .ingest.pdf import extract_from_pdf
    from .pipeline.chunker import chunk_sections

    path = Path(pdf_path).resolve()
    if not path.exists():
        console.print(f"[red]파일을 찾을 수 없습니다: {pdf_path}[/red]")
        return

    console.print(f"[blue]📥 PDF 처리 중: {path.name}[/blue]")
    title, sections = extract_from_pdf(path)
    console.print(f"  제목: {title}")

    source = store.add_source(uri=str(path), type="pdf", title=title, raw_content="(PDF)")

    console.print("[blue]📄 문서 분할 중...[/blue]")
    count = chunk_sections(sections, source.id, store)
    console.print(f"[green]✅ {count}개 문서가 생성되었습니다.[/green]")

    _run_linker(store)


def _run_linker(store: Store):
    from .pipeline.linker import auto_link_pages

    console.print("[blue]🔗 자동 링크 생성 중...[/blue]")
    link_count = auto_link_pages(store)
    console.print(f"[green]  {link_count}개 링크가 생성되었습니다.[/green]")


@main.command()
@click.option("--provider", type=click.Choice(["anthropic", "openai", "claude-cli", "codex-cli"]), default=None)
@click.option("--model", default="")
@click.option("--pages", "page_slugs", multiple=True, help="특정 페이지만 확장 (slug)")
def expand(provider: str | None, model: str, page_slugs: tuple[str]):
    """LLM을 사용해 문서를 확장합니다 (선택사항)."""
    root = find_project_root()
    config = KiwiConfig.load(root)
    store = get_store(root)

    provider = provider or config.expand_provider
    if not provider:
        console.print("[yellow]확장 프로바이더가 설정되지 않았습니다.[/yellow]")
        console.print("사용법: kiwimu expand --provider anthropic")
        console.print("또는 kiwi.toml의 [expand] 섹션을 설정하세요.")
        store.close()
        return

    if provider in ("claude-cli", "codex-cli"):
        from .expand.llm import CLIToolExpander
        tool = "claude" if provider == "claude-cli" else "codex"
        expander = CLIToolExpander(tool=tool)
    else:
        from .expand.llm import LLMExpander
        model = model or config.expand_model
        expander = LLMExpander(provider=provider, model=model)

    pages = store.list_pages()
    all_pages = pages

    if page_slugs:
        pages = [p for p in pages if p.slug in page_slugs]
        if not pages:
            console.print("[red]지정한 페이지를 찾을 수 없습니다.[/red]")
            store.close()
            return

    console.print(f"[blue]🧠 {len(pages)}개 문서를 확장합니다...[/blue]")
    for i, page in enumerate(pages, 1):
        console.print(f"  [{i}/{len(pages)}] {page.title}")
        try:
            new_content = expander.expand_page(page, all_pages)
            store.update_page_content(page.id, new_content)
        except Exception as e:
            console.print(f"    [red]실패: {e}[/red]")

    # Re-link after expansion
    _run_linker(store)
    console.print("[green]✅ 확장 완료![/green]")
    store.close()


@main.command()
def build():
    """정적 위키 사이트를 생성합니다."""
    root = find_project_root()
    config = KiwiConfig.load(root)
    store = get_store(root)

    from .build.renderer import build_site

    console.print("[blue]🔨 위키 빌드 중...[/blue]")
    count = build_site(store, config, root)
    console.print(f"[green]✅ {count}개 페이지가 빌드되었습니다![/green]")
    console.print(f"  출력: {root / config.output_dir}/")
    store.close()


@main.command()
@click.option("--port", default=8000, help="포트 번호")
def serve(port: int):
    """위키를 로컬 서버로 실행합니다."""
    root = find_project_root()
    config = KiwiConfig.load(root)
    site_dir = root / config.output_dir

    if not site_dir.exists():
        console.print("[yellow]먼저 빌드가 필요합니다: kiwimu build[/yellow]")
        return

    console.print(f"[green]🥝 키위 위키 서버 시작![/green]")
    console.print(f"  http://localhost:{port}")
    console.print("  종료하려면 Ctrl+C를 누르세요.")

    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler,
        directory=str(site_dir),
    )
    with socketserver.TCPServer(("", port), handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            console.print("\n[yellow]서버를 종료합니다.[/yellow]")


@main.command()
def status():
    """현재 키위 상태를 표시합니다."""
    root = find_project_root()
    config = KiwiConfig.load(root)
    store = get_store(root)

    sources = store.list_sources()
    pages = store.list_pages()
    links = store.get_all_links()

    table = Table(title=f"🥝 {config.name}")
    table.add_column("항목", style="bold")
    table.add_column("값")

    table.add_row("소스", str(len(sources)))
    table.add_row("문서", str(len(pages)))
    table.add_row("링크", str(len(links)))
    table.add_row("빌드 경로", config.output_dir)
    table.add_row("확장 설정", config.expand_provider or "(없음)")

    console.print(table)

    if pages:
        console.print("\n[bold]문서 목록:[/bold]")
        for p in pages:
            console.print(f"  • {p.title} ({p.slug})")

    store.close()


if __name__ == "__main__":
    main()
