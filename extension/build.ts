import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");
const plannerMarker = "__ABLETON_TO_GP5_PLANNER_RUNTIME_SOURCE__";
const plannerRuntime = await esbuild.build({
  entryPoints: ["src/planner-browser.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  minify: true,
  logLevel: "silent",
});
const plannerRuntimeSource = plannerRuntime.outputFiles[0].text;

const interfacePlugin: esbuild.Plugin = {
  name: "embed-planner-worker",
  setup(build) {
    build.onLoad({ filter: /(^|[\\/])interface\.html$/ }, (args) => {
      const html = fs.readFileSync(args.path, "utf8");

      if (!html.includes(plannerMarker)) {
        throw new Error(`Planner worker marker missing from ${args.path}`);
      }

      return {
        contents: html.replace(
          plannerMarker,
          plannerRuntimeSource
        ),
        loader: "text",
      };
    });
  },
};

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  plugins: [interfacePlugin],
  loader: {
    ".html": "text",
    ".py": "text",
  },
});
