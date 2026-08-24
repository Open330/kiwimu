import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContentSecurityPolicy } from "./csp";
import {
  renderActivityPage,
  renderAdmin,
  renderCatalogPage,
  renderDashboardPage,
  renderGraph,
  renderPage,
  renderProvenancePage,
  renderQuizPage,
} from "./templates";

const emptyLinks: Array<{ slug: string; title: string }> = [];

describe("template security and accessibility", () => {
  test("authenticated pages never serialize the bearer token into HTML", () => {
    const admin = renderAdmin({
      wikiName: "Test Wiki",
      sources: [],
      usage: { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0 },
      llmConfig: { provider: "demo", model: "", api_key: "secret-api-key", endpoint: "" },
      personas: [],
      activePersona: "",
    });
    const activity = renderActivityPage("Test Wiki", { total: 0, byAction: {}, recentDays: [] });

    expect(admin).not.toContain('name="kiwi-auth"');
    expect(admin).not.toContain("secret-api-key");
    expect(activity).not.toContain('name="kiwi-auth"');
    expect(activity).not.toContain("Authorization");
  });

  test("escapes the masked API key suffix", () => {
    const admin = renderAdmin({
      wikiName: "Test Wiki",
      sources: [],
      usage: { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0 },
      llmConfig: { provider: "demo", model: "", api_key: "secret<&\">", endpoint: "" },
      personas: [],
      activePersona: "",
    });

    expect(admin).toContain("현재 ••••&lt;&amp;&quot;&gt;");
    expect(admin).not.toContain("현재 ••••<&\">");
  });

  test("admin source forms submit one source and poll its tracked task", () => {
    const admin = renderAdmin({
      wikiName: "Test Wiki",
      sources: [],
      usage: { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0 },
      llmConfig: { provider: "demo", model: "", api_key: "", endpoint: "" },
      personas: [],
      activePersona: "",
      supportedUploadExtensions: ["pdf", "docx", "pptx", "md"],
    });
    const runtime = readFileSync(join(import.meta.dir, "static", "admin.js"), "utf8");
    const fileInput = admin.match(/<input id="source-file"[^>]*>/)?.[0] || "";

    expect(admin).toContain('<form id="url-add-form"');
    expect(admin).toContain('id="source-url" name="source"');
    expect(admin).toContain('id="url-add-status" class="admin-status" role="status" aria-live="polite"');
    expect(admin).toContain('<form id="file-upload-form"');
    expect(fileInput).toContain('name="file"');
    expect(fileInput).not.toContain(" multiple");
    expect(fileInput).toContain('accept=".pdf,.docx,.pptx,.md"');
    expect(admin).toContain("PDF, DOCX, PPTX, Markdown 파일 1개");
    expect(admin).not.toContain('class="config-key">DOC<');
    expect(admin).not.toContain('class="config-key">RTF<');
    expect(admin).toContain('id="file-upload-status" class="admin-status" role="status" aria-live="polite"');
    expect(runtime).toContain("url: '/api/add'");
    expect(runtime).toContain("url: '/api/upload'");
    expect(runtime).toContain("'/api/tasks/' + encodeURIComponent(taskId)");
    expect(runtime).toContain("await waitForTask(data.task_id");
    expect(runtime).toContain("const body = new FormData()");
    expect(runtime).toContain("'X-Kiwimu-File-Extension': extension");
    expect(runtime).not.toContain("fetch('/api/status'");
    expect(runtime).not.toContain("setInterval(");
  });

  test("the visually hidden quiz face is inert until it is shown", () => {
    const html = renderQuizPage({
      wikiName: "Test Wiki",
      quizzes: [],
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });

    const runtime = readFileSync(join(import.meta.dir, "static", "quiz.js"), "utf8");
    expect(html).toContain('id="quiz-card-back" aria-hidden="true" inert');
    expect(html).toContain('id="quiz-live-status" class="visually-hidden" role="status" aria-live="polite"');
    expect(html).toContain('aria-describedby="quiz-question quiz-input-error"');
    expect(html).toContain('<script src="/static/quiz.js"></script>');
    expect(runtime).toContain("front.inert = showAnswer");
    expect(runtime).toContain("back.inert = !showAnswer");
  });

  test("runtime libraries are self-hosted without inline event handlers", () => {
    const quiz = renderQuizPage({
      wikiName: "Test Wiki",
      quizzes: [],
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });
    const graph = renderGraph({
      wikiName: "Test Wiki",
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });
    const admin = renderAdmin({
      wikiName: "Test Wiki",
      sources: [],
      usage: { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0 },
      llmConfig: { provider: "demo", model: "", api_key: "", endpoint: "" },
      personas: [],
      activePersona: "",
    });

    expect(quiz).not.toContain('/static/vendor/katex/katex.min.css');
    expect(quiz).toContain('/static/vendor/katex/katex.min.js');
    expect(quiz).not.toContain('/static/vendor/katex/auto-render.min.js');
    expect(quiz).toContain('/static/vendor-runtime.js');
    expect(graph).toContain('/static/vendor/d3/d3.min.js');
    expect(quiz).toContain('/static/quiz.js');
    expect(admin).toContain('/static/admin.js');
    for (const html of [quiz, graph, admin]) {
      expect(html).not.toMatch(/<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toContain("fonts.googleapis.com");
    }
  });

  test("generated interactive pages use hashed style blocks without style attributes", () => {
    const admin = renderAdmin({
      wikiName: "Test Wiki",
      sources: [],
      usage: { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0 },
      llmConfig: { provider: "openai", model: "test", api_key: "", endpoint: "" },
      personas: [],
      activePersona: "",
    });
    const quiz = renderQuizPage({
      wikiName: "Test Wiki",
      quizzes: [],
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });
    const dashboard = renderDashboardPage({
      wikiName: "Test Wiki",
      stats: { total: 2, mastered: 1, learning: 1, new: 0, dueToday: 0 },
      weakConcepts: [],
      recentAttempts: [],
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });
    const provenance = renderProvenancePage({
      wikiName: "Test Wiki",
      coverage: [{ sourceId: 1, sourceTitle: "Source", citationCount: 1, pageCount: 1, pages: [] }],
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });
    const activity = renderActivityPage("Test Wiki", { total: 0, byAction: {}, recentDays: [] });
    const catalog = renderCatalogPage({
      wikiName: "Test Wiki",
      categories: [],
      totalPages: 0,
      totalLinks: 0,
      generatedAt: "2026-01-01T00:00:00Z",
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });

    for (const html of [admin, quiz, dashboard, provenance, activity, catalog]) {
      const policy = buildContentSecurityPolicy(html);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      if (html.includes("<style")) expect(policy).toContain("style-src 'self' 'sha256-");
      else expect(policy).toContain("style-src 'self'");
      expect(policy).toContain("style-src-attr 'none'");
      expect(policy).not.toContain("'unsafe-inline'");
      expect(policy.split(";").find(directive => directive.trim().startsWith("script-src"))?.trim())
        .toBe("script-src 'self'");

      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attributes = match[1] || "";
        if (/\bsrc\s*=/i.test(attributes)) continue;
        expect(attributes).toMatch(/\btype\s*=\s*["']application\/json["']/i);
      }
    }
  });

  test("serializes per-page data as inert JSON without allowing a script end tag", () => {
    const payload = "</script><script>window.pwned=true</script>";
    const quiz = renderQuizPage({
      wikiName: "Test Wiki",
      quizzes: [{ id: 1, question: payload, answer: "A", quiz_type: "short_answer" }],
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });
    const admin = renderAdmin({
      wikiName: "Test Wiki",
      sources: [],
      usage: { totalCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0 },
      llmConfig: { provider: "demo", model: "", api_key: "", endpoint: "" },
      personas: [{ name: payload, description: "", system_prompt: "", content_style: "" }],
      activePersona: "",
    });

    for (const html of [quiz, admin]) {
      expect(html).toContain("\\u003c/script>");
      expect(html).not.toContain(payload);
      expect(buildContentSecurityPolicy(html)).toContain("script-src 'self'");
    }
  });

  test("bounds large sidebar lists while retaining the active page and category navigation", () => {
    const renderLargePage = (count: number, activeSlug: string) => {
      const sourcePages = Array.from({ length: count }, (_, index) => ({
        slug: `source-${index}`,
        title: `Source ${index}`,
        sourceUri: index < count / 2 ? `/docs/guide-${index}.pdf` : `/notes/note-${index}.md`,
      }));
      const conceptPages = Array.from({ length: count }, (_, index) => ({
        slug: `concept-${index}`,
        title: `Concept ${index}`,
        origin: "batch",
      }));
      return renderPage({
        wikiName: "Large Wiki",
        pageTitle: "Active page",
        pageSlug: activeSlug,
        pageType: "source",
        pageId: count,
        content: "<p>Content</p>",
        externalRefs: "",
        toc: "",
        backlinks: [],
        sourcePages,
        conceptPages,
        categories: [
          { name: "Guides", order: 1, patterns: ["guide-*"] },
          { name: "Notes", order: 2, patterns: ["note-*"] },
        ],
      });
    };

    const medium = renderLargePage(250, "source-249");
    const large = renderLargePage(1_000, "source-999");
    const largeConcept = renderLargePage(1_000, "concept-999");

    expect(medium.match(/href="\/wiki\/source-\d+\.html"/g)).toHaveLength(100);
    expect(medium.match(/href="\/wiki\/concept-\d+\.html"/g)).toHaveLength(100);
    expect(medium).toContain('href="/wiki/source-249.html" class="active"');
    expect(medium).toContain("Notes");
    expect(medium).toContain('150개 문서 생략 · <a href="/catalog.html">전체 목록 보기</a>');

    expect(large.match(/href="\/wiki\/source-\d+\.html"/g)).toHaveLength(100);
    expect(large.match(/href="\/wiki\/concept-\d+\.html"/g)).toHaveLength(100);
    expect(large).toContain('href="/wiki/source-999.html" class="active"');
    expect(large).toContain('900개 문서 생략 · <a href="/catalog.html">전체 목록 보기</a>');
    expect(Buffer.byteLength(large)).toBeLessThan(Buffer.byteLength(medium) + 2_000);
    expect(largeConcept).toContain('href="/wiki/concept-999.html" class="active"');
    expect(largeConcept).toContain('id="sidebar-tab-concept" class="sidebar-tab active"');
    expect(largeConcept).toContain('id="tab-concept" role="tabpanel" aria-labelledby="sidebar-tab-concept"');
  });

  test("emits per-page SEO metadata: canonical, og:url, og:image, og:site_name, and lang", () => {
    const withSeo = renderPage({
      wikiName: "Demo Wiki",
      pageTitle: "Attention",
      pageSlug: "attention",
      pageType: "concept",
      pageId: 1,
      content: '<p><img src="/static/figures/diagram.png" alt="diagram"></p>',
      externalRefs: "",
      toc: "",
      backlinks: [],
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
      seo: { siteUrl: "https://wiki.example.com", lang: "en" },
      ogImage: "/static/figures/diagram.png",
    });

    expect(withSeo).toContain('<html lang="en">');
    expect(withSeo).toContain('<link rel="canonical" href="https://wiki.example.com/wiki/attention.html">');
    expect(withSeo).toContain('<meta property="og:url" content="https://wiki.example.com/wiki/attention.html">');
    expect(withSeo).toContain('<meta property="og:image" content="https://wiki.example.com/static/figures/diagram.png">');
    expect(withSeo).toContain('<meta property="og:site_name" content="Demo Wiki">');

    const withoutSeo = renderPage({
      wikiName: "Demo Wiki",
      pageTitle: "Attention",
      pageSlug: "attention",
      pageType: "concept",
      pageId: 1,
      content: "<p>No figures here.</p>",
      externalRefs: "",
      toc: "",
      backlinks: [],
      sourcePages: emptyLinks,
      conceptPages: emptyLinks,
    });

    expect(withoutSeo).toContain('<html lang="ko">');
    expect(withoutSeo).not.toContain('rel="canonical"');
    expect(withoutSeo).not.toContain('property="og:url"');
    expect(withoutSeo).toContain('<meta property="og:image" content="/static/logo.png">');
    expect(withoutSeo).toContain('<meta property="og:site_name" content="Demo Wiki">');
  });
});
