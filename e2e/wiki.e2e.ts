import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("homepage supports keyboard navigation without runtime errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("#main-content")).toBeVisible();
  await expect(page.locator('script[src^="http"], link[href^="http"]')).toHaveCount(0);

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page.keyboard.press("/");
  const search = page.locator("#search-input");
  await expect(search).toBeFocused();
  await search.fill("양자");
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowDown");
  await expect(search).toHaveAttribute("aria-activedescendant", /.+/);
  await page.keyboard.press("Escape");
  await expect(search).toHaveAttribute("aria-expanded", "false");

  expect(pageErrors).toEqual([]);
});

test("mobile navigation opens and closes with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const menu = page.locator(".topbar-menu-btn");
  const sidebar = page.locator("#wiki-sidebar");
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  expect(await sidebar.evaluate(element => (element as HTMLElement).inert)).toBe(true);
  const collapsedTab = sidebar.locator('.sidebar-tab[aria-selected="true"]');
  await collapsedTab.evaluate(element => (element as HTMLElement).focus());
  await expect(collapsedTab).not.toBeFocused();

  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar).toHaveClass(/open/);
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");
  expect(await sidebar.evaluate(element => (element as HTMLElement).inert)).toBe(false);
  await expect(collapsedTab).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  expect(await sidebar.evaluate(element => (element as HTMLElement).inert)).toBe(true);
});

test("internal-link preview works without authentication or a live API", async ({ page }) => {
  for (const origin of ["http://127.0.0.1:8787", "http://127.0.0.1:8788"]) {
    const apiPageRequests: string[] = [];
    const recordRequest = (request: { url(): string }) => {
      if (request.url().includes("/api/page/")) apiPageRequests.push(request.url());
    };
    page.on("request", recordRequest);
    await page.goto(`${origin}/`);

    const firstWikiLink = page.locator('.page-list a[href*="/wiki/"]').first();
    await expect(firstWikiLink).toBeVisible();
    await firstWikiLink.click();
    await expect(page.locator(".peek-panel")).toHaveClass(/is-open/);
    await expect(page.locator(".peek-content .page-body")).not.toBeEmpty();
    await expect(page.locator(".peek-error")).toHaveCount(0);
    expect(apiPageRequests, `${origin} must not require the live page API`).toEqual([]);

    await page.keyboard.press("Escape");
    page.off("request", recordRequest);
  }
});

test("GitHub Pages project subpath keeps assets, search, and previews functional", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const response = await page.goto("http://127.0.0.1:8789/kiwimu/");
  expect(response?.status()).toBe(200);

  const staticPolicy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(staticPolicy).toContain("script-src 'self'");
  expect(staticPolicy).toContain("style-src-attr 'none'");
  expect(staticPolicy).not.toContain("'unsafe-inline'");

  await expect(page.locator('link[href="/kiwimu/static/style.css"]')).toHaveCount(1);
  expect((await page.request.get("http://127.0.0.1:8789/kiwimu/static/search.js")).status()).toBe(200);
  expect((await page.request.get("http://127.0.0.1:8789/kiwimu/search-index.json")).status()).toBe(200);

  const search = page.locator("#search-input");
  await search.fill("양자");
  await expect(page.locator('#search-results a[href^="/kiwimu/wiki/"]').first()).toBeVisible();
  await search.press("Escape");

  await page.locator('.page-list a[href^="/kiwimu/wiki/"]').first().click();
  await expect(page.locator(".peek-panel")).toHaveClass(/is-open/);
  await expect(page.locator(".peek-content .page-body")).not.toBeEmpty();
  await expect(page.locator(".peek-error")).toHaveCount(0);

  await page.goto("http://127.0.0.1:8789/kiwimu/wiki/mermaid-e2e.html");
  await expect(page.locator(".mermaid img.mermaid-image")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("GitHub Pages project sites isolate versioned learning state by base path", async ({ page }) => {
  await page.route("http://127.0.0.1:8789/other/quiz.html", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: '<!doctype html><html><body><div id="quiz-empty" hidden></div>' +
      '<script type="application/json" id="kiwi-quiz-data">[]</script>' +
      '<script src="/other/static/quiz.js"></script></body></html>',
  }));
  await page.route("http://127.0.0.1:8789/other/static/quiz.js", async route => {
    const response = await route.fetch({ url: "http://127.0.0.1:8789/kiwimu/static/quiz.js" });
    await route.fulfill({ response });
  });

  await page.goto("http://127.0.0.1:8789/kiwimu/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kiwimu-quiz-catalog", JSON.stringify([{ id: "legacy-other-site" }]));
  });

  await page.goto("http://127.0.0.1:8789/other/quiz.html");
  expect(await page.evaluate(() => localStorage.getItem("kiwimu-learning:v1:%2Fother:catalog"))).toBe("[]");
  expect(await page.evaluate(() => localStorage.getItem("kiwimu-quiz-catalog"))).toContain("legacy-other-site");

  await page.goto("http://127.0.0.1:8789/kiwimu/quiz.html");
  const scopes = await page.evaluate(() => ({
    other: JSON.parse(localStorage.getItem("kiwimu-learning:v1:%2Fother:catalog") || "null"),
    kiwimu: JSON.parse(localStorage.getItem("kiwimu-learning:v1:%2Fkiwimu:catalog") || "null"),
  }));
  expect(scopes.other).toEqual([]);
  expect(Array.isArray(scopes.kiwimu)).toBe(true);
  const projectCatalog = scopes.kiwimu as Array<{ id: string | number }>;
  expect(projectCatalog.length).toBeGreaterThan(0);

  await page.evaluate((catalog) => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const schedule = Object.fromEntries(catalog.map(quiz => [quiz.id, {
      ef: 2.5,
      interval: 21,
      nextReview: future,
    }]));
    localStorage.setItem("kiwimu-learning:v1:%2Fkiwimu:schedule", JSON.stringify(schedule));
    localStorage.setItem("kiwimu-learning:v1:%2Fkiwimu:attempts", "[]");
  }, projectCatalog);

  await page.goto("http://127.0.0.1:8789/kiwimu/dashboard.html");
  await expect(page.locator("#dash-total")).toHaveText(String(projectCatalog.length));
  await expect(page.locator("#dash-mastered")).toHaveText(String(projectCatalog.length));
});

