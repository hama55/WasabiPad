import { build } from "vite";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";

const root = fileURLToPath(new URL(".", import.meta.url));
for (const [entry, format, name, fileName] of [
  ["src/abc.ts", "iife", "MusicAbc", "abc.js"],
  ["src/preview.mjs", "es", undefined, "preview.mjs"],
]) {
  await build({
    configFile: false,
    root,
    build: {
      target: "es2022",
      outDir: "dist",
      emptyOutDir: format === "iife",
      minify: true,
      lib: { entry: fileURLToPath(new URL(entry, import.meta.url)), formats: [format], name, fileName: () => fileName },
      rollupOptions: { external: /^node:/, output: { inlineDynamicImports: true } },
    },
  });
}
await mkdir(new URL("./dist/licenses/", import.meta.url), { recursive: true });
await copyFile(new URL("./src/cursor.ily", import.meta.url), new URL("./dist/cursor.ily", import.meta.url));
for (const [source, name] of [
  ["abcjs/LICENSE.md", "abcjs-LICENSE.md"],
  ["spessasynth_core/LICENSE", "spessasynth_core-LICENSE"],
  ["stb-vorbis/LICENSE", "stb-vorbis-LICENSE"],
]) {
  await copyFile(new URL(`./node_modules/${source}`, import.meta.url), new URL(`./dist/licenses/${name}`, import.meta.url));
}
