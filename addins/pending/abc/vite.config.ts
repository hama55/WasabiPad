import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const addonRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: addonRoot,
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "entry.js",
    },
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
