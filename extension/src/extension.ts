import { initialize, MidiClip, type Handle } from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const EXTENSION_ID = "ableton-live-to-gp5";

type Activation = Parameters<typeof initialize>[0];

function collectPropertyNames(object: unknown): string[] {
  const properties = new Set<string>();

  let current = object;

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
    const value = object[property];

    if (typeof value === "function") {
      return "[function]";
    }

    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        sample: value.slice(0, 5),
      };
    }

    if (value && typeof value === "object") {
      return {
        type: value.constructor?.name ?? "object",
        keys: Object.keys(value),
      };
    }

    return value;
  } catch (error) {
    return `[error reading property: ${String(error)}]`;
  }
}

export const activate = (activation: Activation) => {
  const context = initialize(activation, "1.0.0");

  const storageDirectory =
    context.environment.storageDirectory ?? context.environment.tempDirectory;

  if (!storageDirectory) {
    throw new Error(`[${EXTENSION_ID}] No writable directory available.`);
  }

  console.log(`[${EXTENSION_ID}] activated`);
  console.log(`[${EXTENSION_ID}] storageDirectory: ${storageDirectory}`);

  context.commands.registerCommand(
    `${EXTENSION_ID}.inspect-midi-clip`,
    async (handle) => {
      console.log(`[${EXTENSION_ID}] inspect MIDI clip`);

      const clip = context.getObjectFromHandle(handle as Handle, MidiClip);
      const clipAny = clip as any;

      const propertyNames = collectPropertyNames(clip);

      const likelyMidiProperties = propertyNames.filter((name) =>
        /note|midi|clip|start|duration|loop|time|length|pitch|velocity/i.test(name)
      );

      const likelyValues: Record<string, unknown> = {};

      for (const property of likelyMidiProperties) {
        likelyValues[property] = safeRead(clipAny, property);
      }

      const debugData = {
        exportedAt: new Date().toISOString(),
        song: {
          tempo: context.application.song.tempo,
        },
        clip: {
          className: clip.constructor?.name,
          name: safeRead(clipAny, "name"),
          allProperties: propertyNames,
          likelyMidiProperties,
          likelyValues,
        },
      };

      const outputPath = path.join(
        storageDirectory,
        "ableton-live-to-gp5-midi-clip-debug.json"
      );

      await fs.writeFile(
        outputPath,
        JSON.stringify(debugData, null, 2),
        "utf-8"
      );

      console.log(`[${EXTENSION_ID}] debug JSON written: ${outputPath}`);
    }
  );

  context.ui.registerContextMenuAction(
    "MidiClip",
    "Ableton Live to GP5 - Inspect MIDI Clip",
    `${EXTENSION_ID}.inspect-midi-clip`
  );
};