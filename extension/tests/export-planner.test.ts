import assert from "node:assert/strict";
import {
  applyPreparedTracks,
  applyTrackPlanningSelections,
  buildExportData,
} from "../src/export-data.js";
import { replanExportTracks } from "../src/export-planner.js";
import type { ExportReport, FoundMidiClip } from "../src/export-types.js";

function makeReport(): ExportReport {
  return {
    exportedAt: new Date(0).toISOString(),
    mode: "arrangement-only",
    tracksSeen: 0,
    midiTracksSeen: 0,
    tracksIgnored: [],
    tracksMutedInGp5: [],
    drumTracksDetected: 0,
    drumNotesRecognized: 0,
    drumNotesIgnored: 0,
    drumNotesMerged: 0,
    drumElements: {
      kick: 0,
      snare: 0,
      "closed-hihat": 0,
      "pedal-hihat": 0,
      "open-hihat": 0,
      ride: 0,
      "ride-bell": 0,
      crash: 0,
    },
    clipsExported: 0,
    notesExported: 0,
    warnings: [],
  };
}

function makeTrack(name: string, pitches: number[], simultaneous = false) {
  const clip: FoundMidiClip = {
    clip: {},
    clipName: name,
    trackName: name,
    startTime: 0,
    notes: pitches.map((pitch, index) => ({
      pitch,
      startTime: simultaneous ? 0 : index,
      duration: 1,
      velocity: 100,
    })),
  };

  const track = buildExportData(
    { tempo: 120 },
    [clip],
    makeReport()
  ).tracks[0];

  replanExportTracks([track]);
  return track;
}

{
  const track = makeTrack("Normal lead", [40, 52, 64, 76]);
  assert.equal(track.kind, "guitar");
  assert.equal(track.plan.globalOctaveShift, 0);
  assert.equal(track.plan.metrics.residualAdjustedNotes, 0);
}

{
  const track = makeTrack("High lead", [72, 84, 96, 100]);
  assert.equal(track.kind, "guitar");
  assert.equal(track.plan.globalOctaveShift, 0);
  assert.equal(track.plan.metrics.totalAdjustedNotes, 2);
  assert.deepEqual(
    track.notes.map((note) => note.octaveShift),
    [0, 0, -1, -1]
  );
}

{
  const track = makeTrack("Metal range", [35, 40, 52, 64]);
  assert.equal(track.kind, "guitar7");
  assert.equal(track.plan.globalOctaveShift, 0);
}

{
  const track = makeTrack("Low register", [28, 33, 40, 45]);
  assert.equal(track.kind, "bass");
  assert.equal(track.plan.globalOctaveShift, 0);
}

{
  const track = makeTrack("All low", [35, 40, 45, 50]);
  assert.equal(track.kind, "bass");
}

{
  const track = makeTrack("Mixed range", [28, 40, 52, 64]);
  assert.equal(track.kind, "guitar7");
}

{
  const track = makeTrack("Sub Bass", [40, 52, 64]);
  assert.equal(track.kind, "bass");
}

{
  const track = makeTrack("Subtle Lead", [40, 52, 64]);
  assert.equal(track.kind, "guitar");
}

{
  const track = makeTrack("Mostly normal", [30, ...Array(100).fill(64)]);
  assert.equal(track.kind, "guitar");
  assert.equal(track.plan.globalOctaveShift, 0);
  assert.equal(track.plan.metrics.totalAdjustedNotes, 1);
  assert.equal(
    track.notes.filter((note) => note.octaveShift !== 0).length,
    1
  );
}

{
  const track = makeTrack(
    "Dense chord",
    [40, 45, 50, 55, 59, 64, 67, 71],
    true
  );
  assert.equal(track.plan.metrics.unplaceableNotes, 0);
  assert.ok(track.notes.some((note) => note.voice === 1));
  assert.equal(
    new Set(
      track.notes
        .filter((note) => note.voice === 0)
        .map((note) => note.string)
    ).size,
    track.notes.filter((note) => note.voice === 0).length
  );
}

{
  const clip: FoundMidiClip = {
    clip: {},
    clipName: "Quantized collision",
    trackName: "Quantized collision",
    startTime: 0,
    notes: [
      { pitch: 40, startTime: 0, duration: 1, velocity: 100 },
      { pitch: 40, startTime: 0.01, duration: 1, velocity: 100 },
    ],
  };
  const track = buildExportData(
    { tempo: 120 },
    [clip],
    makeReport()
  ).tracks[0];
  replanExportTracks([track]);
  applyTrackPlanningSelections(
    {
      song: {
        title: "Test",
        tempo: 120,
        timeSignature: { numerator: 4, denominator: 4 },
      },
      tracks: [track],
    },
    {
      [track.name]: {
        kind: "guitar",
        globalOctaveShift: 0,
      },
    }
  );

  assert.equal(track.plan.metrics.unplaceableNotes, 0);
  assert.deepEqual(
    track.notes.map((note) => note.voice).sort(),
    [0, 1]
  );
}

