import { defineConfig } from "vite";

// Served from /omnom/, not the site root, so assets must be relative.
export default defineConfig({
  base: "./",
});
