import type {
  ExportTrack,
  ExportTrackKind,
  ExportTrackNote,
  ExportTrackPlan,
  TrackPlanMetrics,
  TrackPlanOption,
  TrackPlanningSelection,
} from "./export-types.js";

const FRET_COUNT = 24;
const GLOBAL_OCTAVE_SHIFTS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const RESIDUAL_OCTAVE_SHIFTS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const START_GRID_PER_BEAT = 8;

type InstrumentDefinition = {
  kind: ExportTrackKind;
  label: string;
  tuning: number[];
  preference: number;
};

type IndexedNote = ExportTrackNote & {
  index: number;
};

type PlannedNote = {
  index: number;
  adjustedPitch: number;
  residualOctaveShift: number;
  voice: number;
  string: number;
  fret: number;
  fretCost: number;
};

type EventCandidate = {
  notes: PlannedNote[];
  representativeShift: number;
  representativeFret: number;
  metrics: TrackPlanMetrics;
};

type PlannedTrackCandidate = {
  plan: ExportTrackPlan;
  notes: PlannedNote[];
  comparison: number[];
};

type TrackAnalysis = {
  candidates: PlannedTrackCandidate[];
  recommended: PlannedTrackCandidate;
};

const analysisCache = new WeakMap<ExportTrack, TrackAnalysis>();

const INSTRUMENTS: InstrumentDefinition[] = [
  {
    kind: "guitar",
    label: "6-string guitar - EADGBE",
    tuning: [40, 45, 50, 55, 59, 64],
    preference: 0,
  },
  {
    kind: "guitar7",
    label: "7-string guitar - BEADGBE",
    tuning: [35, 40, 45, 50, 55, 59, 64],
    preference: 1,
  },
  {
    kind: "bass",
    label: "4-string bass - EADG",
    tuning: [28, 33, 38, 43],
    preference: 2,
  },
];

function emptyMetrics(): TrackPlanMetrics {
  return {
    unplaceableNotes: 0,
    modifiedChords: 0,
    totalAdjustedNotes: 0,
    totalOctaveDistance: 0,
    residualAdjustedNotes: 0,
    residualOctaveDistance: 0,
    adjustedDuration: 0,
    octaveTransitionDistance: 0,
    fretPositionCost: 0,
  };
}

function addMetrics(
  left: TrackPlanMetrics,
  right: TrackPlanMetrics
): TrackPlanMetrics {
  return {
    unplaceableNotes: left.unplaceableNotes + right.unplaceableNotes,
    modifiedChords: left.modifiedChords + right.modifiedChords,
    totalAdjustedNotes:
      left.totalAdjustedNotes + right.totalAdjustedNotes,
    totalOctaveDistance:
      left.totalOctaveDistance + right.totalOctaveDistance,
    residualAdjustedNotes:
      left.residualAdjustedNotes + right.residualAdjustedNotes,
    residualOctaveDistance:
      left.residualOctaveDistance + right.residualOctaveDistance,
    adjustedDuration: left.adjustedDuration + right.adjustedDuration,
    octaveTransitionDistance:
      left.octaveTransitionDistance + right.octaveTransitionDistance,
    fretPositionCost: left.fretPositionCost + right.fretPositionCost,
  };
}

function compareNumberArrays(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) return difference;
  }

  return 0;
}

function groupNotesByStart(notes: ExportTrackNote[]): IndexedNote[][] {
  const groups = new Map<number, IndexedNote[]>();

  notes.forEach((note, index) => {
    // Match the GP5 writer's 1/8-beat start quantization so simultaneous
    // string assignments remain valid after serialization.
    const key = Math.max(0, Math.round(note.start * START_GRID_PER_BEAT));
    const group = groups.get(key) ?? [];
    group.push({ ...note, index });
    groups.set(key, group);
  });

  return Array.from(groups.entries())
    .sort(([left], [right]) => left - right)
    .map(([, group]) =>
      group.sort((left, right) => left.pitch - right.pitch || left.index - right.index)
    );
}

function getPitchRange(instrument: InstrumentDefinition): [number, number] {
  return [
    Math.min(...instrument.tuning),
    Math.max(...instrument.tuning) + FRET_COUNT,
  ];
}

