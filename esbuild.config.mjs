import esbuild from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { sveltePreprocess } from "svelte-preprocess";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [
    esbuildSvelte({
      compilerOptions: {
        css: "injected",
        // Obsidian hot reload keeps injected styles. A filename-only hash
        // would reuse the previous release's CSS after a plugin update.
        cssHash: ({ css, hash }) => `svelte-${hash(css)}`,
      },
      preprocess: sveltePreprocess(),
    }),
  ],
  external: [
    "obsidian",
    "electron",
    "http",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
