import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    ssr: "src/entry-server.tsx",
    outDir: "dist/server",
    minify: false,
    rollupOptions: {
      output: {
        format: "esm",
        entryFileNames: "[name].mjs",
      },
    },
  },
});
