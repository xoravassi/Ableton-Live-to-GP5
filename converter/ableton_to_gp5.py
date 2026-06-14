import json
import math
import sys
import traceback
from pathlib import Path
from typing import Any

import guitarpro
from guitarpro import models as gp


TICKS_PER_BEAT = gp.Duration.quarterTime  # 960

DEFAULT_FRET_COUNT = 24

STANDARD_GUITAR_TUNING = [40, 45, 50, 55, 59, 64]  # E2 A2 D3 G3 B3 E4
STANDARD_7_STRING_TUNING = [35, 40, 45, 50, 55, 59, 64]  # B1 E2 A2 D3 G3 B3 E4
STANDARD_BASS_TUNING = [28, 33, 38, 43]  # E1 A1 D2 G2

GUITAR_MIDI_INSTRUMENT = 25
BASS_MIDI_INSTRUMENT = 33
PERCUSSION_MIDI_CHANNEL = 9
PERCUSSION_VALUES = {
    "kick": 36,
    "snare": 38,
    "closed-hihat": 42,
    "pedal-hihat": 44,
    "open-hihat": 46,
    "crash": 49,
    "ride": 51,
    "ride-bell": 53,
}
PERCUSSION_STRINGS = {
    36: 5,
    38: 6,
    42: 1,
    44: 1,
    46: 1,
    49: 3,
    51: 2,
    53: 2,
}

ALLOWED_DURATIONS = [
    gp.Duration.quarterTime * 4,       # ronde
    gp.Duration.quarterTime * 3,       # blanche pointée
    gp.Duration.quarterTime * 2,       # blanche
    gp.Duration.quarterTime * 3 // 2,  # noire pointée
    gp.Duration.quarterTime,           # noire
    gp.Duration.quarterTime * 3 // 4,  # croche pointée
    gp.Duration.quarterTime // 2,      # croche
    gp.Duration.quarterTime * 3 // 8,  # double croche pointée
    gp.Duration.quarterTime // 4,      # double croche
    gp.Duration.quarterTime // 8,      # triple croche
]


class ConversionError(Exception):
    pass


def make_report() -> dict[str, Any]:
    return {
        "tracksInput": 0,
        "tracksWritten": 0,
        "notesInput": 0,
        "notesWritten": 0,
        "notesSkipped": 0,
        "measuresWritten": 0,
        "warnings": [],
        "tracks": [],
    }


def write_conversion_report(output_path: Path, report: dict[str, Any]) -> Path:
    report_path = output_path.with_name(
        f"{output_path.stem}.conversion-report.json"
    )

    with report_path.open("w", encoding="utf-8") as file:
        json.dump(report, file, indent=2, ensure_ascii=False)

    return report_path


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ConversionError(f"Input file not found: {path}")

    try:
        with path.open("r", encoding="utf-8") as file:
            data = json.load(file)
    except json.JSONDecodeError as error:
        raise ConversionError(f"Invalid JSON file: {error}") from error

    if not isinstance(data, dict):
        raise ConversionError("Input JSON root must be an object.")

    if "tracks" not in data:
        raise ConversionError("Input JSON must contain a 'tracks' array.")

    if not isinstance(data["tracks"], list):
        raise ConversionError("'tracks' must be an array.")

    return data


def beats_to_ticks(beats: float) -> int:
    return int(round(beats * TICKS_PER_BEAT))


def quantize_ticks(ticks: int) -> int:
    grid = TICKS_PER_BEAT // 8
    return max(grid, int(round(ticks / grid) * grid))


def quantize_start_ticks(ticks: int) -> int:
    grid = TICKS_PER_BEAT // 8
    return max(0, int(math.floor(ticks / grid + 0.5) * grid))


