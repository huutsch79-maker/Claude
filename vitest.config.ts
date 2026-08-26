import { defineConfig, configDefaults } from "vitest/config";

// dashboard/ is a separate frontend project with its own toolchain, own
// package.json, own vitest config (jsdom environment, preact plugin) and
// its own `npm run test` / root `test:dashboard` script — without this
// exclude, a plain `vitest run` from the repo root also picks up
// dashboard/test/**, but runs it under this project's plain Node
// environment (no jsdom, no `document`), so every dashboard test fails
// with "document is not defined" instead of actually running.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dashboard/**"],
  },
});
