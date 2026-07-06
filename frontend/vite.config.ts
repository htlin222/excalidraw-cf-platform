import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production app is served as static assets by the Worker (single origin), so no
// proxy is needed there. For a fast HMR loop you can run `vite` and `wrangler dev` side
// by side; this proxy forwards /api and /ws to the local Worker (default port 8787).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
