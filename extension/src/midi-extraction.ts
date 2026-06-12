import type {
  AbletonMidiNote,
  ExportReport,
  FoundMidiClip,
} from "./export-types.js";

const IGNORE_MUTED_TRACKS = true;
const IGNORE_MUTED_CLIPS = true;
const MUTE_PERCUSSION_TRACKS_IN_GP5 = true;

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isMidiTrack(track: any): boolean {
  return track?.constructor?.name === "MidiTrack";
}

function isMidiClip(clip: any): boolean {
  return clip?.constructor?.name === "MidiClip" && Array.isArray(clip.notes);
}

function isPercussionTrackName(name: string): boolean {
  const lower = name.toLowerCase();

  return [
    "drum",
    "drums",
    "kick",
    "bd",
    "snare",
    "sd",
    "clap",
    "hat",
    "hh",
    "hihat",
    "hi-hat",
    "shaker",
    "perc",
    "percu",
    "tom",
    "ride",
    "crash",
  ].some((keyword) => lower.includes(keyword));
}

function cloneNoteWithStartTime(
  note: AbletonMidiNote,
  startTime: number,
  duration: number
): AbletonMidiNote {
  return {
    ...note,
    startTime,
    duration,
  };
}

function addExpandedNote(
  target: AbletonMidiNote[],
  note: AbletonMidiNote,
  sourceStart: number,
  arrangementOffset: number,
  arrangementDuration: number
) {
  if (note.muted) return;

  const noteStart = numberOrZero(note.startTime);
  const noteDuration = numberOrZero(note.duration);
  const expandedStart = arrangementOffset + (noteStart - sourceStart);

  if (expandedStart < 0) return;
  if (expandedStart >= arrangementDuration) return;

  const remainingDuration = arrangementDuration - expandedStart;
  const clippedDuration = Math.min(noteDuration, remainingDuration);

  if (clippedDuration <= 0) return;

  target.push(cloneNoteWithStartTime(note, expandedStart, clippedDuration));
}

function expandArrangementClipNotes(clip: any): AbletonMidiNote[] {
  const notes = Array.isArray(clip.notes)
    ? (clip.notes as AbletonMidiNote[])
    : [];

  const clipStart = numberOrZero(clip.startTime);
  const clipEnd =
    typeof clip.endTime === "number"
      ? clip.endTime
      : clipStart + numberOrZero(clip.duration);

  const arrangementDuration = Math.max(0, clipEnd - clipStart);

  if (arrangementDuration <= 0) {
    return [];
  }

  const startMarker = numberOrZero(clip.startMarker);
  const looping = Boolean(clip.looping);

  if (!looping) {
    const expandedNotes: AbletonMidiNote[] = [];

    for (const note of notes) {
      const noteStart = numberOrZero(note.startTime);
      const noteEnd = noteStart + numberOrZero(note.duration);

      if (noteEnd <= startMarker) continue;
      if (noteStart >= startMarker + arrangementDuration) continue;

      addExpandedNote(
        expandedNotes,
        note,
        startMarker,
        0,
        arrangementDuration
      );
    }

    return expandedNotes.sort(
      (a, b) => a.startTime - b.startTime || a.pitch - b.pitch
    );
  }

  const loopStart = numberOrZero(clip.loopStart);
  const loopEnd =
    typeof clip.loopEnd === "number"
      ? clip.loopEnd
      : numberOrZero(clip.duration);

  const loopLength = loopEnd - loopStart;

  if (loopLength <= 0) {
    return [];
  }

  const expandedNotes: AbletonMidiNote[] = [];
  const firstSourceStart =
    startMarker >= loopStart && startMarker < loopEnd ? startMarker : loopStart;
  const firstSegmentLength = Math.max(0, loopEnd - firstSourceStart);

  for (const note of notes) {
    const noteStart = numberOrZero(note.startTime);

    if (noteStart >= firstSourceStart && noteStart < loopEnd) {
      addExpandedNote(
        expandedNotes,
        note,
        firstSourceStart,
        0,
        arrangementDuration
      );
    }
  }

  let arrangementOffset = firstSegmentLength;

  while (arrangementOffset < arrangementDuration) {
    for (const note of notes) {
      const noteStart = numberOrZero(note.startTime);

      if (noteStart >= loopStart && noteStart < loopEnd) {
        addExpandedNote(
          expandedNotes,
          note,
          loopStart,
          arrangementOffset,
          arrangementDuration
        );
      }
    }

    arrangementOffset += loopLength;
  }

  return expandedNotes.sort(
    (a, b) => a.startTime - b.startTime || a.pitch - b.pitch
  );
}

function extractArrangementMidiClipsFromTrack(
  track: any,
  mutedInGp5 = false
): FoundMidiClip[] {
  const clips: FoundMidiClip[] = [];
  const trackName = String(track.name ?? "MIDI Track");
  const arrangementClips = Array.isArray(track.arrangementClips)
    ? track.arrangementClips
    : [];

  for (const clip of arrangementClips) {
    if (!isMidiClip(clip)) continue;
    if (IGNORE_MUTED_CLIPS && clip.muted) continue;

    const expandedNotes = expandArrangementClipNotes(clip);

    if (expandedNotes.length === 0) continue;

    clips.push({
      clip,
      clipName: String(clip.name ?? "MIDI Clip"),
      trackName,
      startTime: numberOrZero(clip.startTime),
      notes: expandedNotes,
      mutedInGp5,
    });
  }

  return clips;
}

export function findArrangementMidiClips(
  song: any,
  report: ExportReport
): FoundMidiClip[] {
  const tracks = Array.isArray(song.tracks) ? song.tracks : [];
  const found: FoundMidiClip[] = [];

  report.tracksSeen = tracks.length;

  for (const track of tracks) {
    const trackName = String(track.name ?? "Unnamed Track");

    if (!isMidiTrack(track)) continue;

    report.midiTracksSeen += 1;

    if (IGNORE_MUTED_TRACKS && track.mute) {
      report.tracksIgnored.push({
        name: trackName,
        reason: "muted",
      });
      continue;
    }

    if (track.mutedViaSolo) {
      report.warnings.push(
        `Track "${trackName}" was muted via solo state in Ableton but still exported.`
      );
    }

    const mutedInGp5 =
      MUTE_PERCUSSION_TRACKS_IN_GP5 && isPercussionTrackName(trackName);

    if (mutedInGp5) {
      report.tracksMutedInGp5.push({
        name: trackName,
        reason: "drum/percussion name filter",
      });
    }

    const arrangementClips = extractArrangementMidiClipsFromTrack(
      track,
      mutedInGp5
    );

    for (const clip of arrangementClips) {
      found.push(clip);
    }
  }

  return found;
}
