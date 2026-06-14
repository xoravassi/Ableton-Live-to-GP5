export type DrumElement =
  | "kick"
  | "snare"
  | "closed-hihat"
  | "pedal-hihat"
  | "open-hihat"
  | "ride"
  | "ride-bell"
  | "crash";
export type DrumDetection = DrumElement | "unrecognized";

export type AbletonMidiNote = {
  id?: number;
  pitch: number;
  startTime: number;
  duration: number;
  velocity: number;
  muted?: boolean;
  probability?: number;
  velocityDeviation?: number;
  drumElement?: DrumDetection;
  drumSourceName?: string;
};

export type FoundMidiClip = {
  clip: any;
  clipName: string;
  trackName: string;
  startTime: number;
  notes: AbletonMidiNote[];
  mutedInGp5?: boolean;
  kind?: "melodic" | "drums";
};

export type StringedTrackKind = "guitar" | "guitar7" | "bass";
export type ExportTrackKind = StringedTrackKind | "drums";

export type ExportTrackNote = {
  pitch: number;
  adjustedPitch?: number;
  octaveShift?: number;
  placementStatus?: "placed" | "unplaceable";
  voice?: number;
  string?: number;
  fret?: number;
  start: number;
  duration: number;
  velocity: number;
  drumElement?: DrumElement;
  percussionValue?: number;
  drumSourceName?: string;
};

export type TrackPlanMetrics = {
  unplaceableNotes: number;
  modifiedChords: number;
  totalAdjustedNotes: number;
  totalOctaveDistance: number;
  residualAdjustedNotes: number;
  residualOctaveDistance: number;
  adjustedDuration: number;
  octaveTransitionDistance: number;
  fretPositionCost: number;
};

export type TrackPlanOption = {
  key: string;
  kind: ExportTrackKind;
  instrument: string;
  tuning: number[];
  globalOctaveShift: number;
  bestForKind: boolean;
  recommended: boolean;
  metrics: TrackPlanMetrics;
};

export type ExportTrackPlan = {
  kind: ExportTrackKind;
  instrument: string;
  tuning: number[];
  globalOctaveShift: number;
  metrics: TrackPlanMetrics;
};

export type ExportTrack = {
  name: string;
  kind: ExportTrackKind;
  tuning: number[];
  plan: ExportTrackPlan;
  muted?: boolean;
  notes: ExportTrackNote[];
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
  drumTracksDetected: number;
  drumNotesRecognized: number;
  drumNotesIgnored: number;
  drumNotesMerged: number;
  drumElements: Record<DrumElement, number>;
  clipsExported: number;
  notesExported: number;
  notesWritten?: number;
  notesSkipped?: number;
  outputJson?: string;
  outputGp5?: string;
  conversionReportPath?: string;
  pythonExecutable?: string;
  pythonCheckOutput?: string;
  warnings: string[];
  error?: string;
};

export type ConversionTrackReport = {
  name: string;
  notesInput: number;
  notesWritten: number;
  notesSkipped: number;
  plannedPositionErrors?: string[];
  warnings?: string[];
};

export type ConversionReport = {
  tracksInput: number;
  tracksWritten: number;
  notesInput: number;
  notesWritten: number;
  notesSkipped: number;
  measuresWritten: number;
  warnings: string[];
  tracks: ConversionTrackReport[];
};

export type ExportResultSummary = {
  trackCount: number;
  notesWritten: number;
  notesSkipped: number;
  verificationWarning?: string;
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
  planningTrack?: ExportTrack;
  instrument?: string;
  drumSummary?: {
    kick: number;
    snare: number;
    hihat: number;
    ride: number;
    crash: number;
    unrecognized: number;
  };
  status: "exported" | "muted" | "ignored" | "empty";
  clipCount: number;
  noteCount: number;
  detail: string;
};

export type TrackPlanningSelection = {
  kind: "auto" | StringedTrackKind;
  globalOctaveShift: "auto" | number;
};

export type ExportDialogResult = {
  action: "export" | "cancel";
  name?: string;
  trackSelections?: Record<string, TrackPlanningSelection>;
  plannedTracks?: ExportTrack[];
};

export type ExportDialogSubmission = {
  name: string;
  trackSelections: Record<string, TrackPlanningSelection>;
  plannedTracks: ExportTrack[];
};

export type ExportResultDialogResult = {
  action: "close" | "open-folder";
};