function findStringAssignment(
  pitches: number[],
  instrument: InstrumentDefinition
): {
  fretCost: number;
  representativeFret: number;
  assignments: { voice: number; string: number; fret: number }[];
} | null {
  const voiceCount = 2;
  const stringCount = instrument.tuning.length;

  if (pitches.length > stringCount * voiceCount) return null;

  const stringsHighToLow = [...instrument.tuning].reverse();
  const options = pitches.map((pitch) =>
    Array.from({ length: voiceCount }, (_, voice) =>
      stringsHighToLow.map((openPitch, index) => ({
        voice,
        string: index + 1,
        fret: pitch - openPitch,
        slot: voice * stringCount + index,
      }))
    )
      .flat()
      .filter(({ fret }) => fret >= 0 && fret <= FRET_COUNT)
  );

  if (options.some((noteOptions) => noteOptions.length === 0)) return null;

  type State = {
    usedSlots: number;
    frets: number[];
    assignments: { voice: number; string: number; fret: number }[];
  };

  let states: State[] = [{ usedSlots: 0, frets: [], assignments: [] }];

  for (const noteOptions of options) {
    const nextStates = new Map<number, State>();

    for (const state of states) {
      for (const option of noteOptions) {
        const slotMask = 1 << option.slot;

        if ((state.usedSlots & slotMask) !== 0) continue;

        const usedSlots = state.usedSlots | slotMask;
        const candidate = {
          usedSlots,
          frets: [...state.frets, option.fret],
          assignments: [
            ...state.assignments,
            {
              voice: option.voice,
              string: option.string,
              fret: option.fret,
            },
          ],
        };
        const current = nextStates.get(usedSlots);

        if (
          !current ||
          assignmentCost(candidate) < assignmentCost(current)
        ) {
          nextStates.set(usedSlots, candidate);
        }
      }
    }

    states = Array.from(nextStates.values());

    if (states.length === 0) return null;
  }

  const best = states.sort(
    (left, right) => assignmentCost(left) - assignmentCost(right)
  )[0];

  if (!best) return null;

  return {
    fretCost: assignmentCost(best),
    representativeFret:
      best.frets.reduce((total, fret) => total + fret, 0) /
      Math.max(1, best.frets.length),
    assignments: best.assignments,
  };
}

function assignmentCost(state: {
  frets: number[];
  assignments: { voice: number }[];
}): number {
  const secondVoiceNotes = state.assignments.filter(
    (assignment) => assignment.voice === 1
  ).length;

  return secondVoiceNotes * 10_000 + fretCost(state.frets);
}

function fretCost(frets: number[]): number {
  if (frets.length === 0) return 0;

  const minimum = Math.min(...frets);
  const maximum = Math.max(...frets);
  const average = frets.reduce((total, fret) => total + fret, 0) / frets.length;

  return Math.round((maximum - minimum) * 100 + average * 10);
}

function createCommonShiftCandidate(
  notes: IndexedNote[],
  instrument: InstrumentDefinition,
  globalOctaveShift: number,
  residualOctaveShift: number
): EventCandidate | null {
  const adjustedPitches = notes.map(
    (note) => note.pitch + 12 * (globalOctaveShift + residualOctaveShift)
  );
  const [lowestPitch, highestPitch] = getPitchRange(instrument);

  if (
    adjustedPitches.some(
      (pitch) => pitch < lowestPitch || pitch > highestPitch
    )
  ) {
    return null;
  }

  const assignment = findStringAssignment(adjustedPitches, instrument);

  if (!assignment) return null;

  const adjustedNotes = residualOctaveShift === 0 ? 0 : notes.length;
  const totalOctaveShift = globalOctaveShift + residualOctaveShift;
  const totalAdjustedNotes = totalOctaveShift === 0 ? 0 : notes.length;
  const duration = notes.reduce(
    (total, note) => total + Math.max(0, note.duration),
    0
  );

  return {
    representativeShift: residualOctaveShift,
    representativeFret: assignment.representativeFret,
    notes: notes.map((note, index) => ({
      index: note.index,
      adjustedPitch: adjustedPitches[index],
      residualOctaveShift,
      ...assignment.assignments[index],
      fretCost: assignment.fretCost,
    })),
    metrics: {
      ...emptyMetrics(),
      totalAdjustedNotes,
      totalOctaveDistance: Math.abs(totalOctaveShift) * notes.length,
      residualAdjustedNotes: adjustedNotes,
      residualOctaveDistance:
        Math.abs(residualOctaveShift) * notes.length,
      adjustedDuration: Math.abs(totalOctaveShift) * duration,
      fretPositionCost: assignment.fretCost,
    },
  };
}

