import type {
  ExportData,
  ExportDialogTrack,
  ExportReport,
  ExportTrack,
  FoundMidiClip,
  TrackPlanningSelection,
} from "./export-types.js";
import { replanExportTracks } from "./export-planner.js";
import { isMidiTrack } from "./midi-extraction.js";

function createUnplannedTrack(name: string, muted: boolean): ExportTrack {
  return {
    name,
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
    muted,
    notes: [],
  };
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
        createUnplannedTrack(trackName, Boolean(clip.mutedInGp5))
      );
    }

    const targetTrack = tracksByName.get(trackName)!;

    if (clip.mutedInGp5) {
      targetTrack.muted = true;
    }

    for (const note of clip.notes) {
      if (note.muted) continue;

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
      notes: track.notes.sort(
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

  for (const clip of clips) {
    clipsByTrack.set(
      clip.trackName,
      (clipsByTrack.get(clip.trackName) ?? 0) + 1
    );
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

    if (exportedTrack) {
      const muted = Boolean(exportedTrack.muted);

      summaries.push({
        name,
        planningTrack: exportedTrack,
        status: muted ? "muted" : "exported",
        clipCount: clipsByTrack.get(name) ?? 0,
        noteCount: exportedTrack.notes.length,
        detail: muted
          ? "Track will be muted - preparing tablature plan"
          : "Preparing tablature plan",
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

const STANDARD_TUNINGS: Record<ExportTrack["kind"], number[]> = {
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
  if (preparedTracks.length !== exportData.tracks.length) return false;

  const preparedByName = new Map(
    preparedTracks.map((track) => [track.name, track])
  );
  const validated: ExportTrack[] = [];

  for (const original of exportData.tracks) {
    const prepared = preparedByName.get(original.name);

    if (!prepared || prepared.notes.length !== original.notes.length) {
      return false;
    }

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
