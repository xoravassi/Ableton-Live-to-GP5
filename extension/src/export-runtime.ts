import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import converterSource from "../python/ableton_to_gp5.py";
import type {
  ConversionReport,
  ExportReport,
  VersionedExportPaths,
} from "./export-types.js";

const execFileAsync = promisify(execFile);
const EXTENSION_ID = "ableton-live-to-gp5";

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function createVersionedExportPaths(
  storageDirectory: string,
  baseName: string,
  fallbackBaseName: string
): Promise<VersionedExportPaths> {
  const safeBaseName = sanitizeFileName(baseName || fallbackBaseName);

  for (let version = 1; version <= 999; version += 1) {
    const suffix = String(version).padStart(3, "0");
    const stem = `${safeBaseName}_v${suffix}`;

    const jsonPath = path.join(storageDirectory, `${stem}.json`);
    const gp5Path = path.join(storageDirectory, `${stem}.gp5`);
    const reportPath = path.join(storageDirectory, `${stem}.report.json`);
    const conversionReportPath = path.join(
      storageDirectory,
      `${stem}.conversion-report.json`
    );

    const alreadyExists =
      (await fileExists(jsonPath)) ||
      (await fileExists(gp5Path)) ||
      (await fileExists(reportPath)) ||
      (await fileExists(conversionReportPath));

    if (!alreadyExists) {
      return {
        stem,
        jsonPath,
        gp5Path,
        reportPath,
        conversionReportPath,
      };
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = `${safeBaseName}_${timestamp}`;

  return {
    stem,
    jsonPath: path.join(storageDirectory, `${stem}.json`),
    gp5Path: path.join(storageDirectory, `${stem}.gp5`),
    reportPath: path.join(storageDirectory, `${stem}.report.json`),
    conversionReportPath: path.join(
      storageDirectory,
      `${stem}.conversion-report.json`
    ),
  };
}

export async function resolvePythonPath(repoRoot: string): Promise<string> {
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

export async function materializeConverter(
  tempDirectory: string
): Promise<string> {
  await fs.mkdir(tempDirectory, { recursive: true });

  const converterPath = path.join(tempDirectory, "ableton_to_gp5.py");

  await fs.writeFile(converterPath, converterSource, "utf-8");

  return converterPath;
}

export async function checkPythonEnvironment(
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

export async function runConverter(
  pythonPath: string,
  converterPath: string,
  jsonPath: string,
  gp5Path: string,
  storageDirectory: string
) {
  return execFileAsync(pythonPath, [converterPath, jsonPath, gp5Path], {
    cwd: storageDirectory,
  });
}

export async function readConversionReport(
  reportPath: string
): Promise<ConversionReport> {
  const raw = await fs.readFile(reportPath, "utf-8");
  const report = JSON.parse(raw) as Partial<ConversionReport>;
  const numericFields = [
    "tracksInput",
    "tracksWritten",
    "notesInput",
    "notesWritten",
    "notesSkipped",
    "measuresWritten",
  ] as const;

  for (const field of numericFields) {
    if (!Number.isFinite(report[field])) {
      throw new Error(`Invalid conversion report field: ${field}`);
    }
  }

  if (!Array.isArray(report.tracks) || !Array.isArray(report.warnings)) {
    throw new Error("Invalid conversion report structure.");
  }

  return report as ConversionReport;
}

export async function openOutputFolder(
  outputPath: string,
  report: ExportReport
) {
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

export async function writeReport(
  reportPath: string,
  report: ExportReport
) {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log(`[${EXTENSION_ID}] report written: ${reportPath}`);
}
