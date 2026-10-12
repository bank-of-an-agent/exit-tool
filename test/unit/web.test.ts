import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

function inline(tag: "script" | "style"): string[] {
  return [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!);
}

const sha = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

describe("web/index.html", () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";

  it("has a strict CSP whose hashes match the inline script and style exactly", () => {
    const scripts = inline("script");
    const styles = inline("style");
    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(csp).toContain(`script-src ${sha(scripts[0]!)}`);
    expect(csp).toContain(`style-src ${sha(styles[0]!)}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("loads nothing from the network and has no inline event handlers", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(inline("script")[0]).not.toMatch(/https?:\/\/[a-z0-9.-]+\.(?:com|org|io|net)\/[^"'\s]*\.js/i);
  });
});
