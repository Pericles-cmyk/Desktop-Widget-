import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // O Vite deve observar apenas os arquivos do frontend.
      // O Rust/Tauri gera executáveis em src-tauri/target, que podem ficar
      // bloqueados no Windows e provocar EBUSY no watcher do Node.
      ignored: ["**/src-tauri/**", "**/node_modules/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: ["es2020", "chrome100", "safari13"],
    minify: "esbuild",
    sourcemap: false,
  },
});
