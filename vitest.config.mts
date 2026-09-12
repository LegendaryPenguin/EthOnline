import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `cre/` holds the confidential workflow. Its tests import `bun:test` and run
    // under the bun runtime the CRE toolchain ships — vitest cannot execute them.
    // They run via `npm run cre:test`.
    exclude: ["**/node_modules/**", "**/dist/**", ".next/**", "cre/**"],
  },
});
