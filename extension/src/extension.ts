import { initialize } from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTENSION_ID = "ableton-live-to-gp5";

type Activation = Parameters<typeof initialize>[0];

type AbletonMidiNote = {
  id?: number;
  pitch: number;
  startTime: number;
  duration: number;
  velocity: number;
  muted?: boolean;
  probability?: number;
  velocityDeviation?: number;
};

type FoundMidiClip = {
  clip: any;
  clipName: string;
  trackName: string;
  startTime: number;
  notes: AbletonMidiNote[];
};

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

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
    return [28, 33, 38, 43]; // E1 A1 D2 G2
  }

  return [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
}

function collectPropertyNames(object: unknown): string[] {
  const properties = new Set<string>();
  let current: any = object;

  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      properties.add(name);
    }

    current = Object.getPrototypeOf(current);
  }

  return Array.from(properties).sort();
}

function safeRead(object: any, property: string): unknown {
  try {
    return object[property];
  } catch {
    return undefined;
  }
}

function looksLikeMidiClip(object: any): boolean {
  const notes = safeRead(object, "notes");

  return (
    Array.isArray(notes) &&
    notes.some(
      (note) =>
        note &&
        typeof note.pitch === "number" &&
        typeof note.startTime === "number" &&
        typeof note.duration === "number"
    )
  );
}

function findMidiClips(root: unknown): FoundMidiClip[] {
  const found: FoundMidiClip[] = [];
  const seen = new WeakSet<object>();

  const skipProperties = new Set([
    "parent",
    "objectRegistry",
    "dataModel",
    "handle",
    "constructor",
  ]);

  function visit(value: unknown, depth: number, currentTrackName: string) {
    if (!value || depth > 8) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1, currentTrackName);
      }
      return;
    }

    if (typeof value !== "object") return;

    const object = value as any;

    if (seen.has(object)) return;
    seen.add(object);

    const className = object.constructor?.name ?? "";

    let trackName = currentTrackName;

    if (/track/i.test(className)) {
      const possibleName = safeRead(object, "name");

      if (typeof possibleName === "string" && possibleName.trim()) {
        trackName = possibleName;
      }
    }

    if (looksLikeMidiClip(object)) {
      const clipNameRaw = safeRead(object, "name");
      const clipName =
        typeof clipNameRaw === "string" && clipNameRaw.trim()
          ? clipNameRaw
          : "MIDI Clip";

      const notes = safeRead(object, "notes") as AbletonMidiNote[];

      found.push({
        clip: object,
        clipName,
        trackName: trackName || clipName,
        startTime: numberOrZero(safeRead(object, "startTime")),
        notes,
      });

      return;
    }

    const propertyNames = collectPropertyNames(object);

    for (const property of propertyNames) {
      if (skipProperties.has(property)) continue;

      const child = safeRead(object, property);

      if (!child) continue;
      if (typeof child === "function") continue;

      visit(child, depth + 1, trackName);
    }
  }

  visit(root, 0, "");

  return found;
}

function buildExportData(song: any, clips: FoundMidiClip[]) {
  const tracksByName = new Map<
    string,
    {
      name: string;
      kind: "guitar" | "bass";
      tuning: number[];
      notes: {
        pitch: number;
        start: number;
        duration: number;
        velocity: number;
      }[];
    }
  >();

  for (const clip of clips) {
    const trackName = clip.trackName || clip.clipName;
    const kind = inferTrackKind(trackName);

    if (!tracksByName.has(trackName)) {
      tracksByName.set(trackName, {
        name: trackName,
        kind,
        tuning: getTuning(kind),
        notes: [],
      });
    }

    const targetTrack = tracksByName.get(trackName)!;

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

export const activate = (activation: Activation) => {
  const context = initialize(activation, "1.0.0");

  const storageDirectory =
    context.environment.storageDirectory ??
    context.environment.tempDirectory ??
    path.join(process.cwd(), ".runtime", "storage");

  console.log(`[${EXTENSION_ID}] activated`);
  console.log(`[${EXTENSION_ID}] storageDirectory: ${storageDirectory}`);

  context.commands.registerCommand(
    `${EXTENSION_ID}.export-all-midi-to-gp5`,
    async () => {
      console.log(`[${EXTENSION_ID}] export all MIDI clips to GP5`);

      await fs.mkdir(storageDirectory, { recursive: true });

      const song = context.application.song as any;
      const clips = findMidiClips(song);

      console.log(`[${EXTENSION_ID}] MIDI clips found: ${clips.length}`);

      const exportData = buildExportData(song, clips);

      const baseName = sanitizeFileName("Ableton_Live_Export");
      const jsonPath = path.join(storageDirectory, `${baseName}.json`);
      const gp5Path = path.join(storageDirectory, `${baseName}.gp5`);

      await fs.writeFile(jsonPath, JSON.stringify(exportData, null, 2), "utf-8");

      console.log(`[${EXTENSION_ID}] JSON written: ${jsonPath}`);
      console.log(`[${EXTENSION_ID}] GP5 target: ${gp5Path}`);
      console.log(`[${EXTENSION_ID}] exported tracks: ${exportData.tracks.length}`);

      const extensionRoot = process.cwd();
      const repoRoot = path.resolve(extensionRoot, "..");

      const pythonPath =
        process.env.PYTHON_PATH ??
        path.join(repoRoot, ".venv", "Scripts", "python.exe");

      const converterPath = path.join(
        repoRoot,
        "converter",
        "ableton_to_gp5.py"
      );

      console.log(`[${EXTENSION_ID}] python: ${pythonPath}`);
      console.log(`[${EXTENSION_ID}] converter: ${converterPath}`);

      const { stdout, stderr } = await execFileAsync(
        pythonPath,
        [converterPath, jsonPath, gp5Path],
        {
          cwd: repoRoot,
        }
      );

      if (stdout.trim()) {
        console.log(`[${EXTENSION_ID}] converter stdout:\n${stdout}`);
      }

      if (stderr.trim()) {
        console.error(`[${EXTENSION_ID}] converter stderr:\n${stderr}`);
      }

      console.log(`[${EXTENSION_ID}] GP5 written: ${gp5Path}`);
    }
  );

  context.ui.registerContextMenuAction(
    "MidiClip",
    "Ableton Live to GP5 - Export ALL MIDI Clips to GP5",
    `${EXTENSION_ID}.export-all-midi-to-gp5`
  );

  context.ui.registerContextMenuAction(
    "MidiTrack",
    "Ableton Live to GP5 - Export ALL MIDI Clips to GP5",
    `${EXTENSION_ID}.export-all-midi-to-gp5`
  );

  console.log(`[${EXTENSION_ID}] context menu registered`);
};