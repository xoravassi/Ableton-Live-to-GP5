import type {
  AbletonMidiNote,
  DrumElement,
  ExportReport,
  FoundMidiClip,
} from "./export-types.js";

const IGNORE_MUTED_TRACKS = true;
const IGNORE_MUTED_CLIPS = true;

type DrumClassification = {
  element: DrumElement;
  sourceName: string;
};

type DrumTrackContext = {
  isDrumTrack: boolean;
  notes: Map<number, DrumClassification>;
  direct?: DrumClassification;
  track?: DrumClassification;
};

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isMidiTrack(track: any): boolean {
  return track?.constructor?.name === "MidiTrack";
}

function isMidiClip(clip: any): boolean {
  return clip?.constructor?.name === "MidiClip" && Array.isArray(clip.notes);
}

function safeArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function readProperty(target: any, property: string): unknown {
  try {
    return target?.[property];
  } catch {
    return undefined;
  }
}

function objectClassName(value: any): string {
  return String(value?.constructor?.name ?? "").toLowerCase();
}

function fileName(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || value;
}

function normalizedWords(value: string): string[] {
  return fileName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function classifyDrumLabel(value: string): DrumElement | null {
  const words = normalizedWords(value);
  const normalized = words.join(" ");
  const compact = words.join("");

  if (
    normalized.includes("bass drum") ||
    words.some(
      (word) =>
        word === "kick" ||
        word === "bd" ||
        /^kick\d+$/.test(word) ||
        /^bd\d+$/.test(word)
    )
  ) {
    return "kick";
  }

  if (
    words.some(
      (word) =>
        word === "snare" ||
        word === "snr" ||
        word === "sd" ||
        /^snare\d+$/.test(word) ||
        /^snr\d+$/.test(word) ||
        /^sd\d+$/.test(word)
    )
  ) {
    return "snare";
  }

  const isRide = words.some(
    (word) => word === "ride" || /^ride\d+$/.test(word)
  );

  if (isRide || compact.includes("ridecymbal")) {
    const isBell =
      words.some((word) => word === "bell" || word === "rb") ||
      compact.includes("ridebell");

    return isBell ? "ride-bell" : "ride";
  }

  if (
    words.some(
      (word) =>
        word === "crash" ||
        /^crash\d+$/.test(word) ||
        word === "cr"
    ) ||
    compact.includes("crashcymbal")
  ) {
    return "crash";
  }

  const isHihat =
    normalized.includes("hi hat") ||
    compact.includes("hihat") ||
    words.some(
      (word) =>
        word === "hat" ||
        word === "hh" ||
        word === "ch" ||
        word === "oh" ||
        word === "ph" ||
        word === "chh" ||
        word === "ohh" ||
        word === "phh" ||
        /^hh\d+$/.test(word)
    );

  if (isHihat) {
    const isPedal =
      words.some(
        (word) =>
          word === "pedal" ||
          word === "foot" ||
          word === "chick" ||
          word === "ph" ||
          word === "phh"
      ) ||
      compact.includes("pedalhat") ||
      compact.includes("foothat");

    if (isPedal) return "pedal-hihat";

    const isOpen =
      words.some(
        (word) =>
          word === "open" ||
          word === "opened" ||
          word === "oh" ||
          word === "ohh"
      ) ||
      compact.includes("openhihat") ||
      compact.includes("openhat");

    return isOpen ? "open-hihat" : "closed-hihat";
  }

  return null;
}

function classifyLabels(labels: string[]): DrumClassification | undefined {
  for (const label of labels) {
    const element = classifyDrumLabel(label);

    if (element) {
      return {
        element,
        sourceName: fileName(label),
      };
    }
  }

  return undefined;
}

function isPercussionTrackName(name: string): boolean {
  const words = normalizedWords(name);

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
    "cymbal",
  ].some((keyword) => words.includes(keyword));
}

function collectDeviceLabels(devices: any[]): string[] {
  const sampleLabels: string[] = [];
  const deviceLabels: string[] = [];

  for (const device of devices) {
    const sample = readProperty(device, "sample") as any;
    const samplePath = readProperty(sample, "filePath");

    if (typeof samplePath === "string" && samplePath.trim()) {
      sampleLabels.push(samplePath);
    }

    const name = readProperty(device, "name");

    if (typeof name === "string" && name.trim()) {
      deviceLabels.push(name);
    }

    for (const chain of safeArray(readProperty(device, "chains"))) {
      sampleLabels.push(
        ...collectDeviceLabels(safeArray(readProperty(chain, "devices")))
      );
    }
  }

  return [...sampleLabels, ...deviceLabels];
}

function addDrumChainMapping(
  mappings: Map<number, DrumClassification>,
  conflicts: Set<number>,
  receivingNote: number,
  classification: DrumClassification | undefined
): void {
  if (!classification || conflicts.has(receivingNote)) return;

  const existing = mappings.get(receivingNote);

  if (existing && existing.element !== classification.element) {
    mappings.delete(receivingNote);
    conflicts.add(receivingNote);
    return;
  }

  mappings.set(receivingNote, classification);
}

