# Ableton Live to GP5

![Ableton Live to Guitar Pro](extension/src/assets/cover.png)

Convert MIDI clips from Ableton Live's Arrangement View into an editable
Guitar Pro 5 (`.gp5`) score.

The extension automatically:

- chooses a standard guitar, 7-string guitar or bass for each track;
- moves out-of-range notes by octaves when needed;
- exports supported drums to a real Guitar Pro percussion track;
- lets you review every instrument and octave choice before export.

## Install

1. Download `Ableton-Live-to-GP5.ablx` from the
   [latest release](https://github.com/xoravassi/Ableton-Live-to-GP5/releases/latest).
2. Open the downloaded file.
3. Restart Ableton Live if **Convert to GP5** does not appear immediately.

## First Launch

The extension needs Python and PyGuitarPro to create GP5 files.

It checks them automatically when it starts. On Windows, if something is
missing, select **Install missing dependency**. The commands are shown before
anything is installed.

When the check is complete, select **Get started**.

## Export a Live Set

1. Open a Live Set with MIDI clips in Arrangement View.
2. Right-click a MIDI clip or MIDI track.
3. Select **Convert to GP5**.
4. Select **Get started** after the automatic check.
5. Review the suggested instruments and octave changes.
6. Enter an export name and select **Export GP5**.

When the export is complete, select **Open folder** to find the GP5 file.

## What Is Exported

- MIDI clips from Arrangement View
- Looped clips, expanded to their full Arrangement length
- Standard 6-string guitar, 7-string guitar and 4-string bass tablatures
- Kick, snare, closed/open/pedal hi-hat, ride, ride bell and crash cymbal

Session View clips and manually muted tracks or clips are not exported.

## Export Folder

On Windows, files are normally stored here:

```text
%LOCALAPPDATA%\Ableton\Extensions Data\vassi.ableton-live-to-gp5
```

Each export includes the GP5 file and small diagnostic files. You can ignore
the diagnostic files unless an export needs troubleshooting.

## Current Limitations

- Timing is rounded to the nearest 1/32 note.
- Tuplets, groove, automation, articulations and MPE are not preserved.
- Claps, toms and unsupported percussion are currently omitted.
- Drum detection works best when tracks, Drum Rack pads or samples have clear
  names such as `kick`, `snare`, `hihat`, `ride` or `crash`.
- Ableton does not provide the Live Set filename to the extension, so the
  export name must be entered manually.

## Troubleshooting

**Convert to GP5 is missing**

Restart Ableton Live after installing the `.ablx` file.

**The dependency check fails**

Install PyGuitarPro manually, then restart Ableton Live:

```powershell
python -m pip install --upgrade PyGuitarPro
```

**A drum is missing or incorrect**

Rename the Ableton track, Drum Rack pad or sample so that it clearly contains
the instrument name.

## Development

From the repository root:

```powershell
npm --prefix extension install
npm --prefix extension run start:gp5
```

Run the tests:

```powershell
npm --prefix extension test
```

Build the installable extension:

```powershell
npm --prefix extension run package:gp5
```

Output:

```text
extension\dist\Ableton-Live-to-GP5.ablx
```
