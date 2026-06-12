import { initialize } from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTENSION_ID = "ableton-live-to-gp5";
const EXPORT_BASE_NAME = "Ableton_Live_Export";

const IGNORE_MUTED_TRACKS = true;
const IGNORE_MUTED_CLIPS = true;

// Les pistes drums/kick/snare/etc. ne sont PAS supprimées.
// Elles sont exportées dans Guitar Pro, mais silencieuses.
const MUTE_PERCUSSION_TRACKS_IN_GP5 = true;

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
  mutedInGp5?: boolean;
};

type ExportTrack = {
  name: string;
  kind: "guitar" | "bass";
  tuning: number[];
  muted?: boolean;
  notes: {
    pitch: number;
    start: number;
    duration: number;
    velocity: number;
  }[];
};

type ExportReport = {
  exportedAt: string;
  mode: "arrangement-only";
  tracksSeen: number;
  midiTracksSeen: number;
  tracksIgnored: { name: string; reason: string }[];
  tracksMutedInGp5: { name: string; reason: string }[];
  clipsExported: number;
  notesExported: number;
  outputJson?: string;
  outputGp5?: string;
  warnings: string[];
  error?: string;
  pythonExecutable?: string;
  pythonCheckOutput?: string;
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

function isMidiTrack(track: any): boolean {
  return track?.constructor?.name === "MidiTrack";
}

function isMidiClip(clip: any): boolean {
  return clip?.constructor?.name === "MidiClip" && Array.isArray(clip.notes);
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

function findArrangementMidiClips(
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

function buildExportData(song: any, clips: FoundMidiClip[], report: ExportReport) {
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

async function resolvePythonPath(repoRoot: string): Promise<string> {
  const localPython = path.join(repoRoot, ".venv", "Scripts", "python.exe");

  if (process.env.PYTHON_PATH) {
    return process.env.PYTHON_PATH;
  }

  try {
    await fs.access(localPython);
    return localPython;
  } catch {
    return "python";
  }
}

async function writeReport(storageDirectory: string, report: ExportReport) {
  const reportPath = path.join(storageDirectory, `${EXPORT_BASE_NAME}.report.json`);

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log(`[${EXTENSION_ID}] report written: ${reportPath}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveConverterPath(storageDirectory: string): Promise<string> {
  const extensionId = path.basename(storageDirectory);

  const candidates = [
    // Dev mode : repo/extension/python/ableton_to_gp5.py
    path.join(process.cwd(), "python", "ableton_to_gp5.py"),

    // Fallback ancien dev mode : repo/converter/ableton_to_gp5.py
    path.join(process.cwd(), "..", "converter", "ableton_to_gp5.py"),

    // Packaged extension install path on Windows:
    // C:\Users\...\AppData\Local\Ableton\Extensions\<extensionId>\python\...
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Ableton",
      "Extensions",
      extensionId,
      "python",
      "ableton_to_gp5.py"
    ),

    // Same idea, inferred from storageDirectory:
    // storageDirectory = ...\Ableton\Extensions Data\<extensionId>
    // extensionPath     = ...\Ableton\Extensions\<extensionId>
    path.join(
      path.dirname(path.dirname(storageDirectory)),
      "Extensions",
      extensionId,
      "python",
      "ableton_to_gp5.py"
    ),
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);

    if (await fileExists(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    [
      "Unable to find bundled Python converter.",
      "Checked paths:",
      ...candidates.map((candidate) => `- ${path.resolve(candidate)}`),
    ].join("\n")
  );
}

async function openOutputFolder(outputPath: string, report: ExportReport) {
  try {
    const normalizedOutputPath = path.normalize(outputPath);
    const outputFolder = path.dirname(normalizedOutputPath);

    await fs.access(normalizedOutputPath);

    if (process.platform === "win32") {
      const child = spawn("explorer.exe", [outputFolder], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });

      child.unref();
      return;
    }

    if (process.platform === "darwin") {
      const child = spawn("open", [outputFolder], {
        detached: true,
        stdio: "ignore",
      });

      child.unref();
      return;
    }

    const child = spawn("xdg-open", [outputFolder], {
      detached: true,
      stdio: "ignore",
    });

    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    report.warnings.push(
      `GP5 export succeeded, but opening the output folder failed: ${message}`
    );

    console.warn(
      `[${EXTENSION_ID}] GP5 export succeeded, but opening output folder failed: ${message}`
    );
  }
}


async function checkPythonEnvironment(
  pythonPath: string,
  report: ExportReport
) {
  const script = [
    "import sys",
    "print('Python executable: ' + sys.executable)",
    "import guitarpro",
    "print('PyGuitarPro module: ' + getattr(guitarpro, '__file__', 'unknown'))",
  ].join("; ");

  try {
    const { stdout, stderr } = await execFileAsync(
      pythonPath,
      ["-c", script],
      {
        timeout: 10_000,
      }
    );

    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");

    report.pythonExecutable = pythonPath;
    report.pythonCheckOutput = output;

    if (output) {
      console.log(`[${EXTENSION_ID}] Python check:\n${output}`);
    }
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const message = error instanceof Error ? error.message : String(error);

    const details = [stdout.trim(), stderr.trim(), message.trim()]
      .filter(Boolean)
      .join("\n");

    throw new Error(
      [
        "Python environment check failed.",
        "",
        "Ableton Live to GP5 requires Python with PyGuitarPro installed.",
        "",
        "Fix:",
        "  python -m pip install PyGuitarPro",
        "",
        "Then verify:",
        "  python -c \"import guitarpro; print(guitarpro.__file__)\"",
        "",
        "Details:",
        details,
      ].join("\n")
    );
  }
}
export const activate = async (activation: Activation) => {
  const context = initialize(activation, "1.0.0");

  const storageDirectory = path.resolve(
    context.environment.storageDirectory ??
      context.environment.tempDirectory ??
      path.join(process.cwd(), ".runtime", "storage")
  );

  console.log(`[${EXTENSION_ID}] activated`);
  console.log(`[${EXTENSION_ID}] storageDirectory: ${storageDirectory}`);

  context.commands.registerCommand(
    `${EXTENSION_ID}.export-arrangement-midi-to-gp5`,
    async () => {
      const report: ExportReport = {
        exportedAt: new Date().toISOString(),
        mode: "arrangement-only",
        tracksSeen: 0,
        midiTracksSeen: 0,
        tracksIgnored: [],
        tracksMutedInGp5: [],
        clipsExported: 0,
        notesExported: 0,
        warnings: [],
      };

      try {
        console.log(`[${EXTENSION_ID}] export arrangement MIDI to GP5`);

        await fs.mkdir(storageDirectory, { recursive: true });

        const song = context.application.song as any;
        const clips = findArrangementMidiClips(song, report);
        const exportData = buildExportData(song, clips, report);

        const baseName = sanitizeFileName(EXPORT_BASE_NAME);
        const jsonPath = path.join(storageDirectory, `${baseName}.json`);
        const gp5Path = path.join(storageDirectory, `${baseName}.gp5`);

        report.outputJson = jsonPath;
        report.outputGp5 = gp5Path;

        await fs.writeFile(jsonPath, JSON.stringify(exportData, null, 2), "utf-8");

        console.log(`[${EXTENSION_ID}] JSON written: ${jsonPath}`);
        console.log(`[${EXTENSION_ID}] clips exported: ${report.clipsExported}`);
        console.log(`[${EXTENSION_ID}] notes exported: ${report.notesExported}`);

        const extensionRoot = process.cwd();
        const repoRoot = path.resolve(extensionRoot, "..");

        const pythonPath = await resolvePythonPath(repoRoot);
        const converterPath = await resolveConverterPath(storageDirectory);

        console.log(`[${EXTENSION_ID}] python: ${pythonPath}`);
        console.log(`[${EXTENSION_ID}] converter: ${converterPath}`);
        console.log(`[${EXTENSION_ID}] output gp5: ${gp5Path}`);

        await checkPythonEnvironment(pythonPath, report);

        const { stdout, stderr } = await execFileAsync(
          pythonPath,
          [converterPath, jsonPath, gp5Path],
          {
            cwd: storageDirectory,
          }
        );

        if (stdout.trim()) {
          console.log(`[${EXTENSION_ID}] converter stdout:\n${stdout}`);
        }

        if (stderr.trim()) {
          console.error(`[${EXTENSION_ID}] converter stderr:\n${stderr}`);
        }

        console.log(`[${EXTENSION_ID}] GP5 written: ${gp5Path}`);

        await openOutputFolder(gp5Path, report);

        await writeReport(storageDirectory, report);

      } catch (error) {
        const message =
          error instanceof Error ? error.stack ?? error.message : String(error);

        report.error = message;

        console.error(`[${EXTENSION_ID}] export failed:\n${message}`);

        try {
          await fs.mkdir(storageDirectory, { recursive: true });
          await writeReport(storageDirectory, report);
        } catch {
          // Nothing else to do.
        }
      }
    }
  );

  await context.ui.registerContextMenuAction(
    "MidiClip",
    "Ableton Live to GP5 - Export Arrangement to GP5",
    `${EXTENSION_ID}.export-arrangement-midi-to-gp5`
  );

  await context.ui.registerContextMenuAction(
    "MidiTrack",
    "Ableton Live to GP5 - Export Arrangement to GP5",
    `${EXTENSION_ID}.export-arrangement-midi-to-gp5`
  );

  console.log(`[${EXTENSION_ID}] context menu registered`);
};