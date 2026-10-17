import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Local API for the dev proxy; override to reach another backend, e.g. the Docker app on 4318.
const apiTarget = process.env.INVESTIA_API_TARGET ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/investigations": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "**/e2e/**"],
    setupFiles: ["./test/setup.ts"],
    clearMocks: true,
  },
});