function createFallbackCandidate(
  notes: IndexedNote[],
  instrument: InstrumentDefinition,
  globalOctaveShift: number
): EventCandidate {
  const [lowestPitch, highestPitch] = getPitchRange(instrument);
  const stringsHighToLow = [...instrument.tuning].reverse();
  const stringCount = stringsHighToLow.length;

  type FallbackState = {
    usedSlots: number;
    notes: PlannedNote[];
    skipped: number;
    residualShifts: number[];
    frets: number[];
    adjustedDuration: number;
    totalOctaveShifts: number[];
  };

  let states: FallbackState[] = [
    {
      usedSlots: 0,
      notes: [],
      skipped: 0,
      residualShifts: [],
      frets: [],
      adjustedDuration: 0,
      totalOctaveShifts: [],
    },
  ];

  for (const note of notes) {
    const options = RESIDUAL_OCTAVE_SHIFTS.flatMap(
      (residualOctaveShift) => {
        const adjustedPitch =
          note.pitch + 12 * (globalOctaveShift + residualOctaveShift);

        if (adjustedPitch < lowestPitch || adjustedPitch > highestPitch) {
          return [];
        }

        return [0, 1].flatMap((voice) =>
          stringsHighToLow
            .map((openPitch, index) => ({
              adjustedPitch,
              residualOctaveShift,
              voice,
              string: index + 1,
              fret: adjustedPitch - openPitch,
              slot: voice * stringCount + index,
            }))
            .filter(({ fret }) => fret >= 0 && fret <= FRET_COUNT)
        );
      }
    );
    const nextStates = new Map<string, FallbackState>();

    for (const state of states) {
      keepFallbackState(nextStates, {
        ...state,
        skipped: state.skipped + 1,
      });

      for (const option of options) {
        const slotMask = 1 << option.slot;

        if ((state.usedSlots & slotMask) !== 0) continue;

        keepFallbackState(nextStates, {
          usedSlots: state.usedSlots | slotMask,
          notes: [
            ...state.notes,
            {
              index: note.index,
              adjustedPitch: option.adjustedPitch,
              residualOctaveShift: option.residualOctaveShift,
              voice: option.voice,
              string: option.string,
              fret: option.fret,
              fretCost: option.fret,
            },
          ],
          skipped: state.skipped,
          residualShifts: [
            ...state.residualShifts,
            option.residualOctaveShift,
          ],
          frets: [...state.frets, option.fret],
          adjustedDuration:
            state.adjustedDuration +
            Math.abs(globalOctaveShift + option.residualOctaveShift) *
              Math.max(0, note.duration),
          totalOctaveShifts: [
            ...state.totalOctaveShifts,
            globalOctaveShift + option.residualOctaveShift,
          ],
        });
      }
    }

    states = Array.from(nextStates.values())
      .sort((left, right) =>
        compareNumberArrays(
          fallbackStateComparison(left),
          fallbackStateComparison(right)
        )
      )
      .slice(0, 10_000);
  }

  const best = states.sort((left, right) =>
    compareNumberArrays(
      fallbackStateComparison(left),
      fallbackStateComparison(right)
    )
  )[0];
  const planned = best?.notes ?? [];
  const residualShifts = best?.residualShifts ?? [];
  const distinctShifts = new Set(residualShifts);
  const residualAdjustedNotes = residualShifts.filter(
    (shift) => shift !== 0
  ).length;
  const residualOctaveDistance = residualShifts.reduce(
    (total, shift) => total + Math.abs(shift),
    0
  );
  const totalOctaveShifts = best?.totalOctaveShifts ?? [];
  const representativeFret =
    best && best.frets.length > 0
      ? best.frets.reduce((total, fret) => total + fret, 0) /
        best.frets.length
      : 0;

  return {
    representativeShift:
      residualShifts.length === 0
        ? 0
        : Math.round(
            residualShifts.reduce((total, shift) => total + shift, 0) /
              residualShifts.length
          ),
    representativeFret,
    notes: planned,
    metrics: {
      ...emptyMetrics(),
      unplaceableNotes: best?.skipped ?? notes.length,
      modifiedChords: distinctShifts.size > 1 ? 1 : 0,
      totalAdjustedNotes: totalOctaveShifts.filter((shift) => shift !== 0).length,
      totalOctaveDistance: totalOctaveShifts.reduce(
        (total, shift) => total + Math.abs(shift),
        0
      ),
      residualAdjustedNotes,
      residualOctaveDistance,
      adjustedDuration: best?.adjustedDuration ?? 0,
      fretPositionCost: best
        ? assignmentCost({
            frets: best.frets,
            assignments: best.notes,
          })
        : 0,
    },
  };
}

