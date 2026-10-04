import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/lunar-typescript/")) return "lunar";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
