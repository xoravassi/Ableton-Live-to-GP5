import type {
  ExportData,
  ExportDialogTrack,
  ExportReport,
  ExportTrack,
  FoundMidiClip,
  StringedTrackKind,
  TrackPlanningSelection,
} from "./export-types.js";
import { replanExportTracks } from "./export-planner.js";
import { isMidiTrack } from "./midi-extraction.js";

const DRUM_VALUES = {
  kick: 36,
  snare: 38,
  "closed-hihat": 42,
  "pedal-hihat": 44,
  "open-hihat": 46,
  crash: 49,
  ride: 51,
  "ride-bell": 53,
} as const;

function emptyMetrics() {
  return {
    unplaceableNotes: 0,
    modifiedChords: 0,
    totalAdjustedNotes: 0,
    totalOctaveDistance: 0,
    residualAdjustedNotes: 0,
    residualOctaveDistance: 0,
    adjustedDuration: 0,
    octaveTransitionDistance: 0,
    fretPositionCost: 0,
  };
}

function createUnplannedTrack(
  name: string,
  kind: "melodic" | "drums"
): ExportTrack {
  if (kind === "drums") {
    return {
      name,
      kind: "drums",
      tuning: [],
      plan: {
        kind: "drums",
        instrument: "GP5 drum kit",
        tuning: [],
        globalOctaveShift: 0,
        metrics: emptyMetrics(),
      },
      notes: [],
    };
  }

  return {
    name,
    kind: "guitar",
    tuning: [40, 45, 50, 55, 59, 64],
    plan: {
      kind: "guitar",
      instrument: "6-string guitar - EADGBE",
      tuning: [40, 45, 50, 55, 59, 64],
      globalOctaveShift: 0,
      metrics: emptyMetrics(),
    },
    notes: [],
  };
}

function deduplicateDrumNotes(
  notes: ExportTrack["notes"],
  report: ExportReport
): ExportTrack["notes"] {
  const seen = new Set<string>();
  const result: ExportTrack["notes"] = [];

  for (const note of notes) {
    const key = `${Math.round(note.start * 8)}:${note.percussionValue}`;

    if (seen.has(key)) {
      report.drumNotesMerged += 1;
      continue;
    }

    seen.add(key);
    result.push(note);
  }

  return result;
}

export function buildExportData(
  song: any,
  clips: FoundMidiClip[],
  report: ExportReport
): ExportData {
  const tracksByName = new Map<string, ExportTrack>();

  for (const clip of clips) {
    const trackName = clip.trackName || clip.clipName;

    if (!tracksByName.has(trackName)) {
      tracksByName.set(
        trackName,
        createUnplannedTrack(trackName, clip.kind ?? "melodic")
      );
    }

    const targetTrack = tracksByName.get(trackName)!;

    for (const note of clip.notes) {
      if (note.muted) continue;

      if (targetTrack.kind === "drums") {
        if (
          note.drumElement &&
          note.drumElement !== "unrecognized"
        ) {
          report.drumNotesRecognized += 1;
          report.drumElements[note.drumElement] += 1;
          targetTrack.notes.push({
            pitch: note.pitch,
            start: clip.startTime + note.startTime,
            duration: note.duration,
            velocity: note.velocity,
            drumElement: note.drumElement,
            percussionValue: DRUM_VALUES[note.drumElement],
            drumSourceName: note.drumSourceName,
          });
        } else {
          report.drumNotesIgnored += 1;
        }

        continue;
      }

      targetTrack.notes.push({
        pitch: note.pitch,
        start: clip.startTime + note.startTime,
        duration: note.duration,
        velocity: note.velocity,
      });
    }
  }

  const tracks = Array.from(tracksByName.values())
    .filter((track) => track.notes.length > 0)
    .map((track) => ({
      ...track,
      notes:
        track.kind === "drums"
          ? deduplicateDrumNotes(
              track.notes.sort(
                (a, b) =>
                  a.start - b.start ||
                  (a.percussionValue ?? 0) - (b.percussionValue ?? 0)
              ),
              report
            )
          : track.notes.sort(
              (a, b) => a.start - b.start || a.pitch - b.pitch
            ),
    }));

  report.clipsExported = clips.length;
  report.notesExported = tracks.reduce(
    (total, track) => total + track.notes.length,
    0
  );

  if (tracks.length === 0) {
    report.warnings.push("No MIDI notes exported.");
  }

  if (report.drumNotesIgnored > 0) {
    report.warnings.push(
      `${report.drumNotesIgnored} drum hit(s) were not recognized as a supported element.`
    );
  }

  if (report.drumNotesMerged > 0) {
    report.warnings.push(
      `${report.drumNotesMerged} duplicate drum hit(s) were merged.`
    );
  }

  return {
    song: {
      title: "Ableton Live Export",
      tempo: song.tempo ?? 120,
      timeSignature: {
        numerator: 4,
        denominator: 4,
      },
    },
    tracks,
  };
}

