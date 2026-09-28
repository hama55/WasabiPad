import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const addonRoot = fileURLToPath(new URL(".", import.meta.url));
const processorPath = fileURLToPath(new URL(
  "./node_modules/spessasynth_lib/dist/spessasynth_processor.min.js",
  import.meta.url,
));

function copyAudioWorklet(): Plugin {
  return {
    name: "copy-spessasynth-audio-worklet",
    async closeBundle() {
      await copyFile(processorPath, fileURLToPath(new URL("./dist/spessasynth_processor.min.js", import.meta.url)));
    },
  };
}

export default defineConfig({
  root: addonRoot,
  plugins: [copyAudioWorklet()],
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "entry.js",
    },
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
