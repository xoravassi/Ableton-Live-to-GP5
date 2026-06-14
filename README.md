# Ableton Live to GP5

Ableton Live extension that exports MIDI clips from the Arrangement View to a
Guitar Pro 5 (`.gp5`) file.

## Requirements

- Ableton Live 12 with Extensions support
- Python 3 available from the `python` command
- [PyGuitarPro](https://github.com/Perlence/PyGuitarPro)

Install the Python dependency once:

```powershell
python -m pip install PyGuitarPro
```

Verify the installation:

```powershell
python -c "import guitarpro; print(guitarpro.__file__)"
```

## Install

1. Download `Ableton-Live-to-GP5.ablx` from the
   [latest GitHub release](https://github.com/xoravassi/Ableton-Live-to-GP5/releases/latest).
2. Open the `.ablx` file to install the extension in Ableton Live.
3. Restart Ableton Live if the action does not appear immediately.

## Export

1. Open a Live Set containing MIDI clips in the Arrangement View.
2. Right-click a MIDI clip or MIDI track.
3. Select **Convert to GP5**.
4. Review the detected instrument and octave for each track, then enter the
   export name.
5. Click **Export**.

The export window opens before tablature planning begins. A preparation view
shows the current track and note count while the extension evaluates the
standard instruments and octave placements.

After conversion, Ableton displays the generated filename and the number of
tracks and notes. Click **Open folder** to access the `.gp5` file.

On Windows, exports are stored in Ableton's extension data directory:

```text
%LOCALAPPDATA%\Ableton\Extensions Data\vassi.ableton-live-to-gp5
```

The export folder also contains JSON reports that can help diagnose a
conversion.

## Export Rules

- Only Arrangement View clips are exported.
- Session View clips are ignored.
- Looped clips are expanded to their Arrangement duration.
- Explicitly muted tracks and clips are ignored.
- Tracks muted only by Ableton's solo state are still exported.
- Drum and percussion tracks are preserved but muted in Guitar Pro.
- Every track uses one standardized instrument: 6-string guitar in E standard,
  7-string guitar in B standard, or 4-string bass in E standard.
- The planner simulates all three instruments and global octave offsets. It
  prioritizes preserving every note, keeping chords in one octave, minimizing
  individual corrections, and producing practical fret positions.
- A global octave move is preferred over many isolated note changes. Remaining
  outliers are moved by octaves at the chord/event level whenever possible.
- Dense chords can use Guitar Pro's second voice so the same string may be used
  once per voice instead of dropping a note.
- The export dialog shows the recommendation and lets each track override the
  instrument and global octave before conversion.
- The conversion report records the selected plan, octave adjustments, voices
  used, and any note that still could not be placed.
- The completion dialog uses the converter's verified written/skipped note
  counts instead of only reporting the number of input MIDI notes.

## Limitations

- Rhythm conversion is intentionally approximate.
- Complex tuplets, articulations, automation and MPE are not exported.
- Drum tracks are not converted to Guitar Pro percussion notation.
- The extension does not receive the Live Set filename from the current SDK,
  so the export name is entered manually.

## Development

From the repository root:

```powershell
npm --prefix extension install
npm --prefix extension run start:gp5
```

Build the installable package:

```powershell
npm --prefix extension run package:gp5
```

Output:

```text
extension\dist\Ableton-Live-to-GP5.ablx
```
