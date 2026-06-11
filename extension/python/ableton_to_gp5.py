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
MAX_FRET_COUNT = 127

# Au-dessus de ce seuil, une piste "guitar" devient une piste notation seule.
# Exemple : note MIDI 102 sur corde E aiguë 64 = frette 38.
# Plutôt que créer une tab illisible, on bascule en notation seule.
STANDARD_GUITAR_MAX_FRET_FOR_TAB = 36

PIANO_MIDI_INSTRUMENT = 0
GUITAR_MIDI_INSTRUMENT = 25
BASS_MIDI_INSTRUMENT = 33

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
        return [28, 33, 38, 43]  # E1 A1 D2 G2

    return [40, 45, 50, 55, 59, 64]  # E2 A2 D3 G3 B3 E4


def normalize_tuning(raw_tuning: Any, track_kind: str) -> tuple[list[int], bool]:
    if not isinstance(raw_tuning, list) or not raw_tuning:
        return infer_default_tuning(track_kind), True

    tuning: list[int] = []

    for value in raw_tuning:
        try:
            tuning.append(int(value))
        except Exception:
            continue

    if not tuning:
        return infer_default_tuning(track_kind), True

    return tuning, False


def get_track_pitches(source_notes: list[Any]) -> list[int]:
    pitches: list[int] = []

    for note in source_notes:
        if not isinstance(note, dict):
            continue

        try:
            pitches.append(int(note["pitch"]))
        except Exception:
            continue

    return pitches


def should_use_notation_only_track(
    track_kind: str,
    tuning_low_to_high: list[int],
    source_notes: list[Any],
) -> tuple[bool, str | None]:
    # Les basses restent en tab basse, sauf si tu décides plus tard de changer ce comportement.
    if track_kind.lower() == "bass":
        return False, None

    pitches = get_track_pitches(source_notes)

    if not pitches:
        return False, None

    min_pitch = min(pitches)
    max_pitch = max(pitches)

    min_string = min(tuning_low_to_high)
    max_string = max(tuning_low_to_high)

    if min_pitch < min_string:
        return True, (
            f"lowest note MIDI {min_pitch} is below lowest string MIDI {min_string}"
        )

    required_fret = max_pitch - max_string

    if required_fret > STANDARD_GUITAR_MAX_FRET_FOR_TAB:
        return True, (
            f"highest note MIDI {max_pitch} requires fret {required_fret}, "
            f"above notation-only threshold {STANDARD_GUITAR_MAX_FRET_FOR_TAB}"
        )

    return False, None


def make_virtual_notation_tuning(source_notes: list[Any]) -> list[int]:
    pitches = get_track_pitches(source_notes)

    if not pitches:
        return [40, 45, 50, 55, 59, 64]

    min_pitch = min(pitches)
    max_pitch = max(pitches)

    # Si toute la piste tient dans 24 demi-tons, 7 cordes virtuelles identiques suffisent.
    # Exemple : Theme 93–102 → tuning [93,93,...], frettes 0–9.
    if max_pitch - min_pitch <= DEFAULT_FRET_COUNT:
        return [min_pitch] * 7

    # Sinon, on répartit 7 ancres pour couvrir la plage MIDI.
    first_anchor = min_pitch
    last_anchor = max(0, max_pitch - DEFAULT_FRET_COUNT)

    tuning: list[int] = []

    for index in range(7):
        ratio = index / 6
        anchor = round(first_anchor + (last_anchor - first_anchor) * ratio)
        tuning.append(max(0, min(127, anchor)))

    return sorted(tuning)


