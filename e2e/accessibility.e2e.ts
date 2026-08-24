import { expect, test, type Page } from "@playwright/test";

interface AxValue {
  value?: unknown;
}

interface AxNode {
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
}

async function fullAccessibilityTree(page: Page): Promise<AxNode[]> {
  const session = await page.context().newCDPSession(page);
  await session.send("Accessibility.enable");
  const result = await session.send("Accessibility.getFullAXTree");
  await session.detach();
  return result.nodes as AxNode[];
}

function namesForRole(nodes: AxNode[], role: string): string[] {
  return nodes
    .filter(node => !node.ignored && node.role?.value === role)
    .map(node => String(node.name?.value ?? ""));
}

test("assistive-technology tree exposes named navigation and core controls", async ({ page }) => {
  await page.goto("/");
  const nodes = await fullAccessibilityTree(page);

  expect(namesForRole(nodes, "main")).toHaveLength(1);
  expect(namesForRole(nodes, "navigation")).toEqual(expect.arrayContaining(["주요 메뉴"]));
  expect(namesForRole(nodes, "complementary")).toEqual(expect.arrayContaining(["문서 탐색"]));
  expect(namesForRole(nodes, "combobox")).toEqual(expect.arrayContaining(["위키 문서 검색"]));
  expect(namesForRole(nodes, "heading").some(name => name.trim().length > 0)).toBe(true);

  await page.goto("/quiz.html");
  const quizNodes = await fullAccessibilityTree(page);
  expect(namesForRole(quizNodes, "progressbar")).toEqual(expect.arrayContaining(["퀴즈 진행률"]));
  const quizTextboxes = namesForRole(quizNodes, "textbox");
  const quizButtons = namesForRole(quizNodes, "button");
  expect(
    quizTextboxes.includes("정답") ||
      (quizButtons.includes("O, 맞음") && quizButtons.includes("X, 틀림")),
  ).toBe(true);

  await page.goto("/graph.html");
  const graphNodes = await fullAccessibilityTree(page);
  expect(namesForRole(graphNodes, "region")).toEqual(expect.arrayContaining(["문서 연결 그래프"]));
  expect(namesForRole(graphNodes, "button")).toEqual(expect.arrayContaining(["그래프 확대", "그래프 축소"]));
});

test("reduced motion keeps quiz state change immediate and keyboard-visible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/quiz.html");

  const answerInput = page.getByRole("textbox", { name: "정답" });
  if (await answerInput.isVisible()) {
    await answerInput.fill("테스트 답변");
    await page.getByRole("button", { name: "확인", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "O, 맞음" }).click();
  }

  await expect(page.locator("#quiz-card-front")).toBeHidden();
  await expect(page.locator("#quiz-card-back")).toBeVisible();
  await expect(page.getByRole("button", { name: /다음/ })).toBeFocused();

  const timing = await page.locator(".quiz-card-inner").evaluate(element => {
    const style = getComputedStyle(element);
    return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration };
  });
  const seconds = (duration: string) => duration.endsWith("ms")
    ? Number.parseFloat(duration) / 1000
    : Number.parseFloat(duration);
  expect(seconds(timing.animationDuration)).toBeLessThanOrEqual(0.000_01);
  expect(seconds(timing.transitionDuration)).toBeLessThanOrEqual(0.000_01);
});

test("reduced motion paints a settled graph without animated force ticks", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/graph.html");
  await expect(page.locator("#graph-container")).toHaveAttribute("aria-busy", "false");
  const nodes = page.locator(".graph-node");
  await expect(nodes.first()).toBeVisible();
  const before = await nodes.evaluateAll(elements => elements.map(element => element.getAttribute("transform")));
  await page.waitForTimeout(250);
  const after = await nodes.evaluateAll(elements => elements.map(element => element.getAttribute("transform")));
  expect(after).toEqual(before);
});

