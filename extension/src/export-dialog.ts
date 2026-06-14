import * as path from "node:path";
import exportDialogInterface from "./interface.html";
import exportResultInterface from "./result-interface.html";
import type {
  ExportDialogResult,
  ExportDialogSubmission,
  ExportDialogTrack,
  ExportReport,
  ExportResultSummary,
  ExportResultDialogResult,
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

export async function showExportDialog(
  context: any,
  suggestedName: string,
  tracks: ExportDialogTrack[],
  report: ExportReport
): Promise<ExportDialogSubmission | null> {
  const dialogHtml = createExportDialogHtml(suggestedName, tracks, report);
  const dialogUrl = `data:text/html;charset=utf-8,${encodeURIComponent(dialogHtml)}`;
  const rawResult = await context.ui.showModalDialog(dialogUrl, 760, 680);

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
  const dialogUrl = `data:text/html;charset=utf-8,${encodeURIComponent(dialogHtml)}`;
  const rawResult = await context.ui.showModalDialog(dialogUrl, 520, 300);

  if (!rawResult) return false;

  const result = JSON.parse(rawResult) as ExportResultDialogResult;

  return result.action === "open-folder";
}
