import assert from "node:assert/strict";
import {
  buildExportData,
  buildExportDialogTracks,
} from "../src/export-data.js";
import { findArrangementMidiClips } from "../src/midi-extraction.js";
import type { ExportReport } from "../src/export-types.js";

class Simpler {
  constructor(
    public name: string,
    public sample: { filePath: string } | null
  ) {}
}

class DrumChain {
  constructor(
    public receivingNote: number,
    public devices: unknown[]
  ) {}
}

class DrumRack {
  name = "Drum Rack";

  constructor(public chains: DrumChain[]) {}
}

class MidiClip {
  muted = false;
  looping = false;
  startMarker = 0;
  loopStart = 0;
  loopEnd = 4;
  startTime = 0;
  endTime = 4;

  constructor(
    public name: string,
    public notes: {
      pitch: number;
      startTime: number;
      duration: number;
      velocity: number;
    }[]
  ) {}
}

class MidiTrack {
  mute = false;
  mutedViaSolo = false;

  constructor(
    public name: string,
    public arrangementClips: MidiClip[],
    public devices: unknown[]
  ) {}
}

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

{
  const track = new MidiTrack(
    "Main drums",
    [
      new MidiClip("Beat", [
        { pitch: 48, startTime: 0.01, duration: 0.25, velocity: 110 },
        { pitch: 49, startTime: 0.01, duration: 0.25, velocity: 105 },
        { pitch: 48, startTime: 0.02, duration: 0.25, velocity: 90 },
        { pitch: 51, startTime: 0.5, duration: 0.25, velocity: 100 },
        { pitch: 50, startTime: 1, duration: 0.25, velocity: 100 },
        { pitch: 52, startTime: 1, duration: 0.25, velocity: 100 },
        { pitch: 53, startTime: 1.5, duration: 0.25, velocity: 100 },
        { pitch: 54, startTime: 2, duration: 0.25, velocity: 100 },
        { pitch: 55, startTime: 2.5, duration: 0.25, velocity: 100 },
        { pitch: 56, startTime: 3, duration: 0.25, velocity: 100 },
      ]),
    ],
    [
      new DrumRack([
        new DrumChain(48, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\KICK_909_01.wav",
          }),
        ]),
        new DrumChain(49, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\SNARE-tight.wav",
          }),
        ]),
        new DrumChain(50, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\Clap.wav",
          }),
        ]),
        new DrumChain(51, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\CHH_909.wav",
          }),
        ]),
        new DrumChain(52, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\Open_HiHat.wav",
          }),
        ]),
        new DrumChain(53, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\Pedal_Hat_Chick.wav",
          }),
        ]),
        new DrumChain(54, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\Ride_Cymbal.wav",
          }),
        ]),
        new DrumChain(55, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\Ride_Bell.wav",
          }),
        ]),
        new DrumChain(56, [
          new Simpler("Simpler", {
            filePath: "C:\\Samples\\Crash_02.wav",
          }),
        ]),
      ]),
    ]
  );
  const song = { tempo: 120, tracks: [track] };
  const report = makeReport();
  const clips = findArrangementMidiClips(song, report);

  assert.equal(report.drumTracksDetected, 1);
  assert.equal(clips[0].kind, "drums");
  assert.deepEqual(
    clips[0].notes.map((note) => note.drumElement),
    [
      "kick",
      "snare",
      "kick",
      "closed-hihat",
      "unrecognized",
      "open-hihat",
      "pedal-hihat",
      "ride",
      "ride-bell",
      "crash",
    ]
  );
  assert.equal(clips[0].notes[0].drumSourceName, "KICK_909_01.wav");

  const exportData = buildExportData(song, clips, report);
  const drumTrack = exportData.tracks[0];

  assert.equal(drumTrack.kind, "drums");
  assert.deepEqual(
    drumTrack.notes.map((note) => note.percussionValue),
    [36, 38, 42, 46, 44, 51, 53, 49]
  );
  assert.equal(report.drumNotesRecognized, 9);
  assert.equal(report.drumNotesIgnored, 1);
  assert.equal(report.drumNotesMerged, 1);
  assert.deepEqual(report.drumElements, {
    kick: 2,
    snare: 1,
    "closed-hihat": 1,
    "pedal-hihat": 1,
    "open-hihat": 1,
    ride: 1,
    "ride-bell": 1,
    crash: 1,
  });

  const dialogTrack = buildExportDialogTracks(
    song,
    clips,
    exportData,
    report
  )[0];

  assert.equal(dialogTrack.instrument, "GP5 drum kit");
  assert.equal(dialogTrack.planningTrack, undefined);
  assert.deepEqual(dialogTrack.drumSummary, {
    kick: 2,
    snare: 1,
    hihat: 3,
    ride: 2,
    crash: 1,
    unrecognized: 1,
  });
}

{
  const track = new MidiTrack(
    "Huge Kick",
    [
      new MidiClip("Pattern", [
        { pitch: 72, startTime: 0, duration: 0.25, velocity: 100 },
      ]),
    ],
    [
      new Simpler("Simpler", {
        filePath: "C:\\Samples\\anonymous.wav",
      }),
    ]
  );
  const report = makeReport();
  const clips = findArrangementMidiClips({ tracks: [track] }, report);

  assert.equal(clips[0].kind, "drums");
  assert.equal(clips[0].notes[0].drumElement, "kick");
  assert.equal(clips[0].notes[0].drumSourceName, "Huge Kick");
}

{
  const track = new MidiTrack(
    "Piano",
    [
      new MidiClip("Chords", [
        { pitch: 36, startTime: 0, duration: 1, velocity: 100 },
      ]),
    ],
    []
  );
  const report = makeReport();
  const clips = findArrangementMidiClips({ tracks: [track] }, report);

  assert.equal(clips[0].kind, "melodic");
  assert.equal(clips[0].notes[0].drumElement, undefined);
}

{
  const track = new MidiTrack(
    "Drums",
    [
      new MidiClip("GM pattern", [
        { pitch: 42, startTime: 0, duration: 0.25, velocity: 100 },
        { pitch: 44, startTime: 0.5, duration: 0.25, velocity: 100 },
        { pitch: 46, startTime: 1, duration: 0.25, velocity: 100 },
        { pitch: 49, startTime: 1.5, duration: 0.25, velocity: 100 },
        { pitch: 51, startTime: 2, duration: 0.25, velocity: 100 },
        { pitch: 53, startTime: 2.5, duration: 0.25, velocity: 100 },
        { pitch: 57, startTime: 3, duration: 0.25, velocity: 100 },
        { pitch: 59, startTime: 3.5, duration: 0.25, velocity: 100 },
      ]),
    ],
    []
  );
  const report = makeReport();
  const clips = findArrangementMidiClips({ tracks: [track] }, report);

  assert.deepEqual(
    clips[0].notes.map((note) => note.drumElement),
    [
      "closed-hihat",
      "pedal-hihat",
      "open-hihat",
      "crash",
      "ride",
      "ride-bell",
      "crash",
      "ride",
    ]
  );
}

{
  const track = new MidiTrack(
    "HiHat",
    [
      new MidiClip("Pattern", [
        { pitch: 46, startTime: 0, duration: 0.25, velocity: 100 },
      ]),
    ],
    []
  );
  const report = makeReport();
  const clips = findArrangementMidiClips({ tracks: [track] }, report);

  assert.equal(clips[0].notes[0].drumElement, "open-hihat");
}

console.log("MIDI extraction tests passed");
