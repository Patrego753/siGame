import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.resolve(root),
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyDirBeforeWrite: true,
  },
  server: {
    port: 5173,
    /** Только `npm run dev`: один origin — /api и Socket.IO проксируются на 5174. */
    proxy: {
      "/api": { target: "http://127.0.0.1:5174", changeOrigin: true },
      "/socket.io": {
        target: "http://127.0.0.1:5174",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(root, "../shared"),
    },
  },
});
