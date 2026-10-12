// Builds web/index.html: one static file, script and style inline, pinned by hashes in its
// Content-Security-Policy. `--check` fails if the committed file is out of date.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const result = await build({
  entryPoints: [path.join(root, "web/src/main.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "warning",
});
// Never let bundled code close the inline <script> early.
const js = result.outputFiles[0].text.trim().replaceAll("</script", "<\\/script");
const css = readFileSync(path.join(root, "web/src/style.css"), "utf8").trim();
const sha = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const template = readFileSync(path.join(root, "web/index.template.html"), "utf8");
const assembled = template.replace("/*__STYLE__*/", () => css).replace("/*__SCRIPT__*/", () => js);

// Hash exactly what the browser hashes: the full text inside the (single) inline <script> and <style>,
// including the template's indentation around the placeholders.
const inline = (tag) => {
  const matches = [...assembled.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))];
  if (matches.length !== 1) throw new Error(`expected exactly one inline <${tag}> in the template`);
  return matches[0][1];
};

const csp = [
  "default-src 'none'",
  `script-src ${sha(inline("script"))}`,
  `style-src ${sha(inline("style"))}`,
  "img-src data:",
  // All chain access goes through the injected wallet: the page itself never connects anywhere.
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const html = assembled.replace("__CSP__", () => csp);

const out = path.join(root, "web/index.html");
if (check) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {
    // missing
  }
  if (current !== html) {
    console.error("web/index.html is out of date: run `pnpm build:web` and commit the result.");
    process.exit(1);
  }
  console.log("web/index.html is up to date.");
} else {
  writeFileSync(out, html);
  console.log(
    `wrote web/index.html (${(html.length / 1024).toFixed(0)} KiB, script ${(js.length / 1024).toFixed(0)} KiB)`,
  );
}
