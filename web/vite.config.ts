import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/public": target,
      "/files": target,
      "/widget.js": target,
      "/widget-demo.html": target,
      "/socket.io": { target, ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