function fallbackStateComparison(state: {
  skipped: number;
  residualShifts: number[];
  frets: number[];
  notes: { voice: number }[];
  adjustedDuration: number;
  totalOctaveShifts: number[];
}): number[] {
  const distinctShifts = new Set(state.residualShifts);

  return [
    state.skipped,
    distinctShifts.size > 1 ? 1 : 0,
    state.totalOctaveShifts.filter((shift) => shift !== 0).length,
    state.totalOctaveShifts.reduce(
      (total, shift) => total + Math.abs(shift),
      0
    ),
    Math.round(state.adjustedDuration * 1000),
    state.residualShifts.filter((shift) => shift !== 0).length,
    state.residualShifts.reduce(
      (total, shift) => total + Math.abs(shift),
      0
    ),
    assignmentCost({
      frets: state.frets,
      assignments: state.notes,
    }),
  ];
}

function keepFallbackState<T extends {
  usedSlots: number;
  residualShifts: number[];
  skipped: number;
  frets: number[];
  notes: { voice: number }[];
  adjustedDuration: number;
  totalOctaveShifts: number[];
}>(states: Map<string, T>, candidate: T): void {
  const shifts = Array.from(new Set(candidate.residualShifts))
    .sort((left, right) => left - right)
    .join(",");
  const key = `${candidate.usedSlots}:${shifts}:${candidate.skipped}`;
  const current = states.get(key);

  if (
    !current ||
    compareNumberArrays(
      fallbackStateComparison(candidate),
      fallbackStateComparison(current)
    ) < 0
  ) {
    states.set(key, candidate);
  }
}

function getEventCandidates(
  notes: IndexedNote[],
  instrument: InstrumentDefinition,
  globalOctaveShift: number
): EventCandidate[] {
  const commonCandidates = RESIDUAL_OCTAVE_SHIFTS.map((shift) =>
    createCommonShiftCandidate(notes, instrument, globalOctaveShift, shift)
  ).filter((candidate): candidate is EventCandidate => candidate !== null);

  if (commonCandidates.length > 0) return commonCandidates;

  return [createFallbackCandidate(notes, instrument, globalOctaveShift)];
}

function candidateComparison(metrics: TrackPlanMetrics): number[] {
  return [
    metrics.unplaceableNotes,
    metrics.modifiedChords,
    metrics.totalAdjustedNotes,
    metrics.totalOctaveDistance,
    Math.round(metrics.adjustedDuration * 1000),
    metrics.residualAdjustedNotes,
    metrics.residualOctaveDistance,
    metrics.octaveTransitionDistance,
    metrics.fretPositionCost,
  ];
}

