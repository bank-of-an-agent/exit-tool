import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "dist/**", "coverage/**", "web/index.html", "src/core/abis/generated/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      // All CLI output goes through src/cli/io.ts so that --json mode stays machine-readable.
      "no-console": "error",
    },
  },
  {
    // The core runs in Node and in the browser (web/index.html): no Node built-ins, no floats for money.
    files: ["src/core/**/*.ts", "web/src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*"], message: "src/core and web/src must stay browser-compatible." }] },
      ],
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money is integer minor units. No floats." },
        { name: "process", message: "src/core and web/src must stay browser-compatible." },
        { name: "Buffer", message: "src/core and web/src must stay browser-compatible." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "Money is integer minor units. No floats." },
        { property: "toFixed", message: "Money is integer minor units. Use formatAmount()." },
      ],
    },
  },
  {
    files: ["test/**", "scripts/**"],
    rules: { "no-console": "off" },
  },
  prettier,
);
