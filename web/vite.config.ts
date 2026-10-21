import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = "http://localhost:3000";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    // the widget test reads ../server/public/widget.js
    fs: { allow: [".."] },
    proxy: {
      "/api": target,
      "/admin/api": target,
      "/public": target,
      "/files": target,
      "/avatars": target,
      "/widget.js": target,
      "/widget-demo.html": target,
      "/widget-preview": target,
      "/chat": target,
      "/socket.io": { target, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/@sentry/.test(id)) return "vendor-sentry"; // optional and lazy: downloaded only when the server configures a DSN
          if (/socket\.io|engine\.io/.test(id)) return "vendor-socket";
          if (/@tanstack\/react-query/.test(id)) return "vendor-query";
          if (/react-router/.test(id)) return "vendor-router";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
