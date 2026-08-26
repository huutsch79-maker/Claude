import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Build output goes to ../public — the orchestrator serves that directory
// verbatim (express.static), unchanged from before this dashboard existed
// as a real frontend project. That's the only thing that has to line up;
// everything else here is a normal Vite/Preact setup.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:4570",
    },
  },
});