export function buildExportDialogTracks(
  song: any,
  clips: FoundMidiClip[],
  exportData: ExportData,
  report: ExportReport
): ExportDialogTrack[] {
  const clipsByTrack = new Map<string, number>();
  const drumsByTrack = new Map<
    string,
    {
      kick: number;
      snare: number;
      hihat: number;
      ride: number;
      crash: number;
      unrecognized: number;
    }
  >();

  for (const clip of clips) {
    clipsByTrack.set(
      clip.trackName,
      (clipsByTrack.get(clip.trackName) ?? 0) + 1
    );

    if (clip.kind === "drums") {
      const summary = drumsByTrack.get(clip.trackName) ?? {
        kick: 0,
        snare: 0,
        hihat: 0,
        ride: 0,
        crash: 0,
        unrecognized: 0,
      };

      for (const note of clip.notes) {
        if (note.drumElement === "kick") {
          summary.kick += 1;
        } else if (note.drumElement === "snare") {
          summary.snare += 1;
        } else if (
          note.drumElement === "closed-hihat" ||
          note.drumElement === "pedal-hihat" ||
          note.drumElement === "open-hihat"
        ) {
          summary.hihat += 1;
        } else if (
          note.drumElement === "ride" ||
          note.drumElement === "ride-bell"
        ) {
          summary.ride += 1;
        } else if (note.drumElement === "crash") {
          summary.crash += 1;
        } else {
          summary.unrecognized += 1;
        }
      }

      drumsByTrack.set(clip.trackName, summary);
    }
  }

  const exportedByTrack = new Map(
    exportData.tracks.map((track) => [track.name, track])
  );
  const ignoredByTrack = new Map(
    report.tracksIgnored.map((track) => [track.name, track.reason])
  );
  const summaries: ExportDialogTrack[] = [];
  const namesSeen = new Set<string>();
  const tracks = Array.isArray(song.tracks) ? song.tracks : [];

  for (const track of tracks) {
    if (!isMidiTrack(track)) continue;

    const name = String(track.name ?? "Unnamed Track");

    if (namesSeen.has(name)) continue;
    namesSeen.add(name);

    const exportedTrack = exportedByTrack.get(name);
    const ignoredReason = ignoredByTrack.get(name);
    const drumSummary = drumsByTrack.get(name);

    if (exportedTrack) {
      const muted = Boolean(exportedTrack.muted);
      const isDrums = exportedTrack.kind === "drums";
      const drumDetail = drumSummary
        ? [
            `${drumSummary.kick} kick`,
            `${drumSummary.snare} snare`,
            `${drumSummary.hihat} hi-hat`,
            `${drumSummary.ride} ride`,
            `${drumSummary.crash} crash`,
          ].join(" - ") +
          (drumSummary.unrecognized > 0
            ? ` - ${drumSummary.unrecognized} unrecognized hit(s)`
            : "")
        : "Supported drums mapped to General MIDI";

      summaries.push({
        name,
        planningTrack: isDrums ? undefined : exportedTrack,
        instrument: isDrums
          ? "GP5 drum kit"
          : undefined,
        drumSummary,
        status: muted ? "muted" : "exported",
        clipCount: clipsByTrack.get(name) ?? 0,
        noteCount: exportedTrack.notes.length,
        detail: isDrums
          ? drumDetail
          : muted
            ? "Track will be muted - preparing tablature plan"
            : "Preparing tablature plan",
      });
      continue;
    }

    if (drumSummary) {
      summaries.push({
        name,
        instrument: "Drum track",
        drumSummary,
        status: "empty",
        clipCount: clipsByTrack.get(name) ?? 0,
        noteCount: 0,
        detail:
          `No supported drum element recognized - ` +
          `${drumSummary.unrecognized} drum hit(s) ignored`,
      });
      continue;
    }

    if (ignoredReason) {
      summaries.push({
        name,
        status: "ignored",
        clipCount: 0,
        noteCount: 0,
        detail:
          ignoredReason === "muted"
            ? "Ignored because the track is explicitly muted in Ableton"
            : `Ignored: ${ignoredReason}`,
      });
      continue;
    }

    summaries.push({
      name,
      status: "empty",
      clipCount: 0,
      noteCount: 0,
      detail: "No exportable MIDI notes in the Arrangement",
    });
  }

  return summaries;
}