test("quiz keeps the hidden face out of the focus order", async ({ page }) => {
  await page.goto("/quiz.html");
  const input = page.locator("#quiz-answer-input");
  if (await input.isVisible()) {
    await input.fill("테스트 답변");
    await page.locator("#quiz-submit-btn").click();
  } else {
    await page.getByRole("button", { name: "O, 맞음" }).click();
  }

  const front = page.locator("#quiz-card-front");
  const back = page.locator("#quiz-card-back");
  await expect(front).toHaveAttribute("aria-hidden", "true");
  await expect(back).toHaveAttribute("aria-hidden", "false");
  expect(await front.evaluate(element => (element as HTMLElement).inert)).toBe(true);
  expect(await back.evaluate(element => (element as HTMLElement).inert)).toBe(false);
  await expect(page.locator("#quiz-next-btn")).toBeFocused();
});

test("quiz prioritizes due reviews and shares browser learning state with dashboard", async ({ page }) => {
  await page.goto("/quiz.html");
  const catalog = await page.evaluate(() => JSON.parse(localStorage.getItem("kiwimu-learning:v1:%2F:catalog") || "[]"));
  expect(catalog.length).toBeGreaterThan(1);
  const dueQuiz = catalog[0];
  await page.evaluate(({ quizzes, dueId }) => {
    localStorage.clear();
    const now = Date.now();
    const schedule = Object.fromEntries(quizzes.map((quiz: { id: number }) => [quiz.id, {
      ef: 2.5,
      interval: 1,
      nextReview: new Date(quiz.id === dueId ? now - 60_000 : now + 86_400_000).toISOString(),
    }]));
    localStorage.setItem("kiwimu-srs", JSON.stringify(schedule));
    localStorage.setItem("kiwimu-quiz-attempts", "[]");
  }, { quizzes: catalog, dueId: dueQuiz.id });
  await page.reload();

  expect(await page.evaluate(() => localStorage.getItem("kiwimu-learning:v1:%2F:schedule"))).toBeTruthy();
  await expect(page.locator("#quiz-question")).toHaveText(dueQuiz.question);
  const answerInput = page.locator("#quiz-answer-input");
  if (await answerInput.isVisible()) {
    await answerInput.fill("__kiwimu_intentionally_incorrect__");
    await page.locator("#quiz-submit-btn").click();
  } else {
    await page.locator(".ox-btn").first().click();
  }
  await expect(page.locator("#quiz-next-btn")).toBeFocused();

  await page.goto("/dashboard.html");
  await expect(page.locator("#dash-total")).toHaveText(String(catalog.length));
  await expect(page.locator("#dash-learning")).toHaveText(String(catalog.length));
  await expect(page.locator("#dash-new")).toHaveText("0");
  await expect(page.locator("#dash-recent-list")).toContainText(dueQuiz.question);
});

