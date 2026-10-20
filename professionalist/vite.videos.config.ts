import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const STUB = process.env.VIDEOS_STUB_URL || "http://127.0.0.1:8811";

/**
 * Dev-only config that builds/serveS the videos subtree by itself:
 *
 *   node src/videos-playground/stub-server.mjs        # backend stub on 127.0.0.1:8811
 *   npx vite --config vite.videos.config.ts           # http://localhost:5174
 *   npx vite build --config vite.videos.config.ts     # -> dist-videos/ (gitignored)
 *
 * root is src/videos-playground, so nothing outside the video subtree is reachable; the
 * production vite.config.ts (root = repo, entry /src/main.tsx) is untouched.
 */
export default defineConfig({
  root: path.resolve(process.cwd(), "src/videos-playground"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
  server: {
    port: 5174,
    host: true,
    proxy: {
      "/api": { target: STUB, changeOrigin: true },
      "/media": { target: STUB, changeOrigin: true },
    },
  },
  preview: {
    port: 5175,
    proxy: {
      "/api": { target: STUB, changeOrigin: true },
      "/media": { target: STUB, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(process.cwd(), "dist-videos"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
