import { defineConfig } from "vitest/config";

/**
 * Tests run in Node, not the browser, so they import the real
 * `@alpaca-software/40kdc-data` package directly — no `stubNodeOnlyModules`
 * plugin (the schema-loader's `node:fs`/`node:url` access is fine in Node).
 * Kept separate from `vite.config.ts` for exactly that reason.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
