import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildContentSecurityPolicy,
  injectContentSecurityPolicyMeta,
  inlineScriptHashes,
  inlineStyleHashes,
} from "./csp";

describe("generated-page CSP", () => {
  test("diagnoses an inline script but never authorizes it", () => {
    const script = "\n  window.answer = 42;\n";
    const expected = createHash("sha256").update(script).digest("base64");
    const html = `<script src="/static/app.js"></script><script>${script}</script>`;

    expect(inlineScriptHashes(html)).toEqual([`'sha256-${expected}'`]);
    expect(buildContentSecurityPolicy(html)).toContain("script-src 'self'");
    expect(buildContentSecurityPolicy(html)).not.toContain(expected);
  });

  test("does not treat inert JSON data as executable and keeps script-src invariant", () => {
    const html = '<script type="application/json">{"answer":42}</script><script>run()</script><script>run()</script>';
    const policy = buildContentSecurityPolicy(html);

    expect(inlineScriptHashes(html)).toHaveLength(1);
    expect(policy.split(";").find(directive => directive.trim().startsWith("script-src"))?.trim())
      .toBe("script-src 'self'");
  });

  test("hashes exact style blocks, deduplicates them, and blocks style attributes", () => {
    const style = "\n  .notice { color: red; }\n";
    const expected = createHash("sha256").update(style).digest("base64");
    const html = `<style>${style}</style><style>${style}</style><main style="color:red"></main>`;
    const policy = buildContentSecurityPolicy(html);

    expect(inlineStyleHashes(html)).toEqual([`'sha256-${expected}'`]);
    expect(policy).toContain(`style-src 'self' 'sha256-${expected}'`);
    expect(policy).toContain("style-src-attr 'none'");
    expect(policy).not.toContain("'unsafe-inline'");
  });

  test("embeds and refreshes a static-host policy without header-only directives", () => {
    const html = "<!doctype html><html><head><title>Static</title></head><body><script>run()</script></body></html>";
    const injected = injectContentSecurityPolicyMeta(html);
    const refreshed = injectContentSecurityPolicyMeta(injected.replace("run()", "updated()"));

    expect(injected).toMatch(/<head>\s*<meta http-equiv="Content-Security-Policy"/);
    expect(injected).toContain("style-src-attr 'none'");
    expect(injected).not.toContain("frame-ancestors");
    expect(injected).not.toContain("'unsafe-inline'");
    expect(refreshed.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    expect(refreshed).not.toContain(inlineScriptHashes("<script>updated()</script>")[0]!);
    expect(refreshed).toContain("script-src 'self'");
  });
});