test("graph uses spatial roving keyboard navigation without losing focus on repaint", async ({ page }) => {
  await page.goto("/graph.html");
  await expect(page.locator("#graph-container")).toHaveAttribute("aria-busy", "false");
  const nodes = page.locator(".graph-node");
  const count = await nodes.count();
  expect(count).toBeGreaterThan(1);
  await expect(page.locator("#graph-keyboard-help")).toContainText("방향키로 문서를 탐색");
  await expect(page.locator("#graph-container svg")).toHaveAttribute("aria-describedby", "graph-keyboard-help");
  await expect(page.locator('.graph-node[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('.graph-node[tabindex="-1"]')).toHaveCount(count - 1);

  const first = nodes.first();
  await first.focus();
  await page.keyboard.press("End");
  await expect(nodes.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();

  const expectedMove = await nodes.evaluateAll(elements => {
    const entries = elements.map((element, index) => {
      const item = (element as SVGElement & { __data__: { id: unknown; x: number; y: number } }).__data__;
      return { id: String(item.id), index, x: Number(item.x), y: Number(item.y) };
    });
    const current = entries[0];
    const directions = [
      { key: "ArrowRight", horizontal: true, direction: 1 },
      { key: "ArrowLeft", horizontal: true, direction: -1 },
      { key: "ArrowDown", horizontal: false, direction: 1 },
      { key: "ArrowUp", horizontal: false, direction: -1 },
    ];
    for (const direction of directions) {
      const candidates = entries.slice(1).map(entry => {
        const dx = entry.x - current.x;
        const dy = entry.y - current.y;
        const primary = direction.horizontal ? dx : dy;
        const secondary = direction.horizontal ? dy : dx;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || primary * direction.direction <= 0) return null;
        return { ...entry, score: Math.hypot(dx, dy) + Math.abs(secondary) * 0.35 };
      }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((a, b) => a.score - b.score || a.index - b.index);
      if (candidates.length) return { key: direction.key, id: candidates[0].id };
    }
    return null;
  });
  expect(expectedMove).toBeTruthy();
  await page.keyboard.press(expectedMove!.key);
  const focusedId = await page.evaluate(() => {
    const item = (document.activeElement as SVGElement & { __data__?: { id?: unknown } })?.__data__;
    return String(item?.id ?? "");
  });
  expect(focusedId).toBe(expectedMove!.id);
  await expect(page.locator('.graph-node[tabindex="0"]')).toBeFocused();

  // Force ticks repaint transforms but retain the focused DOM element and tabstop.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => String(
    (document.activeElement as SVGElement & { __data__?: { id?: unknown } })?.__data__?.id ?? "",
  ))).toBe(focusedId);
  await expect(page.locator('.graph-node[tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/wiki/${encodeURIComponent(focusedId)}\\.html$`));

  await page.goto("/graph.html");
  await expect(page.locator("#graph-container")).toHaveAttribute("aria-busy", "false");
  const spaceTarget = page.locator('.graph-node[tabindex="0"]');
  const spaceTargetId = await spaceTarget.evaluate(element => String(
    (element as SVGElement & { __data__: { id: unknown } }).__data__.id,
  ));
  await spaceTarget.focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(new RegExp(`/wiki/${encodeURIComponent(spaceTargetId)}\\.html$`));
});

test("forced-colors mode preserves a visible keyboard focus indicator", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");

  await page.keyboard.press("Tab");
  const skipLink = page.locator(".skip-link");
  await expect(skipLink).toBeFocused();
  const focusStyle = await skipLink.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      visibility: style.visibility,
    };
  });
  expect(focusStyle.visibility).toBe("visible");
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2);

  await page.goto("/graph.html");
  await expect(page.locator("#graph-container")).toHaveAttribute("aria-busy", "false");
  const graphNode = page.locator('.graph-node[tabindex="0"]');
  await graphNode.focus();
  const graphFocus = await graphNode.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      strokeWidth: element.querySelector("circle")?.getAttribute("stroke-width"),
    };
  });
  expect(graphFocus.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(graphFocus.outlineWidth)).toBeGreaterThanOrEqual(3);
  expect(graphFocus.strokeWidth).toBe("3");
});

test("keyboard focus remains visible on search controls", async ({ page }) => {
  await page.goto("/");
  const search = page.locator("#search-input");
  await search.focus();
  await expect(search).toBeFocused();
  expect(await search.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");

  await page.goto("/catalog.html");
  const catalogSearch = page.locator("#catalog-search");
  await catalogSearch.focus();
  expect(await catalogSearch.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
});

test("400 percent equivalent viewport keeps search and edit actions reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 256 });
  await page.goto("/");
  const search = page.locator("#search-input");
  await search.fill("양자");
  await expect(page.locator('#search-results [role="option"]').first()).toBeVisible();
  await search.press("End");
  const activeId = await search.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  const activeBox = await page.locator(`#${activeId}`).boundingBox();
  expect(activeBox).toBeTruthy();
  expect(activeBox!.y + activeBox!.height).toBeLessThanOrEqual(256);

  await page.goto("/?token=kiwimu-e2e-auth-token");
  const href = await page.locator('.page-list a[href^="/wiki/"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(href!);
  await page.route("**/api/page/**", async route => {
    await new Promise(resolve => setTimeout(resolve, 350));
    await route.continue();
  });
  await page.locator(".edit-btn").click();
  await expect(page.locator(".edit-modal-close")).toBeFocused();
  await expect(page.locator("#edit-textarea")).toBeEnabled();
  const footerBox = await page.locator(".edit-modal-footer").boundingBox();
  expect(footerBox).toBeTruthy();
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(256);
});

test("narrow quiz reflows and reports an empty answer", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/quiz.html");
  const catalog = await page.evaluate(() => JSON.parse(document.querySelector("#kiwi-quiz-data")?.textContent || "[]"));
  const textQuiz = catalog.find((quiz: { quiz_type: string }) => quiz.quiz_type !== "ox");
  expect(textQuiz).toBeTruthy();
  await page.evaluate(({ quizzes, textId }) => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const due = new Date(Date.now() - 60_000).toISOString();
    localStorage.setItem("kiwimu-learning:v1:%2F:schedule", JSON.stringify(Object.fromEntries(
      quizzes.map((quiz: { id: number }) => [quiz.id, { ef: 2.5, interval: 1, nextReview: quiz.id === textId ? due : future }]),
    )));
  }, { quizzes: catalog, textId: textQuiz.id });
  await page.reload();

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const input = page.locator("#quiz-answer-input");
  await expect(input).toBeVisible();
  await page.locator("#quiz-submit-btn").click();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#quiz-input-error")).toHaveText("정답을 입력해 주세요.");
  await expect(input).toBeFocused();

  await input.fill("의도적으로 틀린 답");
  await page.locator("#quiz-submit-btn").click();
  await expect(page.locator("#quiz-live-status")).toContainText("오답입니다");
  await expect(page.locator("#quiz-next-btn")).toBeFocused();
});
