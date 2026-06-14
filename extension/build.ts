import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");
const plannerMarker = "__ABLETON_TO_GP5_PLANNER_RUNTIME_SOURCE__";
const stylesMarker = "__ABLETON_TO_GP5_UI_STYLES__";
const coverMarker = "__ABLETON_TO_GP5_COVER_IMAGE__";
const uiStyles = fs.readFileSync("src/ui.generated.css", "utf8");
const coverImage = `data:image/png;base64,${fs
  .readFileSync("src/assets/cover.png")
  .toString("base64")}`;
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
  name: "embed-webview-assets",
  setup(build) {
    build.onLoad({ filter: /\.html$/ }, (args) => {
      let html = fs.readFileSync(args.path, "utf8");
      html = html.replace(
        /<style media="not all">[\s\S]*?<\/style>\s*/g,
        ""
      );

      if (!html.includes(stylesMarker)) {
        throw new Error(`UI styles marker missing from ${args.path}`);
      }

      html = html.replace(stylesMarker, uiStyles);
      html = html.replace(coverMarker, coverImage);

      if (/(^|[\\/])interface\.html$/.test(args.path)) {
        if (!html.includes(plannerMarker)) {
          throw new Error(`Planner worker marker missing from ${args.path}`);
        }

        html = html.replace(plannerMarker, plannerRuntimeSource);
      }

      return {
        contents: html,
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
