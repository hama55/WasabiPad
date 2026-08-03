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
    },
  },
});
