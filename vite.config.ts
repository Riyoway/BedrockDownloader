import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config tuned for Tauri. The dev port comes from BDL_DEV_PORT (set by
// scripts/dev.mjs, which picks a free port so it never collides with other
// apps). Falls back to 1420 for a plain `cargo tauri dev`.
const devPort = Number(process.env.BDL_DEV_PORT) || 1420;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: devPort,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
