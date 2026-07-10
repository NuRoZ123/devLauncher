import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Config Vite adaptée à Tauri : port fixe 1420, on ignore le dossier src-tauri.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
