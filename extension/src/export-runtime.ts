import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import converterSource from "../python/ableton_to_gp5.py";
import type {
  ConversionReport,
  DependencyStatus,
  ExportReport,
  VersionedExportPaths,
} from "./export-types.js";

const execFileAsync = promisify(execFile);
const EXTENSION_ID = "ableton-live-to-gp5";

export type PythonCommand = {
  executable: string;
  prefixArgs: string[];
  label: string;
};

export type DependencyInspection = {
  status: DependencyStatus;
  python?: PythonCommand;
};

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

function quoteCommandPart(value: string): string {
  return /\s|"/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function displayCommand(command: PythonCommand, args: string[]): string {
  return [command.executable, ...command.prefixArgs, ...args]
    .map(quoteCommandPart)
    .join(" ");
}

async function discoverWindowsPythonCommands(): Promise<PythonCommand[]> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return [];

  const root = path.join(process.env.LOCALAPPDATA, "Programs", "Python");

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^Python/i.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name))
      .map((entry) => {
        const executable = path.join(root, entry.name, "python.exe");
        return {
          executable,
          prefixArgs: [],
          label: executable,
        };
      });
  } catch {
    return [];
  }
}

async function pythonCandidates(repoRoot: string): Promise<PythonCommand[]> {
  const candidates: PythonCommand[] = [];
  const add = (executable: string, prefixArgs: string[] = []) => {
    const label = [executable, ...prefixArgs].join(" ");
    if (!candidates.some((candidate) => candidate.label === label)) {
      candidates.push({ executable, prefixArgs, label });
    }
  };

  if (process.env.PYTHON_PATH) add(process.env.PYTHON_PATH);

  add(
    path.join(
      repoRoot,
      ".venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python"
    )
  );

  for (const command of await discoverWindowsPythonCommands()) {
    add(command.executable, command.prefixArgs);
  }

  if (process.platform === "win32") add("py", ["-3"]);
  add("python");
  add("python3");

  return candidates;
}

async function inspectCandidate(
  command: PythonCommand
): Promise<
  | {
      pythonVersion: string;
      packageVersion?: string;
      packageInstalled: boolean;
    }
  | null
> {
  const script = [
    "import importlib.metadata, importlib.util, json, sys",
    "installed = importlib.util.find_spec('guitarpro') is not None",
    "print(json.dumps({'pythonVersion': sys.version.split()[0], 'packageInstalled': installed, 'packageVersion': importlib.metadata.version('PyGuitarPro') if installed else None}))",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync(
      command.executable,
      [...command.prefixArgs, "-c", script],
      { timeout: 8_000 }
    );
    const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!lastLine) return null;
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

export async function inspectPythonEnvironment(
  repoRoot: string,
  previousError?: string
): Promise<DependencyInspection> {
  let missingPackage:
    | {
        command: PythonCommand;
        pythonVersion: string;
      }
    | undefined;

  for (const command of await pythonCandidates(repoRoot)) {
    const result = await inspectCandidate(command);
    if (!result) continue;

    if (!result.packageInstalled) {
      missingPackage ??= {
        command,
        pythonVersion: result.pythonVersion,
      };
      continue;
    }

    return {
      python: command,
      status: {
        state: "ready",
        pythonLabel: command.label,
        pythonVersion: result.pythonVersion,
        packageVersion: result.packageVersion,
        title: "Ready to create a GP5 file",
        description:
          "Python and PyGuitarPro are installed. Continue to review the detected tracks and tablature mapping.",
        canInstall: false,
        commands: [],
      },
    };
  }

  if (missingPackage) {
    const { command, pythonVersion } = missingPackage;

    return {
      python: command,
      status: {
        state: previousError ? "error" : "missing-package",
        pythonLabel: command.label,
        pythonVersion,
        title: previousError
          ? "Dependency installation failed"
          : "PyGuitarPro is missing",
        description:
          "Python is available, but the GP5 writer package still needs to be installed.",
        details: previousError,
        canInstall: true,
        commands: [
          displayCommand(command, [
            "-m",
            "pip",
            "install",
            "--upgrade",
            "PyGuitarPro",
          ]),
        ],
      },
    };
  }

  const windowsCommands =
    process.platform === "win32"
      ? [
          "winget install --exact --id Python.Python.3.12 --source winget --accept-package-agreements --accept-source-agreements",
          "py -3 -m pip install --upgrade PyGuitarPro",
        ]
      : [];

  return {
    status: {
      state: previousError ? "error" : "missing-python",
      title: previousError
        ? "Dependency installation failed"
        : "Python is missing",
      description:
        process.platform === "win32"
          ? "Python and PyGuitarPro are required to write Guitar Pro 5 files."
          : "Install Python 3 and PyGuitarPro, then run the check again.",
      details: previousError,
      canInstall: windowsCommands.length > 0,
      commands: windowsCommands,
    },
  };
}

export async function installMissingDependencies(
  repoRoot: string,
  inspection: DependencyInspection,
  update?: (text: string, progress?: number) => Promise<void>
): Promise<DependencyInspection> {
  try {
    let current = inspection;

    if (!current.python) {
      if (process.platform !== "win32") {
        throw new Error(
          "Automatic Python installation is currently supported on Windows only."
        );
      }

      await update?.("Installing Python with Windows Package Manager...", 20);
      await execFileAsync(
        "winget",
        [
          "install",
          "--exact",
          "--id",
          "Python.Python.3.12",
          "--source",
          "winget",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
        { timeout: 10 * 60_000 }
      );

      await update?.("Detecting the new Python installation...", 65);
      current = await inspectPythonEnvironment(repoRoot);
      if (!current.python) {
        throw new Error(
          "Python was installed, but this Live process cannot detect it yet. Restart Ableton Live and try again."
        );
      }
    }

    await update?.("Installing PyGuitarPro and its dependencies...", 75);
    await execFileAsync(
      current.python.executable,
      [
        ...current.python.prefixArgs,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "PyGuitarPro",
      ],
      { timeout: 5 * 60_000 }
    );

    await update?.("Verifying the Python environment...", 95);
    return await inspectPythonEnvironment(repoRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return inspectPythonEnvironment(repoRoot, message);
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
  python: PythonCommand,
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
      python.executable,
      [...python.prefixArgs, "-c", script],
      {
        timeout: 10_000,
      }
    );

    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");

    report.pythonExecutable = python.label;
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
  python: PythonCommand,
  converterPath: string,
  jsonPath: string,
  gp5Path: string,
  storageDirectory: string
) {
  return execFileAsync(
    python.executable,
    [...python.prefixArgs, converterPath, jsonPath, gp5Path],
    {
      cwd: storageDirectory,
    }
  );
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
