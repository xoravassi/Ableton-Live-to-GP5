import type {
  ExportData,
  ExportDialogTrack,
  ExportReport,
  ExportTrack,
  FoundMidiClip,
} from "./export-types.js";
import { isMidiTrack } from "./midi-extraction.js";

function inferTrackKind(name: string): "guitar" | "bass" {
  const lower = name.toLowerCase();

  if (
    lower.includes("bass") ||
    lower.includes("basse") ||
    lower.includes("sub")
  ) {
    return "bass";
  }

  return "guitar";
}

function getTuning(kind: "guitar" | "bass"): number[] {
  if (kind === "bass") {
    return [28, 33, 38, 43];
  }

  return [40, 45, 50, 55, 59, 64];
}

export function buildExportData(
  song: any,
  clips: FoundMidiClip[],
  report: ExportReport
): ExportData {
  const tracksByName = new Map<string, ExportTrack>();

  for (const clip of clips) {
    const trackName = clip.trackName || clip.clipName;
    const kind = inferTrackKind(trackName);

    if (!tracksByName.has(trackName)) {
      tracksByName.set(trackName, {
        name: trackName,
        kind,
        tuning: getTuning(kind),
        muted: Boolean(clip.mutedInGp5),
        notes: [],
      });
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
      notes: track.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch),
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
        status: muted ? "muted" : "exported",
        clipCount: clipsByTrack.get(name) ?? 0,
        noteCount: exportedTrack.notes.length,
        detail: muted
          ? "Exportee, piste muette dans Guitar Pro"
          : "Exportee dans Guitar Pro",
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
            ? "Ignoree car explicitement mutee dans Ableton"
            : `Ignoree : ${ignoredReason}`,
      });
      continue;
    }

    summaries.push({
      name,
      status: "empty",
      clipCount: 0,
      noteCount: 0,
      detail: "Aucune note MIDI exportable dans l'Arrangement",
    });
  }

  return summaries;
}
