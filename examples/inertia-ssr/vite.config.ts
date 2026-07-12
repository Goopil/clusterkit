import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  build: {
    ssr: "src/entry-server.ts",
    outDir: "dist/server",
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "entry-server.mjs",
        format: "esm",
      },
    },
  },
});