test("activity filters ignore stale out-of-order responses", async ({ page }) => {
  await page.route("**/activity?token=**", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      '<button type="button" class="filter-btn active" data-action="" aria-pressed="true">전체 (0)</button>',
      '<button type="button" class="filter-btn active" data-action="" aria-pressed="true">전체 (0)</button>' +
      '<button type="button" class="filter-btn" data-action="first" aria-pressed="false">첫째</button>' +
      '<button type="button" class="filter-btn" data-action="second" aria-pressed="false">둘째</button>',
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/activity?token=kiwimu-e2e-auth-token");
  await expect(page.locator("#timeline")).toHaveAttribute("aria-busy", "false");
  const filters = page.locator('.filter-btn[data-action]:not([data-action=""])');
  expect(await filters.count()).toBeGreaterThan(1);
  const first = filters.nth(0);
  const second = filters.nth(1);
  const firstAction = await first.getAttribute("data-action");
  const secondAction = await second.getAttribute("data-action");
  expect(firstAction).toBeTruthy();
  expect(secondAction).toBeTruthy();

  await page.route("**/api/activity?**", async route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    const response = {
      entries: [{
        action,
        title: action === firstAction ? "stale-first-response" : "fresh-second-response",
        details: "",
        created_at: new Date().toISOString(),
      }],
      total: 1,
    };
    if (action === firstAction) await new Promise(resolve => setTimeout(resolve, 250));
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
    } catch {
      // The first request is intentionally aborted when the second filter wins.
    }
  });

  await first.click();
  await second.click();
  await expect(page.locator("#timeline")).toContainText("fresh-second-response");
  await page.waitForTimeout(350);
  await expect(page.locator("#timeline")).not.toContainText("stale-first-response");
  await expect(second).toHaveAttribute("aria-pressed", "true");
});

test("activity load failure keeps an in-page retry path", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/activity?**", async route => {
    calls++;
    if (calls === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [], total: 0 }) });
  });
  await page.goto("/activity?token=kiwimu-e2e-auth-token");
  const retry = page.locator("#load-more");
  await expect(page.locator("#activity-status")).toContainText("다시 시도");
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.locator("#empty")).toBeVisible();
  expect(calls).toBe(2);
});

test("selection Q&A ignores stale related results and restores focus on Escape", async ({ page }) => {
  await page.goto("/?token=kiwimu-e2e-auth-token");
  const href = await page.locator('.page-list a[href^="/wiki/"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);

  let calls = 0;
  await page.route("**/api/search?**", async route => {
    const call = ++calls;
    if (call === 1) await new Promise(resolve => setTimeout(resolve, 1_500));
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ results: [{ title: call === 1 ? "STALE-A" : "FRESH-B", slug: `result-${call}`, preview: "결과" }] }),
      });
    } catch {
      // The stale request is intentionally aborted by the newer selection.
    }
  });

  const selectTextNode = async (index: number) => page.evaluate((nodeIndex) => {
    const root = document.querySelector(".page-body");
    const walker = document.createTreeWalker(root!, NodeFilter.SHOW_TEXT);
    const nodes: Node[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if ((node.textContent || "").trim().length >= 6) nodes.push(node);
    }
    const target = nodes[Math.min(nodeIndex, nodes.length - 1)];
    const range = document.createRange();
    range.setStart(target, 0);
    range.setEnd(target, Math.min(6, target.textContent?.length || 0));
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, index);

  await selectTextNode(0);
  await page.waitForTimeout(900);
  await selectTextNode(1);
  await page.waitForTimeout(1_700);
  await expect(page.locator(".qa-related-title")).toHaveText("FRESH-B");
  await page.keyboard.press("Escape");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("authenticated editing uses the HttpOnly cookie without exposing a token", async ({ page }) => {
  await page.goto("/?token=kiwimu-e2e-auth-token");
  await expect(page.locator('meta[name="kiwi-live"]')).toHaveCount(1);
  await expect(page.locator('meta[name="kiwi-auth"]')).toHaveCount(0);
  expect((await page.content()).includes("kiwimu-e2e-auth-token")).toBe(false);

  const href = await page.locator('.page-list a[href^="/wiki/"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);
  const edit = page.locator(".edit-btn");
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(page.locator("#edit-modal")).toBeVisible();
  const textarea = page.locator("#edit-textarea");
  await expect(textarea).toBeEnabled();
  const original = await textarea.inputValue();
  await textarea.fill(`${original}\n\n외부 coordinator fencing E2E`);
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole("button", { name: "저장", exact: true }).click(),
  ]);
  await expect(page.locator(".page-body")).toContainText("외부 coordinator fencing E2E");
});