function scanRackDevice(
  device: any,
  mappings: Map<number, DrumClassification>,
  conflicts: Set<number>
): boolean {
  let foundDrumChain = false;

  for (const chain of safeArray(readProperty(device, "chains"))) {
    const receivingNote = readProperty(chain, "receivingNote");
    const chainDevices = safeArray(readProperty(chain, "devices"));

    if (typeof receivingNote === "number" && Number.isFinite(receivingNote)) {
      foundDrumChain = true;
      addDrumChainMapping(
        mappings,
        conflicts,
        receivingNote,
        classifyLabels(collectDeviceLabels(chainDevices))
      );
    }

    for (const childDevice of chainDevices) {
      foundDrumChain =
        scanRackDevice(childDevice, mappings, conflicts) || foundDrumChain;
    }
  }

  return foundDrumChain;
}

function getDrumTrackContext(track: any): DrumTrackContext {
  const trackName = String(track.name ?? "Unnamed Track");
  const devices = safeArray(readProperty(track, "devices"));
  const mappings = new Map<number, DrumClassification>();
  const conflicts = new Set<number>();
  let hasDrumRack = false;

  for (const device of devices) {
    const className = objectClassName(device);
    const chains = safeArray(readProperty(device, "chains"));
    const looksLikeDrumRack =
      className.includes("drumrack") ||
      chains.some(
        (chain) =>
          typeof readProperty(chain, "receivingNote") === "number"
      );

    if (looksLikeDrumRack) {
      hasDrumRack = true;
    }

    hasDrumRack =
      scanRackDevice(device, mappings, conflicts) || hasDrumRack;
  }

  const directLabels: string[] = [];

  for (const device of devices) {
    const sample = readProperty(device, "sample") as any;
    const samplePath = readProperty(sample, "filePath");
    const deviceName = readProperty(device, "name");

    if (typeof samplePath === "string" && samplePath.trim()) {
      directLabels.push(samplePath);
    }

    if (typeof deviceName === "string" && deviceName.trim()) {
      directLabels.push(deviceName);
    }
  }

  const trackClassification = classifyLabels([trackName]);
  const directClassification = classifyLabels(directLabels);

  return {
    isDrumTrack:
      hasDrumRack ||
      isPercussionTrackName(trackName) ||
      Boolean(trackClassification) ||
      Boolean(directClassification),
    notes: mappings,
    direct: directClassification,
    track: trackClassification,
  };
}

function classifyDrumNote(
  note: AbletonMidiNote,
  clipName: string,
  context: DrumTrackContext
): AbletonMidiNote {
  if (!context.isDrumTrack) return note;

  const mapped = context.notes.get(note.pitch);
  const clipClassification = classifyLabels([clipName]);
  const generalMidiElements: Partial<Record<number, DrumElement>> = {
    35: "kick",
    36: "kick",
    38: "snare",
    40: "snare",
    42: "closed-hihat",
    44: "pedal-hihat",
    46: "open-hihat",
    49: "crash",
    51: "ride",
    53: "ride-bell",
    57: "crash",
    59: "ride",
  };
  const generalMidiElement = generalMidiElements[note.pitch];
  const generalMidi = generalMidiElement
    ? {
        element: generalMidiElement,
        sourceName: `GM ${note.pitch}`,
      }
    : undefined;
  const classification =
    mapped ??
    context.direct ??
    clipClassification ??
    generalMidi ??
    context.track;

  return {
    ...note,
    drumElement: classification?.element ?? "unrecognized",
    drumSourceName: classification?.sourceName,
  };
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
  drumContext: DrumTrackContext
): FoundMidiClip[] {
  const clips: FoundMidiClip[] = [];
  const trackName = String(track.name ?? "MIDI Track");
  const arrangementClips = Array.isArray(track.arrangementClips)
    ? track.arrangementClips
    : [];

  for (const clip of arrangementClips) {
    if (!isMidiClip(clip)) continue;
    if (IGNORE_MUTED_CLIPS && clip.muted) continue;

    const clipName = String(clip.name ?? "MIDI Clip");
    const expandedNotes = expandArrangementClipNotes(clip).map((note) =>
      classifyDrumNote(note, clipName, drumContext)
    );

    if (expandedNotes.length === 0) continue;

    clips.push({
      clip,
      clipName,
      trackName,
      startTime: numberOrZero(clip.startTime),
      notes: expandedNotes,
      kind: drumContext.isDrumTrack ? "drums" : "melodic",
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

    const drumContext = getDrumTrackContext(track);

    if (drumContext.isDrumTrack) {
      report.drumTracksDetected += 1;
    }

    const arrangementClips = extractArrangementMidiClipsFromTrack(
      track,
      drumContext
    );

    for (const clip of arrangementClips) {
      found.push(clip);
    }
  }

  return found;
}