def duration_from_ticks(ticks: int) -> gp.Duration:
    ticks = max(TICKS_PER_BEAT // 8, quantize_ticks(ticks))

    try:
        return gp.Duration.fromTime(ticks)
    except Exception:
        return gp.Duration(value=gp.Duration.quarter)


def split_duration_ticks(total_ticks: int) -> list[int]:
    remaining = quantize_ticks(total_ticks)
    result: list[int] = []

    while remaining > 0:
        for duration in ALLOWED_DURATIONS:
            if duration <= remaining:
                result.append(duration)
                remaining -= duration
                break
        else:
            result.append(TICKS_PER_BEAT // 8)
            remaining -= TICKS_PER_BEAT // 8

    return result


def make_rest(voice: gp.Voice, start_tick: int, duration_ticks: int) -> gp.Beat:
    return gp.Beat(
        voice=voice,
        duration=duration_from_ticks(duration_ticks),
        start=start_tick,
        status=gp.BeatStatus.rest,
    )


def make_empty_beat(voice: gp.Voice, start_tick: int, duration_ticks: int) -> gp.Beat:
    return gp.Beat(
        voice=voice,
        duration=duration_from_ticks(duration_ticks),
        start=start_tick,
        status=gp.BeatStatus.empty,
    )


def clamp_velocity(value: Any) -> int:
    try:
        velocity = int(value)
    except Exception:
        return gp.Velocities.default

    return max(1, min(127, velocity))


def infer_default_tuning(track_kind: str) -> list[int]:
    if track_kind.lower() == "bass":
        return STANDARD_BASS_TUNING.copy()

    if track_kind.lower() == "guitar7":
        return STANDARD_7_STRING_TUNING.copy()

    return STANDARD_GUITAR_TUNING.copy()


def make_gp_strings(tuning_low_to_high: list[int]) -> list[gp.GuitarString]:
    # JSON: grave → aigu.
    # PyGuitarPro / GP: aigu → grave.
    high_to_low = list(reversed(tuning_low_to_high))

    return [
        gp.GuitarString(number=index + 1, value=int(pitch))
        for index, pitch in enumerate(high_to_low)
    ]

def make_percussion_strings() -> list[gp.GuitarString]:
    return [
        gp.GuitarString(number=index + 1, value=0)
        for index in range(7)
    ]


def fit_pitch_to_fretboard(pitch: int, track: gp.Track) -> tuple[int, int]:
    lowest_pitch = min(string.value for string in track.strings)
    highest_pitch = max(
        string.value + track.fretCount
        for string in track.strings
    )
    adjusted_pitch = pitch

    while adjusted_pitch < lowest_pitch:
        adjusted_pitch += 12

    while adjusted_pitch > highest_pitch:
        adjusted_pitch -= 12

    octave_shift = (adjusted_pitch - pitch) // 12
    return adjusted_pitch, octave_shift


def choose_string_and_fret(
    pitch: int,
    track: gp.Track,
    used_strings: set[int],
) -> tuple[int, int] | None:
    candidates: list[tuple[int, int]] = []

    for string in track.strings:
        fret = pitch - string.value

        if 0 <= fret <= track.fretCount and string.number not in used_strings:
            candidates.append((string.number, fret))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (item[1], item[0]))
    return candidates[0]


def make_note_beat(
    voice: gp.Voice,
    start_tick: int,
    duration_ticks: int,
    notes: list[dict[str, Any]],
    track: gp.Track,
    track_report: dict[str, Any],
) -> gp.Beat:
    beat = gp.Beat(
        voice=voice,
        duration=duration_from_ticks(duration_ticks),
        start=start_tick,
        status=gp.BeatStatus.normal,
    )

    if track.isPercussionTrack:
        used_values: set[int] = set()
        used_strings: set[int] = set()

        for note_data in notes:
            element = str(note_data.get("drumElement", "")).lower()
            percussion_value = PERCUSSION_VALUES.get(element)

            if percussion_value is None:
                try:
                    candidate_value = int(note_data["percussionValue"])
                except Exception:
                    candidate_value = -1

                if candidate_value in PERCUSSION_VALUES.values():
                    percussion_value = candidate_value

            if percussion_value is None:
                track_report["notesSkipped"] += 1
                track_report["warnings"].append(
                    "Skipped drum note without a supported percussion value."
                )
                continue

            if percussion_value in used_values:
                track_report["duplicatesMerged"] += 1
                continue

            preferred_string = PERCUSSION_STRINGS.get(percussion_value, 1)
            string_number = preferred_string

            if string_number in used_strings:
                string_number = next(
                    (
                        candidate
                        for candidate in range(1, len(track.strings) + 1)
                        if candidate not in used_strings
                    ),
                    0,
                )

            if string_number == 0:
                track_report["notesSkipped"] += 1
                track_report["warnings"].append(
                    "Skipped drum note because no GP5 percussion slot was available."
                )
                continue

            note = gp.Note(
                beat=beat,
                value=percussion_value,
                velocity=clamp_velocity(
                    note_data.get("velocity", gp.Velocities.default)
                ),
                string=string_number,
                type=gp.NoteType.normal,
            )

            beat.notes.append(note)
            used_values.add(percussion_value)
            used_strings.add(string_number)
            track_report["notesWritten"] += 1

            if element in track_report["percussionElements"]:
                track_report["percussionElements"][element] += 1

        if not beat.notes:
            beat.status = gp.BeatStatus.rest

        return beat

    used_strings: set[int] = set()

    for note_data in notes:
        try:
            original_pitch = int(note_data["pitch"])
        except Exception:
            track_report["notesSkipped"] += 1
            track_report["warnings"].append("Skipped note with missing/invalid pitch.")
            continue

        placement_status = note_data.get("placementStatus")

        if placement_status == "unplaceable":
            track_report["notesSkipped"] += 1
            track_report["unplaceablePitches"].setdefault(str(original_pitch), 0)
            track_report["unplaceablePitches"][str(original_pitch)] += 1
            continue

        try:
            pitch = int(note_data.get("adjustedPitch", original_pitch))
        except Exception:
            pitch = original_pitch

        if "adjustedPitch" not in note_data:
            pitch, octave_shift = fit_pitch_to_fretboard(original_pitch, track)
        else:
            try:
                octave_shift = int(
                    note_data.get("octaveShift", (pitch - original_pitch) // 12)
                )
            except Exception:
                octave_shift = (pitch - original_pitch) // 12

        if octave_shift != 0:
            track_report["octaveAdjustedNotes"] += 1
            track_report["octaveAdjustments"].append(
                {
                    "originalPitch": original_pitch,
                    "adjustedPitch": pitch,
                    "octaveShift": octave_shift,
                }
            )

        velocity = clamp_velocity(note_data.get("velocity", gp.Velocities.default))

        position: tuple[int, int] | None = None
        planned_position_error: str | None = None

        try:
            planned_string = int(note_data["string"])
            planned_fret = int(note_data["fret"])
            string = next(
                (
                    candidate
                    for candidate in track.strings
                    if candidate.number == planned_string
                ),
                None,
            )

            if (
                string is not None
                and planned_string not in used_strings
                and 0 <= planned_fret <= track.fretCount
                and string.value + planned_fret == pitch
            ):
                position = (planned_string, planned_fret)
            elif placement_status == "placed":
                planned_position_error = (
                    f"Invalid planned position for MIDI {original_pitch}: "
                    f"string {planned_string}, fret {planned_fret}, "
                    f"adjusted pitch {pitch}."
                )
        except Exception:
            if placement_status == "placed":
                planned_position_error = (
                    f"Missing planned string/fret for MIDI {original_pitch}."
                )

        if planned_position_error is not None:
            track_report["notesSkipped"] += 1
            track_report["plannedPositionErrors"].append(planned_position_error)
            track_report["unplaceablePitches"].setdefault(str(original_pitch), 0)
            track_report["unplaceablePitches"][str(original_pitch)] += 1
            continue

        if position is None and placement_status != "placed":
            position = choose_string_and_fret(
                pitch=pitch,
                track=track,
                used_strings=used_strings,
            )

        if position is None:
            track_report["notesSkipped"] += 1
            track_report["unplaceablePitches"].setdefault(str(original_pitch), 0)
            track_report["unplaceablePitches"][str(original_pitch)] += 1
            continue

        string_number, fret = position
        used_strings.add(string_number)

        note = gp.Note(
            beat=beat,
            value=fret,
            velocity=velocity,
            string=string_number,
            type=gp.NoteType.normal,
        )

        beat.notes.append(note)
        track_report["notesWritten"] += 1

    if not beat.notes:
        beat.status = gp.BeatStatus.rest

    return beat


def create_measure_headers(
    measure_count: int,
    numerator: int,
    denominator: int,
) -> list[gp.MeasureHeader]:
    time_signature = gp.TimeSignature(
        numerator=numerator,
        denominator=gp.Duration(value=denominator),
    )

    measure_length_ticks = numerator * gp.Duration(value=denominator).time

    headers: list[gp.MeasureHeader] = []

    for index in range(measure_count):
        headers.append(
            gp.MeasureHeader(
                number=index + 1,
                start=gp.Duration.quarterTime + index * measure_length_ticks,
                timeSignature=time_signature,
            )
        )

    return headers


def get_measure_count(
    data: dict[str, Any],
    measure_length_ticks: int,
) -> int:
    max_end_ticks = 0

    for track in data.get("tracks", []):
        if not isinstance(track, dict):
            continue

        notes = track.get("notes", [])

        if not isinstance(notes, list):
            continue

        for note in notes:
            if not isinstance(note, dict):
                continue

            try:
                start = float(note.get("start", 0))
                duration = float(note.get("duration", 0))
            except Exception:
                continue

            start_ticks = quantize_start_ticks(beats_to_ticks(start))
            duration_ticks = quantize_ticks(beats_to_ticks(duration))
            max_end_ticks = max(max_end_ticks, start_ticks + duration_ticks)

    return max(1, math.ceil(max_end_ticks / measure_length_ticks))


def group_notes_by_measure_and_start(
    notes: list[dict[str, Any]],
    measure_length_ticks: int,
    track_report: dict[str, Any],
) -> dict[int, dict[int, list[dict[str, Any]]]]:
    grouped: dict[int, dict[int, list[dict[str, Any]]]] = {}

    for note in notes:
        if not isinstance(note, dict):
            track_report["notesSkipped"] += 1
            track_report["warnings"].append("Skipped non-object note.")
            continue

        try:
            start_beats = float(note.get("start", 0))
        except Exception:
            track_report["notesSkipped"] += 1
            track_report["warnings"].append("Skipped note with invalid start.")
            continue

        start_ticks = quantize_start_ticks(beats_to_ticks(start_beats))
        measure_index, local_start_ticks = divmod(
            start_ticks,
            measure_length_ticks,
        )

        grouped.setdefault(measure_index, {})
        grouped[measure_index].setdefault(local_start_ticks, [])
        grouped[measure_index][local_start_ticks].append(note)

    return grouped


def populate_measure_voice(
    voice: gp.Voice,
    local_events: dict[int, list[dict[str, Any]]],
    measure_length_ticks: int,
    track: gp.Track,
    track_report: dict[str, Any],
    use_empty_beat_when_silent: bool,
) -> None:
    event_starts = sorted(local_events.keys())
    cursor = 0

    for event_index, local_start in enumerate(event_starts):
        local_start = max(0, min(local_start, measure_length_ticks))

        if local_start > cursor:
            for rest_duration in split_duration_ticks(local_start - cursor):
                absolute_start = voice.measure.header.start + cursor
                voice.beats.append(make_rest(voice, absolute_start, rest_duration))
                cursor += rest_duration

        notes_at_start = local_events[local_start]
        valid_duration_ticks: list[int] = []

        for note in notes_at_start:
            if not isinstance(note, dict):
                continue

            try:
                valid_duration_ticks.append(
                    quantize_ticks(beats_to_ticks(float(note.get("duration", 1))))
                )
            except Exception:
                continue

        raw_duration_ticks = (
            min(valid_duration_ticks)
            if valid_duration_ticks
            else TICKS_PER_BEAT
        )
        next_event_start = (
            event_starts[event_index + 1]
            if event_index + 1 < len(event_starts)
            else measure_length_ticks
        )
        max_available = max(TICKS_PER_BEAT // 8, next_event_start - local_start)
        duration_ticks = max(
            TICKS_PER_BEAT // 8,
            min(raw_duration_ticks, max_available),
        )
        absolute_start = voice.measure.header.start + local_start
        beat = make_note_beat(
            voice=voice,
            start_tick=absolute_start,
            duration_ticks=duration_ticks,
            notes=notes_at_start,
            track=track,
            track_report=track_report,
        )

        voice.beats.append(beat)
        cursor = local_start + duration_ticks

    if cursor < measure_length_ticks and event_starts:
        for rest_duration in split_duration_ticks(measure_length_ticks - cursor):
            absolute_start = voice.measure.header.start + cursor
            voice.beats.append(make_rest(voice, absolute_start, rest_duration))
            cursor += rest_duration

    if not voice.beats:
        beat_factory = make_empty_beat if use_empty_beat_when_silent else make_rest
        voice.beats.append(
            beat_factory(
                voice=voice,
                start_tick=voice.measure.header.start,
                duration_ticks=measure_length_ticks,
            )
        )


def build_track_measures(
    track: gp.Track,
    source_track: dict[str, Any],
    numerator: int,
    denominator: int,
    track_report: dict[str, Any],
) -> None:
    beats_per_measure = numerator * (4 / denominator)
    measure_length_ticks = beats_to_ticks(beats_per_measure)
    source_notes = source_track.get("notes", [])

    if not isinstance(source_notes, list):
        track_report["warnings"].append("Track notes field is not an array.")
        source_notes = []

    track_report["notesInput"] = len(source_notes)
    notes_by_voice: list[list[dict[str, Any]]] = [[], []]

    for note in source_notes:
        if not isinstance(note, dict):
            track_report["notesSkipped"] += 1
            track_report["warnings"].append("Skipped non-object note.")
            continue

        try:
            voice_index = int(note.get("voice", 0))
        except Exception:
            voice_index = 0

        voice_index = 1 if voice_index == 1 else 0
        notes_by_voice[voice_index].append(note)

    grouped_by_voice = [
        group_notes_by_measure_and_start(
            notes=voice_notes,
            measure_length_ticks=measure_length_ticks,
            track_report=track_report,
        )
        for voice_notes in notes_by_voice
    ]

    for measure_index, measure in enumerate(track.measures):
        for existing_voice in measure.voices:
            existing_voice.beats.clear()

        for voice_index, voice in enumerate(measure.voices[:2]):
            populate_measure_voice(
                voice=voice,
                local_events=grouped_by_voice[voice_index].get(measure_index, {}),
                measure_length_ticks=measure_length_ticks,
                track=track,
                track_report=track_report,
                use_empty_beat_when_silent=voice_index == 1,
            )


def create_track_report(name: str, kind: str, muted: bool) -> dict[str, Any]:
    return {
        "name": name,
        "kind": kind,
        "muted": muted,
        "notesInput": 0,
        "notesWritten": 0,
        "notesSkipped": 0,
        "effectiveTuning": [],
        "fretCount": DEFAULT_FRET_COUNT,
        "globalOctaveShift": 0,
        "planningMetrics": {},
        "voicesUsed": 1,
        "octaveAdjustedNotes": 0,
        "octaveAdjustments": [],
        "unplaceablePitches": {},
        "plannedPositionErrors": [],
        "percussionElements": {
            "kick": 0,
            "snare": 0,
            "closed-hihat": 0,
            "pedal-hihat": 0,
            "open-hihat": 0,
            "ride": 0,
            "ride-bell": 0,
            "crash": 0,
        },
        "duplicatesMerged": 0,
        "warnings": [],
    }


def get_melodic_midi_channel(index: int) -> int:
    port_index, channel_index = divmod(index, 15)
    local_channel = (
        channel_index
        if channel_index < PERCUSSION_MIDI_CHANNEL
        else channel_index + 1
    )
    return port_index * 16 + local_channel


def build_song(data: dict[str, Any], report: dict[str, Any]) -> gp.Song:
    song_info = data.get("song", {})

    if not isinstance(song_info, dict):
        song_info = {}

    title = str(song_info.get("title", "Ableton Live Export"))
    tempo = int(song_info.get("tempo", 120))

    time_signature = song_info.get("timeSignature", {})

    if not isinstance(time_signature, dict):
        time_signature = {}

    numerator = int(time_signature.get("numerator", 4))
    denominator = int(time_signature.get("denominator", 4))

    if numerator <= 0 or denominator <= 0:
        raise ConversionError("Invalid time signature.")

    tracks_input = data.get("tracks", [])

    if not isinstance(tracks_input, list):
        raise ConversionError("'tracks' must be an array.")

    report["tracksInput"] = len(tracks_input)

    measure_length_ticks = numerator * gp.Duration(value=denominator).time
    measure_count = get_measure_count(data, measure_length_ticks)

    song = gp.Song()
    song.title = title
    song.tempo = tempo
    song.tempoName = str(tempo)

    song.measureHeaders = create_measure_headers(
        measure_count=measure_count,
        numerator=numerator,
        denominator=denominator,
    )

    song.tracks = []
    melodic_track_index = 0

    for index, source_track in enumerate(tracks_input, start=1):
        if not isinstance(source_track, dict):
            report["warnings"].append(f"Skipped invalid track at index {index}.")
            continue

        name = str(source_track.get("name", f"Track {index}"))
        kind = str(source_track.get("kind", "guitar"))
        is_drums = kind.lower() == "drums"
        muted = bool(source_track.get("muted", False))

        source_notes = source_track.get("notes", [])
        if not isinstance(source_notes, list):
            source_notes = []

        track_report = create_track_report(name=name, kind=kind, muted=muted)
        source_plan = source_track.get("plan", {})

        if isinstance(source_plan, dict):
            try:
                track_report["globalOctaveShift"] = int(
                    source_plan.get("globalOctaveShift", 0)
                )
            except Exception:
                track_report["globalOctaveShift"] = 0

            planning_metrics = source_plan.get("metrics", {})
            if isinstance(planning_metrics, dict):
                track_report["planningMetrics"] = planning_metrics

        track_report["voicesUsed"] = 1
        for note in source_notes:
            if not isinstance(note, dict):
                continue

            try:
                if int(note.get("voice", 0)) == 1:
                    track_report["voicesUsed"] = 2
                    break
            except Exception:
                continue

        tuning = [] if is_drums else infer_default_tuning(kind)

        track_report["effectiveTuning"] = (
            [0] * 7 if is_drums else tuning
        )

        fret_count = DEFAULT_FRET_COUNT

        gp_strings = (
            make_percussion_strings()
            if is_drums
            else make_gp_strings(tuning)
        )

        if is_drums:
            midi_channel_number = PERCUSSION_MIDI_CHANNEL
            midi_instrument = 0
        else:
            midi_channel_number = get_melodic_midi_channel(
                melodic_track_index
            )
            melodic_track_index += 1
            midi_instrument = (
                BASS_MIDI_INSTRUMENT
                if kind.lower() == "bass"
                else GUITAR_MIDI_INSTRUMENT
            )

        midi_channel = gp.MidiChannel(
            channel=midi_channel_number,
            effectChannel=midi_channel_number,
            instrument=midi_instrument,
        )

        if muted:
            midi_channel.volume = 0

        track_settings = gp.TrackSettings(
            tablature=not is_drums,
            notation=True,
        )

        track = gp.Track(
            song=song,
            number=len(song.tracks) + 1,
            name=name,
            strings=gp_strings,
            channel=midi_channel,
            port=midi_channel_number // 16 + 1,
            clefTranspose=12 if kind.lower() == "bass" else 0,
            fretCount=fret_count,
            settings=track_settings,
            isPercussionTrack=is_drums,
        )

        build_track_measures(
            track=track,
            source_track=source_track,
            numerator=numerator,
            denominator=denominator,
            track_report=track_report,
        )

        if track_report["notesSkipped"] > 0:
            skipped = track_report["notesSkipped"]
            track_report["warnings"].append(f"{skipped} note(s) skipped.")

        if track_report["unplaceablePitches"]:
            track_report["warnings"].append(
                "Some notes could not be placed on the fretboard."
            )

        if track_report["plannedPositionErrors"]:
            track_report["warnings"].append(
                "Some planned string/fret positions were invalid."
            )

        if track_report["octaveAdjustedNotes"] > 0:
            track_report["warnings"].append(
                f"{track_report['octaveAdjustedNotes']} note(s) were moved by "
                "octaves to fit the tablature."
            )

        if track_report["duplicatesMerged"] > 0:
            track_report["warnings"].append(
                f"{track_report['duplicatesMerged']} duplicate drum hit(s) "
                "were merged after quantization."
            )

        report["notesInput"] += track_report["notesInput"]
        report["notesWritten"] += track_report["notesWritten"]
        report["notesSkipped"] += track_report["notesSkipped"]
        report["tracks"].append(track_report)

        song.tracks.append(track)

    if not song.tracks:
        track = gp.Track(song=song, number=1, name="Empty Track")
        song.tracks.append(track)
        report["warnings"].append("No valid tracks found. Created empty track.")

    report["tracksWritten"] = len(song.tracks)
    report["measuresWritten"] = len(song.measureHeaders)

    return song


def main() -> int:
    report = make_report()

    if len(sys.argv) != 3:
        print("Usage: python converter/ableton_to_gp5.py input.json output.gp5")
        return 1

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    report["inputJson"] = str(input_path)
    report["outputGp5"] = str(output_path)

    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)

        data = load_json(input_path)
        song = build_song(data, report)

        guitarpro.write(song, output_path, version=(5, 1, 0))

        report_path = write_conversion_report(output_path, report)

        print(f"GP5 written: {output_path}")
        print(f"Conversion report written: {report_path}")
        print(f"Tracks: {len(song.tracks)}")
        print(f"Measures: {len(song.measureHeaders)}")
        print(f"Notes written: {report['notesWritten']}")
        print(f"Notes skipped: {report['notesSkipped']}")

        return 0

    except Exception as error:
        report["error"] = str(error)
        report["traceback"] = traceback.format_exc()

        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            report_path = write_conversion_report(output_path, report)
            print(f"Conversion report written: {report_path}")
        except Exception:
            pass

        print(f"Conversion failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
