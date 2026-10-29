import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");

  return {
    plugins: [react()],
    envDir: "../..",
    server: {
      host: "0.0.0.0",
      port: Number(env.DASHBOARD_PORT ?? process.env.DASHBOARD_PORT ?? 5173),
      strictPort: true,
    },
  };
});