function planEvents(
  notes: ExportTrackNote[],
  instrument: InstrumentDefinition,
  globalOctaveShift: number
): { metrics: TrackPlanMetrics; notes: PlannedNote[] } {
  const events = groupNotesByStart(notes);

  type State = {
    metrics: TrackPlanMetrics;
    representativeShift: number;
    representativeFret: number;
    previous: State | null;
    eventNotes: PlannedNote[];
  };

  let states: State[] = [
    {
      metrics: emptyMetrics(),
      representativeShift: 0,
      representativeFret: 0,
      previous: null,
      eventNotes: [],
    },
  ];

  events.forEach((event, eventIndex) => {
    const eventCandidates = getEventCandidates(
      event,
      instrument,
      globalOctaveShift
    );
    const nextStates: State[] = [];

    for (const candidate of eventCandidates) {
      let bestState: State | null = null;

      for (const previous of states) {
        const transitionDistance =
          eventIndex === 0
            ? 0
            : Math.abs(
                candidate.representativeShift - previous.representativeShift
              );
        const fretTransitionDistance =
          eventIndex === 0
            ? 0
            : Math.round(
                Math.abs(
                  candidate.representativeFret - previous.representativeFret
                ) * 10
              );
        const metrics = addMetrics(previous.metrics, {
          ...candidate.metrics,
          octaveTransitionDistance:
            candidate.metrics.octaveTransitionDistance + transitionDistance,
          fretPositionCost:
            candidate.metrics.fretPositionCost + fretTransitionDistance,
        });
        const state = {
          metrics,
          representativeShift: candidate.representativeShift,
          representativeFret: candidate.representativeFret,
          previous,
          eventNotes: candidate.notes,
        };

        if (
          !bestState ||
          compareNumberArrays(
            candidateComparison(state.metrics),
            candidateComparison(bestState.metrics)
          ) < 0
        ) {
          bestState = state;
        }
      }

      if (bestState) nextStates.push(bestState);
    }

    states = nextStates;
  });

  const best = states.sort((left, right) =>
    compareNumberArrays(
      candidateComparison(left.metrics),
      candidateComparison(right.metrics)
    )
  )[0];

  if (!best) return { metrics: emptyMetrics(), notes: [] };

  const eventNotes: PlannedNote[][] = [];
  let current: State | null = best;

  while (current?.previous) {
    eventNotes.push(current.eventNotes);
    current = current.previous;
  }

  return {
    metrics: best.metrics,
    notes: eventNotes.reverse().flat(),
  };
}

function trackNameHint(name: string): ExportTrackKind | null {
  const lower = name.toLowerCase();

  if (/(^|[^a-z0-9])(bass|basse|sub)([^a-z0-9]|$)/.test(lower)) {
    return "bass";
  }

  if (
    /(^|[^a-z0-9])(7[\s-]*string|seven[\s-]*string|metal|djent)([^a-z0-9]|$)/.test(
      lower
    )
  ) {
    return "guitar7";
  }

  return null;
}

function inferPreferredKind(track: ExportTrack): ExportTrackKind {
  const nameHint = trackNameHint(track.name);

  if (nameHint) return nameHint;
  if (track.notes.length === 0) return "guitar";

  const pitches = track.notes.map((note) => note.pitch);
  const lowRatio = pitches.filter((pitch) => pitch < 40).length / pitches.length;
  const highRatio =
    pitches.filter((pitch) => pitch >= 59).length / pitches.length;
  const bassRangeRatio =
    pitches.filter((pitch) => pitch <= 55).length / pitches.length;

  if (lowRatio >= 0.15 && highRatio >= 0.25) {
    return "guitar7";
  }

  if (bassRangeRatio >= 0.8 && highRatio < 0.25) {
    return "bass";
  }

  return "guitar";
}

function fullCandidateComparison(
  candidate: PlannedTrackCandidate,
  track: ExportTrack,
  instrument: InstrumentDefinition,
  preferredKind: ExportTrackKind
): number[] {
  const metrics = candidate.plan.metrics;

  return [
    metrics.unplaceableNotes,
    instrument.kind === preferredKind ? 0 : 1,
    metrics.modifiedChords,
    metrics.totalAdjustedNotes,
    metrics.totalOctaveDistance,
    Math.round(metrics.adjustedDuration * 1000),
    metrics.residualAdjustedNotes,
    metrics.residualOctaveDistance,
    metrics.octaveTransitionDistance,
    Math.abs(candidate.plan.globalOctaveShift),
    instrument.preference,
    metrics.fretPositionCost,
    candidate.plan.globalOctaveShift,
  ];
}

function createCandidate(
  track: ExportTrack,
  instrument: InstrumentDefinition,
  globalOctaveShift: number,
  preferredKind: ExportTrackKind
): PlannedTrackCandidate {
  const eventPlan = planEvents(track.notes, instrument, globalOctaveShift);
  const plan: ExportTrackPlan = {
    kind: instrument.kind,
    instrument: instrument.label,
    tuning: [...instrument.tuning],
    globalOctaveShift,
    metrics: eventPlan.metrics,
  };
  const candidate: PlannedTrackCandidate = {
    plan,
    notes: eventPlan.notes,
    comparison: [],
  };

  candidate.comparison = fullCandidateComparison(
    candidate,
    track,
    instrument,
    preferredKind
  );
  return candidate;
}

function createCandidates(track: ExportTrack): PlannedTrackCandidate[] {
  const preferredKind = inferPreferredKind(track);

  return INSTRUMENTS.flatMap((instrument) =>
    GLOBAL_OCTAVE_SHIFTS.map((globalOctaveShift) =>
      createCandidate(track, instrument, globalOctaveShift, preferredKind)
    )
  );
}

