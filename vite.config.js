import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths so the game works from any folder, e.g. ktairou.github.io/driving-game/
  base: "./",
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 6000,
  },
  server: {
    port: 5173,
  },
});
