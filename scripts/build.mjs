// Bundles the Extension Host entry point and the Webview script/stylesheet.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const builds = [
  {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    mainFields: ["module", "main"],
    external: ["vscode"],
    sourcemap: true,
    outfile: "out/extension.js",
  },
  {
    entryPoints: { main: "src/webview/main.ts", tree: "src/webview/tree.css" },
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    sourcemap: true,
    outdir: "out/webview",
  },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log("esbuild: watching for changes…");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
