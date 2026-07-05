import { defineConfig } from "vite";

// Served from /restaurant-finder/, not the site root, so assets must be relative.
export default defineConfig({
  base: "./",
});