def compute_fret_count(
    tuning_low_to_high: list[int],
    source_notes: list[Any],
    track_report: dict[str, Any],
) -> int:
    pitches = get_track_pitches(source_notes)

    if not pitches:
        track_report["fretCount"] = DEFAULT_FRET_COUNT
        return DEFAULT_FRET_COUNT

    required_fret_count = DEFAULT_FRET_COUNT
    impossible_low_pitches: dict[str, int] = {}

    for pitch in pitches:
        possible_frets = [
            pitch - string_pitch
            for string_pitch in tuning_low_to_high
            if pitch >= string_pitch
        ]

        if not possible_frets:
            impossible_low_pitches.setdefault(str(pitch), 0)
            impossible_low_pitches[str(pitch)] += 1
            continue

        required_fret_count = max(required_fret_count, min(possible_frets))

    fret_count = min(required_fret_count, MAX_FRET_COUNT)

    if fret_count > DEFAULT_FRET_COUNT:
        track_report["warnings"].append(
            f"Extended fret count to {fret_count} while keeping original tuning."
        )

    if required_fret_count > MAX_FRET_COUNT:
        track_report["warnings"].append(
            f"Some notes may still be too high. Required fret count: "
            f"{required_fret_count}, max allowed: {MAX_FRET_COUNT}."
        )

    if impossible_low_pitches:
        track_report["warnings"].append(
            "Some notes are below the lowest string and may be skipped."
        )
        track_report["impossibleLowPitches"] = impossible_low_pitches

    track_report["fretCount"] = fret_count
    return fret_count


def make_gp_strings(tuning_low_to_high: list[int]) -> list[gp.GuitarString]:
    # JSON: grave → aigu.
    # PyGuitarPro / GP: aigu → grave.
    high_to_low = list(reversed(tuning_low_to_high))

    return [
        gp.GuitarString(number=index + 1, value=int(pitch))
        for index, pitch in enumerate(high_to_low)
    ]


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

    used_strings: set[int] = set()

    for note_data in notes:
        try:
            pitch = int(note_data["pitch"])
        except Exception:
            track_report["notesSkipped"] += 1
            track_report["warnings"].append("Skipped note with missing/invalid pitch.")
            continue

        velocity = clamp_velocity(note_data.get("velocity", gp.Velocities.default))

        position = choose_string_and_fret(
            pitch=pitch,
            track=track,
            used_strings=used_strings,
        )

        if position is None:
            track_report["notesSkipped"] += 1
            track_report["unplaceablePitches"].setdefault(str(pitch), 0)
            track_report["unplaceablePitches"][str(pitch)] += 1
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


def get_song_length_in_beats(data: dict[str, Any]) -> float:
    max_end = 0.0

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

            max_end = max(max_end, start + duration)

    return max(1.0, max_end)


