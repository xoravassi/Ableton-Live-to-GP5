import { initialize } from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildExportData, buildExportDialogTracks } from "./export-data.js";
import {
  showExportDialog,
  showExportResultDialog,
} from "./export-dialog.js";
import {
  checkPythonEnvironment,
  createVersionedExportPaths,
  materializeConverter,
  openOutputFolder,
  resolvePythonPath,
  runConverter,
  writeReport,
} from "./export-runtime.js";
import type { ExportReport } from "./export-types.js";
import { findArrangementMidiClips } from "./midi-extraction.js";

const EXTENSION_ID = "ableton-live-to-gp5";
const EXPORT_BASE_NAME = "Ableton_Live_Export";
const COMMAND_ID = `${EXTENSION_ID}.export-arrangement-midi-to-gp5`;
const COMMAND_LABEL = "Export to GP5";

type Activation = Parameters<typeof initialize>[0];

function createExportReport(): ExportReport {
  return {
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
}

export const activate = async (activation: Activation) => {
  const context = initialize(activation, "1.0.0");

  const storageDirectory = path.resolve(
    context.environment.storageDirectory ??
      context.environment.tempDirectory ??
      path.join(process.cwd(), ".runtime", "storage")
  );
  const tempDirectory = path.resolve(
    context.environment.tempDirectory ?? storageDirectory
  );

  console.log(`[${EXTENSION_ID}] activated`);
  console.log(`[${EXTENSION_ID}] storageDirectory: ${storageDirectory}`);

  context.commands.registerCommand(COMMAND_ID, async () => {
    const report = createExportReport();
    let reportPath = path.join(
      storageDirectory,
      `${EXPORT_BASE_NAME}_error.report.json`
    );

    try {
      console.log(`[${EXTENSION_ID}] export arrangement MIDI to GP5`);

      await fs.mkdir(storageDirectory, { recursive: true });

      const song = context.application.song as any;
      const clips = findArrangementMidiClips(song, report);
      const exportData = buildExportData(song, clips, report);
      const dialogTracks = buildExportDialogTracks(
        song,
        clips,
        exportData,
        report
      );
      const exportBaseName = await showExportDialog(
        context,
        EXPORT_BASE_NAME,
        dialogTracks,
        report
      );

      if (!exportBaseName) {
        console.log(`[${EXTENSION_ID}] export cancelled`);
        return;
      }

      report.exportBaseName = exportBaseName;
      exportData.song.title = exportBaseName;

      const exportPaths = await createVersionedExportPaths(
        storageDirectory,
        exportBaseName,
        EXPORT_BASE_NAME
      );
      const { jsonPath, gp5Path } = exportPaths;

      reportPath = exportPaths.reportPath;
      report.outputJson = jsonPath;
      report.outputGp5 = gp5Path;

      await fs.writeFile(
        jsonPath,
        JSON.stringify(exportData, null, 2),
        "utf-8"
      );

      console.log(`[${EXTENSION_ID}] export name: ${exportBaseName}`);
      console.log(`[${EXTENSION_ID}] export stem: ${exportPaths.stem}`);
      console.log(`[${EXTENSION_ID}] JSON written: ${jsonPath}`);
      console.log(`[${EXTENSION_ID}] clips exported: ${report.clipsExported}`);
      console.log(`[${EXTENSION_ID}] notes exported: ${report.notesExported}`);

      if (report.notesExported === 0) {
        report.warnings.push(
          "No MIDI notes were exported. GP5 conversion skipped to avoid creating an empty export."
        );

        console.warn(
          `[${EXTENSION_ID}] No MIDI notes exported. GP5 conversion skipped.`
        );

        await writeReport(reportPath, report);
        await openOutputFolder(jsonPath, report);
        return;
      }

      const extensionRoot = process.cwd();
      const repoRoot = path.resolve(extensionRoot, "..");
      const pythonPath = await resolvePythonPath(repoRoot);
      const converterPath = await materializeConverter(tempDirectory);

      console.log(`[${EXTENSION_ID}] extensionRoot: ${extensionRoot}`);
      console.log(`[${EXTENSION_ID}] storageDirectory: ${storageDirectory}`);
      console.log(`[${EXTENSION_ID}] python: ${pythonPath}`);
      console.log(`[${EXTENSION_ID}] converter: ${converterPath}`);
      console.log(`[${EXTENSION_ID}] output gp5: ${gp5Path}`);

      await checkPythonEnvironment(pythonPath, report);

      const { stdout, stderr } = await runConverter(
        pythonPath,
        converterPath,
        jsonPath,
        gp5Path,
        storageDirectory
      );

      if (stdout.trim()) {
        console.log(`[${EXTENSION_ID}] converter stdout:\n${stdout}`);
      }

      if (stderr.trim()) {
        console.error(`[${EXTENSION_ID}] converter stderr:\n${stderr}`);
      }

      console.log(`[${EXTENSION_ID}] GP5 written: ${gp5Path}`);

      let shouldOpenOutputFolder = true;

      try {
        shouldOpenOutputFolder = await showExportResultDialog(
          context,
          gp5Path,
          exportData.tracks.length,
          report.notesExported
        );
      } catch (dialogError) {
        const dialogMessage =
          dialogError instanceof Error
            ? dialogError.message
            : String(dialogError);

        report.warnings.push(
          `GP5 export succeeded, but the result dialog failed: ${dialogMessage}`
        );
      }

      if (shouldOpenOutputFolder) {
        await openOutputFolder(gp5Path, report);
      }

      await writeReport(reportPath, report);
    } catch (error) {
      const message =
        error instanceof Error ? error.stack ?? error.message : String(error);

      report.error = message;

      console.error(`[${EXTENSION_ID}] export failed:\n${message}`);

      try {
        await fs.mkdir(storageDirectory, { recursive: true });
        await writeReport(reportPath, report);
        await openOutputFolder(reportPath, report);
      } catch {
        // Nothing else to do.
      }
    }
  });

  await context.ui.registerContextMenuAction(
    "MidiClip",
    COMMAND_LABEL,
    COMMAND_ID
  );

  await context.ui.registerContextMenuAction(
    "MidiTrack",
    COMMAND_LABEL,
    COMMAND_ID
  );

  console.log(`[${EXTENSION_ID}] context menu registered`);
};
