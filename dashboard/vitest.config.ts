import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

// Kept separate from vite.config.ts (the build/dev config) rather than
// merged into it — this only ever runs under `vitest`, never `vite build`
// or `vite dev`, so there's no shared server/build config worth reusing
// beyond the preact plugin itself (needed so JSX in .tsx test files and
// components compiles the same way it does for the real build).
export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