export function applyTrackPlanningSelections(
  exportData: ExportData,
  selections: Record<string, TrackPlanningSelection>
): void {
  replanExportTracks(exportData.tracks, selections);
}

const STANDARD_TUNINGS: Record<StringedTrackKind, number[]> = {
  guitar: [40, 45, 50, 55, 59, 64],
  guitar7: [35, 40, 45, 50, 55, 59, 64],
  bass: [28, 33, 38, 43],
};

function arraysEqual(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function applyPreparedTracks(
  exportData: ExportData,
  preparedTracks: ExportTrack[]
): boolean {
  const stringedTracks = exportData.tracks.filter(
    (track) => track.kind !== "drums"
  );

  if (preparedTracks.length !== stringedTracks.length) return false;

  const preparedByName = new Map(
    preparedTracks.map((track) => [track.name, track])
  );
  const validated: ExportTrack[] = [];

  for (const original of exportData.tracks) {
    if (original.kind === "drums") {
      validated.push(original);
      continue;
    }

    const prepared = preparedByName.get(original.name);

    if (!prepared || prepared.notes.length !== original.notes.length) {
      return false;
    }

    if (prepared.kind === "drums") return false;

    const expectedTuning = STANDARD_TUNINGS[prepared.kind];

    if (
      !expectedTuning ||
      prepared.plan?.kind !== prepared.kind ||
      !arraysEqual(prepared.tuning, expectedTuning) ||
      !arraysEqual(prepared.plan.tuning, expectedTuning)
    ) {
      return false;
    }

    for (let index = 0; index < original.notes.length; index += 1) {
      const source = original.notes[index];
      const planned = prepared.notes[index];

      if (
        planned.pitch !== source.pitch ||
        planned.start !== source.start ||
        planned.duration !== source.duration ||
        planned.velocity !== source.velocity
      ) {
        return false;
      }

      if (planned.placementStatus === "placed") {
        const stringsHighToLow = [...expectedTuning].reverse();

        if (
          !Number.isInteger(planned.adjustedPitch) ||
          (planned.voice !== 0 && planned.voice !== 1) ||
          !Number.isInteger(planned.string) ||
          !Number.isInteger(planned.fret) ||
          planned.string! < 1 ||
          planned.string! > stringsHighToLow.length ||
          planned.fret! < 0 ||
          planned.fret! > 24 ||
          stringsHighToLow[planned.string! - 1] + planned.fret! !==
            planned.adjustedPitch ||
          planned.adjustedPitch! - planned.pitch !==
            12 * (planned.octaveShift ?? Number.NaN)
        ) {
          return false;
        }
      } else if (planned.placementStatus === "unplaceable") {
        if (planned.string !== undefined || planned.fret !== undefined) {
          return false;
        }
      } else {
        return false;
      }
    }

    validated.push({
      ...prepared,
      muted: original.muted,
    });
  }

  exportData.tracks = validated;
  return true;
}
