export type AbletonMidiNote = {
  id?: number;
  pitch: number;
  startTime: number;
  duration: number;
  velocity: number;
  muted?: boolean;
  probability?: number;
  velocityDeviation?: number;
};

export type FoundMidiClip = {
  clip: any;
  clipName: string;
  trackName: string;
  startTime: number;
  notes: AbletonMidiNote[];
  mutedInGp5?: boolean;
};

export type ExportTrack = {
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

export type ExportData = {
  song: {
    title: string;
    tempo: number;
    timeSignature: {
      numerator: number;
      denominator: number;
    };
  };
  tracks: ExportTrack[];
};

export type ExportReport = {
  exportedAt: string;
  mode: "arrangement-only";
  exportBaseName?: string;
  tracksSeen: number;
  midiTracksSeen: number;
  tracksIgnored: { name: string; reason: string }[];
  tracksMutedInGp5: { name: string; reason: string }[];
  clipsExported: number;
  notesExported: number;
  outputJson?: string;
  outputGp5?: string;
  pythonExecutable?: string;
  pythonCheckOutput?: string;
  warnings: string[];
  error?: string;
};

export type VersionedExportPaths = {
  stem: string;
  jsonPath: string;
  gp5Path: string;
  reportPath: string;
  conversionReportPath: string;
};

export type ExportDialogTrack = {
  name: string;
  status: "exported" | "muted" | "ignored" | "empty";
  clipCount: number;
  noteCount: number;
  detail: string;
};

export type ExportDialogResult = {
  action: "export" | "cancel";
  name?: string;
};

export type ExportResultDialogResult = {
  action: "close" | "open-folder";
};