{
  const track = makeTrack("Common octave chord", [30, 42, 54], true);
  applyTrackPlanningSelections(
    {
      song: {
        title: "Test",
        tempo: 120,
        timeSignature: { numerator: 4, denominator: 4 },
      },
      tracks: [track],
    },
    {
      [track.name]: {
        kind: "guitar",
        globalOctaveShift: 0,
      },
    }
  );
  assert.equal(track.plan.metrics.modifiedChords, 0);
  assert.deepEqual(
    track.notes.map((note) => note.octaveShift),
    [1, 1, 1]
  );
}

{
  const track = makeTrack("Wide chord", [20, 88], true);
  applyTrackPlanningSelections(
    {
      song: {
        title: "Test",
        tempo: 120,
        timeSignature: { numerator: 4, denominator: 4 },
      },
      tracks: [track],
    },
    {
      [track.name]: {
        kind: "guitar",
        globalOctaveShift: 0,
      },
    }
  );
  assert.equal(track.plan.metrics.modifiedChords, 1);
  assert.equal(track.plan.metrics.unplaceableNotes, 0);
}

{
  const track = makeTrack("Manual override", [40, 52, 64]);
  applyTrackPlanningSelections(
    {
      song: {
        title: "Test",
        tempo: 120,
        timeSignature: { numerator: 4, denominator: 4 },
      },
      tracks: [track],
    },
    {
      [track.name]: {
        kind: "bass",
        globalOctaveShift: 0,
      },
    }
  );
  assert.equal(track.kind, "bass");
  assert.equal(track.plan.globalOctaveShift, 0);
}

{
  const pitches = [28, 33, 35, 38, 40, 43, 45, 47, 50, 52, 55, 59];
  const track = makeTrack("Impossible override", pitches, true);

  applyTrackPlanningSelections(
    {
      song: {
        title: "Test",
        tempo: 120,
        timeSignature: { numerator: 4, denominator: 4 },
      },
      tracks: [track],
    },
    {
      [track.name]: {
        kind: "bass",
        globalOctaveShift: 0,
      },
    }
  );

  const unplaceable = track.notes.filter(
    (note) => note.placementStatus === "unplaceable"
  );

  assert.equal(track.plan.metrics.unplaceableNotes, 4);
  assert.equal(unplaceable.length, 4);
  assert.ok(
    unplaceable.every(
      (note) => note.string === undefined && note.fret === undefined
    )
  );
}

{
  const track = makeTrack("Prepared", [40, 52, 64]);
  const rawData = buildExportData(
    { tempo: 120 },
    [
      {
        clip: {},
        clipName: "Prepared",
        trackName: "Prepared",
        startTime: 0,
        notes: [40, 52, 64].map((pitch, index) => ({
          pitch,
          startTime: index,
          duration: 1,
          velocity: 100,
        })),
      },
    ],
    makeReport()
  );

  assert.equal(applyPreparedTracks(rawData, [track]), true);
  assert.ok(
    rawData.tracks[0].notes.every(
      (note) => note.placementStatus === "placed"
    )
  );
}

{
  const prepared = makeTrack("Tampered", [40, 52, 64]);
  const rawData = buildExportData(
    { tempo: 120 },
    [
      {
        clip: {},
        clipName: "Tampered",
        trackName: "Tampered",
        startTime: 0,
        notes: [40, 52, 64].map((pitch, index) => ({
          pitch,
          startTime: index,
          duration: 1,
          velocity: 100,
        })),
      },
    ],
    makeReport()
  );

  prepared.notes[0].fret = 99;
  assert.equal(applyPreparedTracks(rawData, [prepared]), false);
}

{
  const report = makeReport();
  const rawData = buildExportData(
    { tempo: 120 },
    [
      {
        clip: {},
        clipName: "Drums",
        trackName: "Drums",
        startTime: 0,
        kind: "drums",
        notes: [
          {
            pitch: 48,
            startTime: 0,
            duration: 0.25,
            velocity: 100,
            drumElement: "kick",
          },
        ],
      },
      {
        clip: {},
        clipName: "Guitar",
        trackName: "Guitar",
        startTime: 0,
        kind: "melodic",
        notes: [
          {
            pitch: 64,
            startTime: 0,
            duration: 1,
            velocity: 100,
          },
        ],
      },
    ],
    report
  );
  const preparedGuitar = structuredClone(
    rawData.tracks.find((track) => track.kind !== "drums")!
  );

  replanExportTracks([preparedGuitar]);
  assert.equal(applyPreparedTracks(rawData, [preparedGuitar]), true);
  assert.equal(rawData.tracks[0].kind, "drums");
  assert.equal(rawData.tracks[0].notes[0].percussionValue, 36);
  assert.equal(rawData.tracks[1].kind, "guitar");
}

console.log("export planner tests passed");
