import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import exportDialogInterface from "./interface.html";
import exportResultInterface from "./result-interface.html";
import welcomeDialogInterface from "./welcome-interface.html";
import type {
  DependencyStatus,
  ExportDialogResult,
  ExportDialogSubmission,
  ExportDialogTrack,
  ExportReport,
  ExportResultSummary,
  ExportResultDialogResult,
  WelcomeDialogResult,
} from "./export-types.js";

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function getBaseNameFromPathOrName(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  if (!trimmed) return null;

  const parsed = path.parse(trimmed);
  const candidate = parsed.name || trimmed;

  if (!candidate) return null;

  return sanitizeFileName(candidate);
}

function createExportDialogHtml(
  suggestedName: string,
  tracks: ExportDialogTrack[],
  report: ExportReport
): string {
  const payload = encodeURIComponent(
    JSON.stringify({
      suggestedName,
      tracks,
      counts: {
        exportedTracks: tracks.filter(
          (track) => track.status === "exported" || track.status === "muted"
        ).length,
        clips: report.clipsExported,
        notes: report.notesExported,
      },
    })
  );
  const dataMarker = "__ABLETON_TO_GP5_DIALOG_DATA__";

  if (!exportDialogInterface.includes(dataMarker)) {
    throw new Error("Export dialog data marker is missing from interface.html.");
  }

  return exportDialogInterface.replace(dataMarker, payload);
}

async function showHtmlDialog(
  context: any,
  tempDirectory: string,
  fileName: string,
  html: string,
  width: number,
  height: number
): Promise<string> {
  await fs.mkdir(tempDirectory, { recursive: true });
  const htmlPath = path.join(tempDirectory, fileName);
  await fs.writeFile(htmlPath, html, "utf-8");
  return context.ui.showModalDialog(pathToFileURL(htmlPath).href, width, height);
}

export async function showWelcomeDialog(
  context: any,
  tempDirectory: string,
  status: DependencyStatus
): Promise<WelcomeDialogResult> {
  const dataMarker = "__ABLETON_TO_GP5_WELCOME_DATA__";

  if (!welcomeDialogInterface.includes(dataMarker)) {
    throw new Error(
      "Welcome dialog data marker is missing from welcome-interface.html."
    );
  }

  const html = welcomeDialogInterface.replace(
    dataMarker,
    encodeURIComponent(JSON.stringify(status))
  );
  const rawResult = await showHtmlDialog(
    context,
    tempDirectory,
    "ableton-to-gp5-welcome.html",
    html,
    620,
    560
  );

  if (!rawResult) return { action: "cancel" };
  return JSON.parse(rawResult) as WelcomeDialogResult;
}

export async function showExportDialog(
  context: any,
  tempDirectory: string,
  suggestedName: string,
  tracks: ExportDialogTrack[],
  report: ExportReport
): Promise<ExportDialogSubmission | null> {
  const dialogHtml = createExportDialogHtml(suggestedName, tracks, report);
  const rawResult = await showHtmlDialog(
    context,
    tempDirectory,
    "ableton-to-gp5-export.html",
    dialogHtml,
    860,
    800
  );

  if (!rawResult) return null;

  const result = JSON.parse(rawResult) as ExportDialogResult;

  if (result.action !== "export") return null;

  const name = getBaseNameFromPathOrName(result.name);

  if (!name) return null;

  return {
    name,
    trackSelections: result.trackSelections ?? {},
    plannedTracks: result.plannedTracks ?? [],
  };
}

export async function showExportResultDialog(
  context: any,
  tempDirectory: string,
  gp5Path: string,
  summary: ExportResultSummary
): Promise<boolean> {
  const dataMarker = "__ABLETON_TO_GP5_RESULT_DATA__";

  if (!exportResultInterface.includes(dataMarker)) {
    throw new Error(
      "Export result data marker is missing from result-interface.html."
    );
  }

  const payload = encodeURIComponent(
    JSON.stringify({
      fileName: path.basename(gp5Path),
      folder: path.dirname(gp5Path),
      ...summary,
    })
  );
  const dialogHtml = exportResultInterface.replace(dataMarker, payload);
  const rawResult = await showHtmlDialog(
    context,
    tempDirectory,
    "ableton-to-gp5-result.html",
    dialogHtml,
    560,
    460
  );

  if (!rawResult) return false;

  const result = JSON.parse(rawResult) as ExportResultDialogResult;

  return result.action === "open-folder";
}
