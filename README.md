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
3. Select **Export to GP5**.
4. Review the detected tracks and enter the export name.
5. Click **Exporter**.

After conversion, Ableton displays the generated filename and the number of
tracks and notes. Click **Ouvrir le dossier** to access the `.gp5` file.

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
- Parts outside a practical guitar range use notation-only tracks to preserve
  their notes.

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