function analyzeTrack(track: ExportTrack): TrackAnalysis {
  const cached = analysisCache.get(track);

  if (cached) return cached;

  const candidates = createCandidates(track);
  const analysis = {
    candidates,
    recommended: bestCandidate(candidates),
  };

  analysisCache.set(track, analysis);
  return analysis;
}

function bestCandidate(
  candidates: PlannedTrackCandidate[]
): PlannedTrackCandidate {
  return [...candidates].sort((left, right) =>
    compareNumberArrays(left.comparison, right.comparison)
  )[0];
}

function chooseCandidate(
  candidates: PlannedTrackCandidate[],
  selection?: TrackPlanningSelection
): PlannedTrackCandidate {
  const kind = selection?.kind ?? "auto";
  const globalShift = selection?.globalOctaveShift ?? "auto";
  const filtered = candidates.filter((candidate) => {
    const kindMatches = kind === "auto" || candidate.plan.kind === kind;
    const shiftMatches =
      globalShift === "auto" ||
      candidate.plan.globalOctaveShift === globalShift;

    return kindMatches && shiftMatches;
  });

  return bestCandidate(filtered.length > 0 ? filtered : candidates);
}

function applyCandidate(
  track: ExportTrack,
  candidate: PlannedTrackCandidate
): void {
  const plannedByIndex = new Map(
    candidate.notes.map((note) => [note.index, note])
  );

  track.kind = candidate.plan.kind;
  track.tuning = [...candidate.plan.tuning];
  track.plan = {
    ...candidate.plan,
    tuning: [...candidate.plan.tuning],
  };
  track.notes = track.notes.map((note, index) => {
    const planned = plannedByIndex.get(index);
    const {
      adjustedPitch: _adjustedPitch,
      octaveShift: _octaveShift,
      placementStatus: _placementStatus,
      voice: _voice,
      string: _string,
      fret: _fret,
      ...sourceNote
    } = note;

    if (!planned) {
      return {
        ...sourceNote,
        adjustedPitch: sourceNote.pitch,
        octaveShift: 0,
        placementStatus: "unplaceable" as const,
        voice: 0,
      };
    }

    return {
      ...sourceNote,
      adjustedPitch: planned.adjustedPitch,
      octaveShift: (planned.adjustedPitch - sourceNote.pitch) / 12,
      placementStatus: "placed" as const,
      voice: planned.voice,
      string: planned.string,
      fret: planned.fret,
    };
  });
}

export function planTrack(
  track: ExportTrack,
  selection?: TrackPlanningSelection
): TrackPlanOption[] {
  const { candidates, recommended } = analyzeTrack(track);
  const selected = chooseCandidate(candidates, selection);
  const bestKeysByKind = new Map<ExportTrackKind, string>();

  for (const instrument of INSTRUMENTS) {
    const candidate = bestCandidate(
      candidates.filter((item) => item.plan.kind === instrument.kind)
    );
    bestKeysByKind.set(
      instrument.kind,
      `${candidate.plan.kind}:${candidate.plan.globalOctaveShift}`
    );
  }

  applyCandidate(track, selected);

  return [...candidates]
    .sort((left, right) =>
      compareNumberArrays(left.comparison, right.comparison)
    )
    .map((candidate) => {
      const key = `${candidate.plan.kind}:${candidate.plan.globalOctaveShift}`;

      return {
        key,
        kind: candidate.plan.kind,
        instrument: candidate.plan.instrument,
        tuning: [...candidate.plan.tuning],
        globalOctaveShift: candidate.plan.globalOctaveShift,
        bestForKind: bestKeysByKind.get(candidate.plan.kind) === key,
        recommended:
          candidate.plan.kind === recommended.plan.kind &&
          candidate.plan.globalOctaveShift ===
            recommended.plan.globalOctaveShift,
        metrics: candidate.plan.metrics,
      };
    });
}

export function replanExportTracks(
  tracks: ExportTrack[],
  selections: Record<string, TrackPlanningSelection> = {}
): Map<string, TrackPlanOption[]> {
  const options = new Map<string, TrackPlanOption[]>();

  for (const track of tracks) {
    options.set(track.name, planTrack(track, selections[track.name]));
  }

  return options;
}
