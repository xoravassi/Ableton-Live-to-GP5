import tempfile
import unittest
from pathlib import Path

import guitarpro

from ableton_to_gp5 import (
    TICKS_PER_BEAT,
    build_song,
    create_track_report,
    group_notes_by_measure_and_start,
    make_report,
)


class MeasureGroupingTests(unittest.TestCase):
    def test_quantized_note_moves_to_next_measure(self) -> None:
        report = create_track_report("Boundary", "guitar", False)
        grouped = group_notes_by_measure_and_start(
            notes=[{"pitch": 60, "start": 3.99, "duration": 1}],
            measure_length_ticks=4 * TICKS_PER_BEAT,
            track_report=report,
        )

        self.assertEqual({1: {0: grouped[1][0]}}, grouped)

    def test_three_eight_uses_fractional_beat_measure_length(self) -> None:
        report = create_track_report("3/8", "guitar", False)
        grouped = group_notes_by_measure_and_start(
            notes=[
                {"pitch": 60, "start": 1.4, "duration": 0.25},
                {"pitch": 62, "start": 1.6, "duration": 0.25},
            ],
            measure_length_ticks=3 * TICKS_PER_BEAT // 2,
            track_report=report,
        )

        self.assertIn(0, grouped)
        self.assertIn(1, grouped)
        self.assertEqual(1, sum(len(events) for events in grouped[0].values()))
        self.assertEqual(1, sum(len(events) for events in grouped[1].values()))


