import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Standalone harness to prove the landing subtree builds & mounts on its own,
// independent of the application spine. It builds the landing-preview/index.html
// entry into a directory OUTSIDE the repo (/workspaces/cf-run/out/landing-preview)
// so the repo .gitignore never sees the output. Run:
//   npx vite build --config vite.landing.config.ts
export default defineConfig({
  root: path.resolve(__dirname, "landing-preview"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    outDir: "/workspaces/cf-run/out/landing-preview",
    emptyOutDir: true,
    sourcemap: false,
  },
});
