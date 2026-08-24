import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "katex";

const staticDir = join(import.meta.dir, "static");

describe("strict-CSP vendor adapters", () => {
  test("keeps generated-page behavior in external, standalone scripts", () => {
    for (const asset of [
      "navigation.js",
      "quiz.js",
      "dashboard.js",
      "admin.js",
      "catalog.js",
      "activity.js",
      "random-redirect.js",
    ]) {
      const source = readFileSync(join(staticDir, asset), "utf8");
      expect(source).not.toContain("${");
      expect(() => new Function(source)).not.toThrow();
    }
  });

  test("renders accessible MathML without runtime style attributes", () => {
    const runtime = readFileSync(join(staticDir, "vendor-runtime.js"), "utf8");
    const markup = renderToString(String.raw`\frac{a}{b} + \sqrt{x}`, {
      output: "mathml",
      displayMode: true,
      throwOnError: true,
      trust: false,
    });

    expect(markup).toContain("<math");
    expect(markup).toContain("<semantics>");
    expect(markup).toContain('annotation encoding="application/x-tex"');
    expect(markup).not.toMatch(/\sstyle\s*=/i);
    expect(markup).not.toContain("katex-html");

    expect(runtime).toContain("output: 'mathml'");
    expect(runtime).toContain("throwOnError: true");
    expect(runtime).toContain("trust: false");
    expect(runtime).toContain("element.classList.remove('katex')");
    expect(runtime).toContain("querySelector('script, style, iframe, object, embed, [style]')");
    expect(runtime).not.toContain("renderMathInElement");
  });

  test("leaves ordinary currency text outside the math renderer", () => {
    const runtime = readFileSync(join(staticDir, "vendor-runtime.js"), "utf8");
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousWindow = globals.window;
    const previousDocument = globals.document;
    const previousNodeFilter = globals.NodeFilter;
    const calls: string[] = [];
    let replaced = false;
    const textNode = {
      nodeValue: "Price $5 and $10 today",
      parentElement: { closest: () => null },
      replaceWith: () => { replaced = true; },
    };
    let visited = false;
    const fakeDocument = {
      readyState: "loading",
      body: {},
      addEventListener: () => {},
      createTreeWalker: () => ({
        currentNode: null as typeof textNode | null,
        nextNode() {
          if (visited) return false;
          visited = true;
          this.currentNode = textNode;
          return true;
        },
      }),
    };
    const fakeWindow: Record<string, unknown> = {
      katex: { renderToString: (source: string) => { calls.push(source); return ""; } },
    };

    try {
      globals.window = fakeWindow;
      globals.document = fakeDocument;
      globals.NodeFilter = { SHOW_TEXT: 4 };
      new Function(runtime)();
      (fakeWindow.kiwiRenderMath as (root: { nodeType: number }) => void)({ nodeType: 1 });
      expect(calls).toEqual([]);
      expect(replaced).toBeFalse();
    } finally {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
      if (previousDocument === undefined) delete globals.document;
      else globals.document = previousDocument;
      if (previousNodeFilter === undefined) delete globals.NodeFilter;
      else globals.NodeFilter = previousNodeFilter;
    }
  });

  test("keeps D3 behavior defaults in external CSS and uses pointer dragging", () => {
    const graph = readFileSync(join(staticDir, "graph.js"), "utf8");
    const css = readFileSync(join(staticDir, "style.css"), "utf8");

    expect(graph).toContain("callBehaviorWithoutInlineStyles(svg, zoom)");
    expect(graph).toContain('name === "touch-action"');
    expect(graph).toContain('name === "-webkit-tap-highlight-color"');
    expect(graph).toContain("Unexpected D3 inline style request");
    expect(graph).toContain('node.on("pointerdown.drag"');
    expect(graph).toContain('node.on("pointermove.drag"');
    expect(graph).not.toContain("d3.drag(");
    expect(graph).not.toMatch(/\.style\s*\(/);
    expect(css).toMatch(/\.graph-node\s*\{[^}]*touch-action:\s*none;/s);
    expect(css).toMatch(/#graph-container svg\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent;/s);
  });
});

describe("isolated Mermaid renderer", () => {
  test("keeps Mermaid's inline-style exception inside an opaque sandbox", () => {
    const runtime = readFileSync(join(staticDir, "vendor-runtime.js"), "utf8");
    const frame = readFileSync(join(staticDir, "mermaid-frame.htm"), "utf8");

    expect(runtime).toContain("frame.setAttribute('sandbox', 'allow-scripts')");
    expect(runtime).not.toContain("allow-same-origin");
    expect(runtime).toContain("new Blob([svg], { type: 'image/svg+xml' })");
    expect(runtime).not.toContain("style-src 'unsafe-inline'");

    expect(frame).toContain("style-src 'unsafe-inline'");
    expect(frame).toContain("connect-src 'none'");
    expect(frame).toContain("script-src 'nonce-");
    expect(frame.match(/<script nonce=/g)).toHaveLength(2);
    expect(frame).not.toMatch(/script-src[^;]*(?:http:|https:|'unsafe-inline')/);
    const policyNonce = frame.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(policyNonce).toBeTruthy();
    expect(frame.split(`nonce="${policyNonce}"`).length - 1).toBe(2);
    expect(frame).not.toMatch(/<script[^>]+src="\//);
  });

  test("validates executable SVG patterns on both sides of the message boundary", () => {
    const runtime = readFileSync(join(staticDir, "vendor-runtime.js"), "utf8");
    const frameRuntime = readFileSync(join(staticDir, "mermaid-frame.js"), "utf8");

    for (const source of [runtime, frameRuntime]) {
      expect(source).toContain("script|iframe|object|embed");
      expect(source).toContain("javascript:");
      expect(source).toContain("on[a-z]");
    }
  });

  test("isolates a malformed diagram from later Mermaid nodes", () => {
    const runtime = readFileSync(join(staticDir, "vendor-runtime.js"), "utf8");
    expect(runtime).toContain("for (const node of nodes) {\n          try {");
    expect(runtime).toContain("Keep the source-text fallback and continue rendering later diagrams.");
  });
});