def group_notes_by_measure_and_start(
    notes: list[dict[str, Any]],
    beats_per_measure: int,
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

        start_ticks = quantize_ticks(beats_to_ticks(start_beats))

        measure_index = int(start_beats // beats_per_measure)
        measure_start_ticks = measure_index * beats_per_measure * TICKS_PER_BEAT
        local_start_ticks = start_ticks - measure_start_ticks

        grouped.setdefault(measure_index, {})
        grouped[measure_index].setdefault(local_start_ticks, [])
        grouped[measure_index][local_start_ticks].append(note)

    return grouped


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

    grouped = group_notes_by_measure_and_start(
        notes=source_notes,
        beats_per_measure=int(beats_per_measure),
        track_report=track_report,
    )

    for measure_index, measure in enumerate(track.measures):
        for existing_voice in measure.voices:
            existing_voice.beats.clear()

        voice = measure.voices[0]
        local_events = grouped.get(measure_index, {})
        event_starts = sorted(local_events.keys())

        cursor = 0

        for event_index, local_start in enumerate(event_starts):
            local_start = max(0, min(local_start, measure_length_ticks))

            if local_start > cursor:
                for rest_duration in split_duration_ticks(local_start - cursor):
                    absolute_start = measure.header.start + cursor
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
            duration_ticks = min(raw_duration_ticks, max_available)
            duration_ticks = max(TICKS_PER_BEAT // 8, duration_ticks)

            absolute_start = measure.header.start + local_start

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

        if cursor < measure_length_ticks:
            for rest_duration in split_duration_ticks(measure_length_ticks - cursor):
                absolute_start = measure.header.start + cursor
                voice.beats.append(make_rest(voice, absolute_start, rest_duration))
                cursor += rest_duration

        if not voice.beats:
            voice.beats.append(
                make_rest(
                    voice=voice,
                    start_tick=measure.header.start,
                    duration_ticks=measure_length_ticks,
                )
            )

        if len(measure.voices) > 1:
            empty_voice = measure.voices[1]
            empty_voice.beats.clear()
            empty_voice.beats.append(
                make_empty_beat(
                    voice=empty_voice,
                    start_tick=measure.header.start,
                    duration_ticks=measure_length_ticks,
                )
            )


def create_track_report(name: str, kind: str, muted: bool) -> dict[str, Any]:
    return {
        "name": name,
        "kind": kind,
        "muted": muted,
        "notationOnly": False,
        "notationOnlyReason": None,
        "notesInput": 0,
        "notesWritten": 0,
        "notesSkipped": 0,
        "effectiveTuning": [],
        "fretCount": DEFAULT_FRET_COUNT,
        "unplaceablePitches": {},
        "impossibleLowPitches": {},
        "warnings": [],
    }


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

    song_length_beats = get_song_length_in_beats(data)
    beats_per_measure = numerator * (4 / denominator)
    measure_count = max(1, math.ceil(song_length_beats / beats_per_measure))

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

    for index, source_track in enumerate(tracks_input, start=1):
        if not isinstance(source_track, dict):
            report["warnings"].append(f"Skipped invalid track at index {index}.")
            continue

        name = str(source_track.get("name", f"Track {index}"))
        kind = str(source_track.get("kind", "guitar"))
        muted = bool(source_track.get("muted", False))

        source_notes = source_track.get("notes", [])
        if not isinstance(source_notes, list):
            source_notes = []

        track_report = create_track_report(name=name, kind=kind, muted=muted)

        tuning, used_default_tuning = normalize_tuning(
            raw_tuning=source_track.get("tuning"),
            track_kind=kind,
        )

        if used_default_tuning:
            track_report["warnings"].append(
                "Missing or invalid tuning. Used default tuning."
            )

        use_notation_only, notation_only_reason = should_use_notation_only_track(
            track_kind=kind,
            tuning_low_to_high=tuning,
            source_notes=source_notes,
        )

        if use_notation_only:
            tuning = make_virtual_notation_tuning(source_notes)
            fret_count = DEFAULT_FRET_COUNT

            track_report["notationOnly"] = True
            track_report["notationOnlyReason"] = notation_only_reason
            track_report["effectiveTuning"] = tuning
            track_report["fretCount"] = fret_count
            track_report["warnings"].append(
                "Used notation-only virtual track to preserve all MIDI pitches."
            )

            if notation_only_reason:
                track_report["warnings"].append(f"Reason: {notation_only_reason}.")
        else:
            track_report["effectiveTuning"] = tuning

            fret_count = compute_fret_count(
                tuning_low_to_high=tuning,
                source_notes=source_notes,
                track_report=track_report,
            )

        gp_strings = make_gp_strings(tuning)

        if track_report["notationOnly"]:
            midi_instrument = PIANO_MIDI_INSTRUMENT
        else:
            midi_instrument = (
                BASS_MIDI_INSTRUMENT
                if kind.lower() == "bass"
                else GUITAR_MIDI_INSTRUMENT
            )

        midi_channel = gp.MidiChannel(
            channel=(index - 1) % 16,
            effectChannel=(index - 1) % 16,
            instrument=midi_instrument,
        )

        if muted:
            midi_channel.volume = 0

        track_settings = gp.TrackSettings(
            tablature=not track_report["notationOnly"],
            notation=True,
        )

        track = gp.Track(
            song=song,
            number=len(song.tracks) + 1,
            name=name,
            strings=gp_strings,
            channel=midi_channel,
            clefTranspose=12 if kind.lower() == "bass" else 0,
            fretCount=fret_count,
            settings=track_settings,
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