test("every HTML surface permits only self-hosted parent-page scripts", async ({ request }) => {
  for (const path of ["/", "/quiz.html", "/graph.html", "/manage", "/activity", "/provenance"]) {
    const response = await request.get(path, {
      headers: { Authorization: "Bearer kiwimu-e2e-auth-token" },
    });
    expect(response.status(), `${path} should load`).toBe(200);
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");

    const csp = response.headers()["content-security-policy"] || "";
    const scriptDirective = csp.split(";").map(value => value.trim())
      .find(value => value.startsWith("script-src")) || "";
    const styleDirective = csp.split(";").map(value => value.trim())
      .find(value => value.startsWith("style-src ")) || "";
    const styleAttrDirective = csp.split(";").map(value => value.trim())
      .find(value => value.startsWith("style-src-attr")) || "";
    expect(scriptDirective, `${path} needs script-src`).toBe("script-src 'self'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toMatch(/https?:|cdn\.jsdelivr|d3js|cloudflare/i);
    expect(styleDirective, `${path} needs style-src`).toContain("style-src 'self'");
    expect(styleDirective).not.toContain("'unsafe-inline'");
    expect(styleAttrDirective).toBe("style-src-attr 'none'");
  }
});

test("strict style CSP does not break generated interactive or vendor-rendered surfaces", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", message => {
    if (/content security policy|refused to (?:apply|set|execute).*style/i.test(message.text())) {
      violations.push(message.text());
    }
  });

  for (const path of ["/", "/quiz.html", "/graph.html", "/catalog.html", "/provenance"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  await page.goto("/manage?token=kiwimu-e2e-auth-token");
  await page.waitForLoadState("networkidle");
  await page.goto("/activity");
  await page.waitForLoadState("networkidle");

  await page.goto("/");
  const firstWikiLink = page.locator('.page-list a[href*="/wiki/"]').first();
  const href = await firstWikiLink.getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".page-body")).toBeVisible();

  await page.goto("/wiki/math-e2e.html");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".page-body .kiwi-math math")).toHaveCount(2);
  await expect(page.locator(".page-body .kiwi-math-display math")).toHaveAttribute("display", "block");
  await expect(page.locator('.page-body .kiwi-math annotation[encoding="application/x-tex"]').first()).toContainText("E = mc^2");
  await expect(page.locator(".page-body .kiwi-math [style]")).toHaveCount(0);
  await expect(page.locator(".page-body .katex-html")).toHaveCount(0);

  await page.goto("/graph.html");
  await expect(page.locator("#graph-container")).toHaveAttribute("aria-busy", "false");
  const graphNode = page.locator(".graph-node").first();
  await expect(graphNode).toBeVisible();
  await page.getByRole("button", { name: "그래프 확대" }).click();
  await expect.poll(() => page.locator("#graph-container svg > g").getAttribute("transform"))
    .toContain("scale(1.25)");
  const nodeBox = await graphNode.boundingBox();
  expect(nodeBox).toBeTruthy();
  await page.mouse.move(nodeBox!.x + nodeBox!.width / 2, nodeBox!.y + nodeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBox!.x + nodeBox!.width / 2 + 28, nodeBox!.y + nodeBox!.height / 2 + 18, { steps: 4 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/graph\.html$/);
  await expect(page.locator("#graph-container [style]")).toHaveCount(0);

  await page.goto("/wiki/mermaid-e2e.html");
  await page.waitForLoadState("networkidle");
  const mermaidImage = page.locator(".mermaid img.mermaid-image");
  await expect(mermaidImage).toBeVisible();
  await expect(mermaidImage).toHaveAttribute("src", /^blob:/);
  await expect(page.locator('iframe[src$="/static/mermaid-frame.htm"]')).toHaveAttribute("sandbox", "allow-scripts");

  expect(violations).toEqual([]);
});

test("public and authenticated surfaces have no serious accessibility violations", async ({ page }) => {
  await page.goto("/?token=kiwimu-e2e-auth-token");
  const articleHref = await page.locator('.page-list a[href^="/wiki/"]').first().getAttribute("href");
  expect(articleHref).toBeTruthy();
  const paths = ["/", "/quiz.html", "/graph.html", "/catalog.html", "/dashboard.html", "/provenance", "/activity", "/manage", articleHref!];

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const path of paths) {
      await page.goto(path);
      const result = await new AxeBuilder({ page }).analyze();
      const serious = result.violations.filter(violation =>
        violation.impact === "serious" || violation.impact === "critical"
      );
      expect(
        serious.map(violation => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map(node => node.target),
        })),
        `${path} in ${colorScheme} mode has serious accessibility violations`,
      ).toEqual([]);
    }
  }
});
