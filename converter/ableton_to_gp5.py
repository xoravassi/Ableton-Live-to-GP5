import json
import math
import sys
from pathlib import Path
from typing import Any

import guitarpro
from guitarpro import models as gp


TICKS_PER_BEAT = gp.Duration.quarterTime  # 960

ALLOWED_DURATIONS = [
    gp.Duration.quarterTime * 4,      # ronde
    gp.Duration.quarterTime * 3,      # blanche pointée
    gp.Duration.quarterTime * 2,      # blanche
    gp.Duration.quarterTime * 3 // 2, # noire pointée
    gp.Duration.quarterTime,          # noire
    gp.Duration.quarterTime * 3 // 4, # croche pointée
    gp.Duration.quarterTime // 2,     # croche
    gp.Duration.quarterTime * 3 // 8, # double croche pointée
    gp.Duration.quarterTime // 4,     # double croche
    gp.Duration.quarterTime // 8,     # triple croche
]


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


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
) -> gp.Beat:
    beat = gp.Beat(
        voice=voice,
        duration=duration_from_ticks(duration_ticks),
        start=start_tick,
        status=gp.BeatStatus.normal,
    )

    used_strings: set[int] = set()

    for note_data in notes:
        pitch = int(note_data["pitch"])
        velocity = int(note_data.get("velocity", gp.Velocities.default))

        position = choose_string_and_fret(
            pitch=pitch,
            track=track,
            used_strings=used_strings,
        )

        if position is None:
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

    if not beat.notes:
        beat.status = gp.BeatStatus.rest

    return beat


def make_gp_strings(tuning_low_to_high: list[int]) -> list[gp.GuitarString]:
    high_to_low = list(reversed(tuning_low_to_high))

    return [
        gp.GuitarString(number=index + 1, value=pitch)
        for index, pitch in enumerate(high_to_low)
    ]


def infer_default_tuning(track_kind: str) -> list[int]:
    if track_kind.lower() == "bass":
        return [28, 33, 38, 43]  # E1 A1 D2 G2

    return [40, 45, 50, 55, 59, 64]  # E2 A2 D3 G3 B3 E4


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
        for note in track.get("notes", []):
            start = float(note.get("start", 0))
            duration = float(note.get("duration", 0))
            max_end = max(max_end, start + duration)

    return max(1.0, max_end)


def group_notes_by_measure_and_start(
    notes: list[dict[str, Any]],
    beats_per_measure: int,
) -> dict[int, dict[int, list[dict[str, Any]]]]:
    grouped: dict[int, dict[int, list[dict[str, Any]]]] = {}

    for note in notes:
        start_beats = float(note.get("start", 0))
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
) -> None:
    beats_per_measure = numerator * (4 / denominator)
    measure_length_ticks = beats_to_ticks(beats_per_measure)

    grouped = group_notes_by_measure_and_start(
        source_track.get("notes", []),
        beats_per_measure=int(beats_per_measure),
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

            raw_duration_ticks = min(
                quantize_ticks(beats_to_ticks(float(note.get("duration", 1))))
                for note in notes_at_start
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


def build_song(data: dict[str, Any]) -> gp.Song:
    song_info = data.get("song", {})

    title = song_info.get("title", "Ableton Live Export")
    tempo = int(song_info.get("tempo", 120))

    time_signature = song_info.get("timeSignature", {})
    numerator = int(time_signature.get("numerator", 4))
    denominator = int(time_signature.get("denominator", 4))

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

    for index, source_track in enumerate(data.get("tracks", []), start=1):
        name = source_track.get("name", f"Track {index}")
        kind = source_track.get("kind", "guitar")

        tuning = source_track.get("tuning")
        if not tuning:
            tuning = infer_default_tuning(kind)

        gp_strings = make_gp_strings(tuning)

        midi_instrument = 33 if kind.lower() == "bass" else 25
        muted = bool(source_track.get("muted", False))

        midi_channel = gp.MidiChannel(
            channel=(index - 1) % 16,
            effectChannel=(index - 1) % 16,
            instrument=midi_instrument,
        )

        if muted:
            midi_channel.volume = 0

        track = gp.Track(
            song=song,
            number=index,
            name=name,
            strings=gp_strings,
            channel=midi_channel,
            clefTranspose=12 if kind.lower() == "bass" else 0,
        )

        build_track_measures(
            track=track,
            source_track=source_track,
            numerator=numerator,
            denominator=denominator,
        )

        song.tracks.append(track)

    if not song.tracks:
        track = gp.Track(song=song, number=1, name="Empty Track")
        song.tracks.append(track)

    return song


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: python converter/ableton_to_gp5.py input.json output.gp5")
        return 1

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    if not input_path.exists():
        print(f"Input file not found: {input_path}")
        return 1

    output_path.parent.mkdir(parents=True, exist_ok=True)

    data = load_json(input_path)
    song = build_song(data)

    guitarpro.write(song, output_path, version=(5, 1, 0))

    print(f"GP5 written: {output_path}")
    print(f"Tracks: {len(song.tracks)}")
    print(f"Measures: {len(song.measureHeaders)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())