class SongRoundTripTests(unittest.TestCase):
    def test_boundary_note_is_written_in_second_measure(self) -> None:
        report = make_report()
        song = build_song(
            {
                "song": {
                    "title": "Boundary",
                    "tempo": 120,
                    "timeSignature": {"numerator": 4, "denominator": 4},
                },
                "tracks": [
                    {
                        "name": "Guitar",
                        "kind": "guitar",
                        "notes": [
                            {
                                "pitch": 60,
                                "start": 3.99,
                                "duration": 1,
                                "velocity": 100,
                            }
                        ],
                    }
                ],
            },
            report,
        )

        first_measure_notes = sum(
            len(beat.notes)
            for voice in song.tracks[0].measures[0].voices
            for beat in voice.beats
        )
        second_measure_notes = sum(
            len(beat.notes)
            for voice in song.tracks[0].measures[1].voices
            for beat in voice.beats
        )

        self.assertEqual(0, first_measure_notes)
        self.assertEqual(1, second_measure_notes)

    def test_short_boundary_note_still_creates_second_measure(self) -> None:
        report = make_report()
        song = build_song(
            {
                "song": {
                    "title": "Short boundary",
                    "tempo": 120,
                    "timeSignature": {"numerator": 4, "denominator": 4},
                },
                "tracks": [
                    {
                        "name": "Guitar",
                        "kind": "guitar",
                        "notes": [
                            {
                                "pitch": 60,
                                "start": 3.99,
                                "duration": 0.001,
                                "velocity": 100,
                            }
                        ],
                    }
                ],
            },
            report,
        )

        self.assertEqual(2, len(song.measureHeaders))
        self.assertEqual(1, report["notesWritten"])

    def test_three_eight_measure_headers_are_valid(self) -> None:
        report = make_report()
        song = build_song(
            {
                "song": {
                    "title": "3/8",
                    "tempo": 120,
                    "timeSignature": {"numerator": 3, "denominator": 8},
                },
                "tracks": [
                    {
                        "name": "Guitar",
                        "kind": "guitar",
                        "notes": [
                            {
                                "pitch": 60,
                                "start": 1.4,
                                "duration": 0.25,
                                "velocity": 100,
                            },
                            {
                                "pitch": 62,
                                "start": 1.6,
                                "duration": 0.25,
                                "velocity": 100,
                            },
                        ],
                    }
                ],
            },
            report,
        )

        self.assertEqual(2, len(song.measureHeaders))
        self.assertEqual(2, report["notesWritten"])
        self.assertEqual(
            3 * guitarpro.models.Duration.quarterTime // 2,
            song.measureHeaders[1].start - song.measureHeaders[0].start,
        )

    def test_explicit_unplaceable_note_is_reported(self) -> None:
        report = make_report()
        build_song(
            {
                "song": {
                    "title": "Unplaceable",
                    "tempo": 120,
                    "timeSignature": {"numerator": 4, "denominator": 4},
                },
                "tracks": [
                    {
                        "name": "Bass",
                        "kind": "bass",
                        "notes": [
                            {
                                "pitch": 90,
                                "adjustedPitch": 90,
                                "placementStatus": "unplaceable",
                                "start": 0,
                                "duration": 1,
                                "velocity": 100,
                            }
                        ],
                    }
                ],
            },
            report,
        )

        self.assertEqual(1, report["notesSkipped"])
        self.assertEqual({"90": 1}, report["tracks"][0]["unplaceablePitches"])

    def test_invalid_strict_plan_does_not_fallback_silently(self) -> None:
        report = make_report()
        build_song(
            {
                "song": {
                    "title": "Invalid plan",
                    "tempo": 120,
                    "timeSignature": {"numerator": 4, "denominator": 4},
                },
                "tracks": [
                    {
                        "name": "Guitar",
                        "kind": "guitar",
                        "notes": [
                            {
                                "pitch": 64,
                                "adjustedPitch": 64,
                                "placementStatus": "placed",
                                "string": 6,
                                "fret": 0,
                                "start": 0,
                                "duration": 1,
                                "velocity": 100,
                            }
                        ],
                    }
                ],
            },
            report,
        )

        self.assertEqual(0, report["notesWritten"])
        self.assertEqual(1, report["notesSkipped"])
        self.assertEqual(1, len(report["tracks"][0]["plannedPositionErrors"]))

    def test_legacy_note_without_plan_still_uses_fallback(self) -> None:
        report = make_report()
        build_song(
            {
                "song": {
                    "title": "Legacy",
                    "tempo": 120,
                    "timeSignature": {"numerator": 4, "denominator": 4},
                },
                "tracks": [
                    {
                        "name": "Guitar",
                        "kind": "guitar",
                        "notes": [
                            {
                                "pitch": 100,
                                "start": 0,
                                "duration": 1,
                                "velocity": 100,
                            }
                        ],
                    }
                ],
            },
            report,
        )

        self.assertEqual(1, report["notesWritten"])
        self.assertEqual(0, report["notesSkipped"])

    def test_supported_drums_create_real_percussion_track(self) -> None:
        report = make_report()
        song = build_song(
            {
                "song": {
                    "title": "Drums",
                    "tempo": 120,
                    "timeSignature": {"numerator": 4, "denominator": 4},
                },
                "tracks": [
                    {
                        "name": "Main drums",
                        "kind": "drums",
                        "notes": [
                            {
                                "pitch": 48,
                                "percussionValue": 36,
                                "drumElement": "kick",
                                "start": 0,
                                "duration": 0.25,
                                "velocity": 110,
                            },
                            {
                                "pitch": 49,
                                "percussionValue": 38,
                                "drumElement": "snare",
                                "start": 0,
                                "duration": 0.25,
                                "velocity": 105,
                            },
                            {
                                "pitch": 50,
                                "percussionValue": 42,
                                "drumElement": "closed-hihat",
                                "start": 0,
                                "duration": 0.25,
                                "velocity": 100,
                            },
                            {
                                "pitch": 51,
                                "percussionValue": 46,
                                "drumElement": "open-hihat",
                                "start": 0,
                                "duration": 0.25,
                                "velocity": 100,
                            },
                            {
                                "pitch": 52,
                                "percussionValue": 49,
                                "drumElement": "crash",
                                "start": 0,
                                "duration": 0.25,
                                "velocity": 100,
                            },
                            {
                                "pitch": 53,
                                "percussionValue": 51,
                                "drumElement": "ride",
                                "start": 0,
                                "duration": 0.25,
                                "velocity": 100,
                            },
                            {
                                "pitch": 54,
                                "percussionValue": 44,
                                "drumElement": "pedal-hihat",
                                "start": 1,
                                "duration": 0.25,
                                "velocity": 100,
                            },
                            {
                                "pitch": 55,
                                "percussionValue": 53,
                                "drumElement": "ride-bell",
                                "start": 1,
                                "duration": 0.25,
                                "velocity": 100,
                            },
                        ],
                    }
                ],
            },
            report,
        )

        track = song.tracks[0]
        notes = [
            note
            for measure in track.measures
            for voice in measure.voices
            for beat in voice.beats
            for note in beat.notes
        ]

        self.assertTrue(track.isPercussionTrack)
        self.assertEqual(9, track.channel.channel)
        self.assertFalse(track.settings.tablature)
        self.assertTrue(track.settings.notation)
        self.assertEqual([0] * 7, [string.value for string in track.strings])
        self.assertEqual(
            [36, 38, 42, 46, 49, 51, 44, 53],
            [note.value for note in notes],
        )
        self.assertEqual(
            {
                "kick": 1,
                "snare": 1,
                "closed-hihat": 1,
                "pedal-hihat": 1,
                "open-hihat": 1,
                "ride": 1,
                "ride-bell": 1,
                "crash": 1,
            },
            report["tracks"][0]["percussionElements"],
        )
        self.assertEqual(8, report["notesWritten"])

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "drums.gp5"
            guitarpro.write(song, output, version=(5, 1, 0))
            parsed = guitarpro.parse(output)
            parsed_track = parsed.tracks[0]
            parsed_values = [
                note.value
                for measure in parsed_track.measures
                for voice in measure.voices
                for beat in voice.beats
                for note in beat.notes
            ]

        self.assertTrue(parsed_track.isPercussionTrack)
        self.assertEqual(9, parsed_track.channel.channel)
        self.assertEqual(
            [36, 38, 42, 44, 46, 49, 51, 53],
            sorted(parsed_values),
        )

    def test_melodic_tracks_never_use_percussion_channel(self) -> None:
        report = make_report()
        tracks = [
            {
                "name": f"Guitar {index}",
                "kind": "guitar",
                "notes": [
                    {
                        "pitch": 60,
                        "start": index,
                        "duration": 0.25,
                        "velocity": 100,
                    }
                ],
            }
            for index in range(16)
        ]
        song = build_song(
            {
                "song": {
                    "title": "Channels",
                    "tempo": 120,
                    "timeSignature": {"numerator": 4, "denominator": 4},
                },
                "tracks": tracks,
            },
            report,
        )

        self.assertTrue(
            all(
                track.channel.channel % 16 != 9
                for track in song.tracks
            )
        )


if __name__ == "__main__":
    unittest.main()
