import assert from "node:assert/strict";
import * as vm from "node:vm";
import * as esbuild from "esbuild";
import type { ExportTrack } from "../src/export-types.js";

const result = await esbuild.build({
  entryPoints: ["src/planner-browser.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  minify: true,
});
const context: Record<string, any> = {};

context.globalThis = context;
vm.runInNewContext(result.outputFiles[0].text, context);

assert.equal(
  typeof context.abletonToGp5Planner?.planTrack,
  "function"
);

const track: ExportTrack = {
  name: "Browser planner test",
  kind: "guitar",
  tuning: [40, 45, 50, 55, 59, 64],
  plan: {
    kind: "guitar",
    instrument: "6-string guitar - EADGBE",
    tuning: [40, 45, 50, 55, 59, 64],
    globalOctaveShift: 0,
    metrics: {
      unplaceableNotes: 0,
      modifiedChords: 0,
      totalAdjustedNotes: 0,
      totalOctaveDistance: 0,
      residualAdjustedNotes: 0,
      residualOctaveDistance: 0,
      adjustedDuration: 0,
      octaveTransitionDistance: 0,
      fretPositionCost: 0,
    },
  },
  notes: [35, 40, 52, 64].map((pitch, index) => ({
    pitch,
    start: index,
    duration: 1,
    velocity: 100,
  })),
};

context.abletonToGp5Planner.planTrack(track);
assert.equal(track.kind, "guitar7");

context.abletonToGp5Planner.planTrack(track, {
  kind: "bass",
  globalOctaveShift: 0,
});
assert.equal(track.kind, "bass");

console.log("planner browser runtime tests passed");
