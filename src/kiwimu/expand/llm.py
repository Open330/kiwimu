"""LLM-based content expansion via API."""

from __future__ import annotations

import os

from ..store.store import Page


EXPAND_PROMPT = """You are a wiki editor for a learning platform. Given a wiki page about a topic,
expand it with more detail, examples, and related concepts. Keep the markdown format.
Add subsections where appropriate. Be accurate and educational.

Current page title: {title}
Current content:
{content}

Related pages for context:
{context}

Write an expanded version of this page in markdown:"""


class LLMExpander:
    def __init__(self, provider: str = "anthropic", model: str = ""):
        self.provider = provider
        self.model = model

    def expand_page(self, page: Page, context: list[Page]) -> str:
        context_text = "\n".join(f"- {p.title}" for p in context[:10])
        prompt = EXPAND_PROMPT.format(
            title=page.title,
            content=page.content,
            context=context_text,
        )

        if self.provider == "anthropic":
            return self._call_anthropic(prompt)
        elif self.provider == "openai":
            return self._call_openai(prompt)
        else:
            raise ValueError(f"Unknown provider: {self.provider}")

    def _call_anthropic(self, prompt: str) -> str:
        try:
            import anthropic
        except ImportError:
            raise RuntimeError("Install anthropic: pip install kiwimu[llm]")

        client = anthropic.Anthropic()
        model = self.model or "claude-sonnet-4-20250514"
        resp = client.messages.create(
            model=model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.content[0].text

    def _call_openai(self, prompt: str) -> str:
        try:
            import openai
        except ImportError:
            raise RuntimeError("Install openai: pip install kiwimu[llm]")

        client = openai.OpenAI()
        model = self.model or "gpt-4o"
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.choices[0].message.content


class CLIToolExpander:
    def __init__(self, tool: str = "claude"):
        self.tool = tool

    def expand_page(self, page: Page, context: list[Page]) -> str:
        import subprocess
        import tempfile

        context_text = "\n".join(f"- {p.title}" for p in context[:10])
        prompt = EXPAND_PROMPT.format(
            title=page.title,
            content=page.content,
            context=context_text,
        )

        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write(prompt)
            f.flush()

            if self.tool == "claude":
                cmd = ["claude", "-p", prompt]
            elif self.tool == "codex":
                cmd = ["codex", "--quiet", "--prompt", prompt]
            else:
                raise ValueError(f"Unknown CLI tool: {self.tool}")

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode != 0:
                raise RuntimeError(f"{self.tool} failed: {result.stderr}")
            return result.stdout
