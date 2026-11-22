import { defineConfig } from "vite";
import { DEV_PORT } from "./ui/app-config";

export default defineConfig({
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: "index.html",
        viewer: "viewer.html",
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/chart.js")) {
            return "vendor-chart";
          }
          if (
            id.includes("node_modules/remark")
            || id.includes("node_modules/rehype")
            || id.includes("node_modules/unified")
            || id.includes("node_modules/micromark")
            || id.includes("node_modules/mdast")
            || id.includes("node_modules/hast")
          ) {
            return "vendor-markdown";
          }
        },
      },
    },
  },
});
