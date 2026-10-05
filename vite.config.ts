import { defineConfig } from "vite";

export default defineConfig({
  // relative asset paths so dist/ works from any static host or sub-path
  base: "./",
  build: { target: "es2022", sourcemap: true },
});
