import { defineConfig } from "vite";

export default defineConfig({
  // No SPA fallback: a missing synthdef must 404, not return index.html.
  appType: "mpa",
  // SuperSonic lazy-loads its own chunks relative to its module URL;
  // keep Vite's dependency pre-bundler away from it.
  optimizeDeps: { exclude: ["supersonic-scsynth"] },
  server: { port: 5173, strictPort: true },
});
