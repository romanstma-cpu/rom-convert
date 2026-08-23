# ROM Convert

Convert video, audio and images on your own PC. No upload, no watermark, no
account, no file size limit.

Part of [ROM](https://romapps.xyz) — free Windows apps.

## Why

Every free online converter wants your file on their server. You hand over a
holiday video, a contract, an interview recording, and it sits on someone
else's disk with a retention policy you did not read. Then they cap the size at
100 MB, stamp a watermark on the result, or ask you to sign up.

ROM Convert does the conversion locally with a bundled copy of ffmpeg. Nothing
is uploaded, and the app works with no network connection at all.

## What it does

| | |
|---|---|
| Video | MP4 (H.264), MP4 (H.265), WebM (VP9), GIF |
| Audio | MP3, M4A, WAV, FLAC — also pulled straight out of a video |
| Image | JPG, PNG, WebP |
| Controls | quality preset, resolution cap, trim, output folder |
| Queue | many files at once, live progress, cancel anything mid-run |

Some deliberate behaviour worth knowing:

- **Nothing is ever overwritten.** Converting `clip.mov` to MP4 twice gives you
  `clip.mp4` and `clip (1).mp4`. Writing over the input is refused outright.
- **A cancelled or failed conversion deletes its partial file.** A truncated
  video that looks like a result is worse than no result.
- **Downscaling only.** A 720p cap leaves a 480p source alone rather than
  blowing it up into a blurry 720p.

## Install

Download the installer from [romapps.xyz](https://romapps.xyz). Windows 10 or
11, 64-bit.

The installer is not code-signed yet, so SmartScreen will say the publisher is
unknown — *More info* → *Run anyway*. Updates after that are automatic.

## Building

```
npm install
npm run dist
```

`npm install` fetches a static ffmpeg build (~83 MB), which is why the
installer is large. It is unpacked out of the asar at build time, because a
binary inside an asar archive can be read but not executed.

`winget/` holds validated manifests for the Windows Package Manager. To publish
a version, refresh `PackageVersion`, `InstallerUrl` and `InstallerSha256`, then
copy the three files into `manifests/r/ROM/Convert/<version>/` in a fork of
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) and open a
pull request. Check them first with `winget validate --manifest winget`.

Releases go to this repo, never to `rom-apps`. electron-updater resolves its
feed from the newest release in a repo, so two auto-updating apps sharing one
release channel take turns breaking each other's update checks.

## Testing

```
npm run check       # typecheck + logic tests, fast
npm run check:all   # the above plus real encodes and a live app
```

Three suites, because they catch different things:

- **`playtest`** (96) — argument building, output naming, progress parsing,
  failure messages, queue behaviour, settings. No ffmpeg, no window.
- **`ffcheck`** (43) — runs the real bundled ffmpeg. Every format is encoded
  and checked on disk; resolution caps and trims are read back out of the
  result; cancelling is verified to delete the partial file.
- **`ipccheck`** (30) — launches the actual app and drives it over the DevTools
  protocol. Walks every method on the preload bridge, clicks real buttons
  through Chromium's input pipeline, and runs one conversion end to end.

The third suite exists because the first two both pass on an app whose UI is
wired to nothing: a handler nobody bridged, or a bridge nobody calls, looks
perfectly healthy in a unit test.

## Layout

```
electron/
  main.ts              window, IPC, single-instance lock
  preload.ts           the contextBridge surface
  crashlog.ts          turns a blank Electron dialog into a real message
  updater.ts           auto-update, refuses to restart mid-conversion
  media/
    binary.ts          finds ffmpeg, including inside app.asar.unpacked
    presets.ts         output formats and the ffmpeg arguments for each
    files.ts           kind detection, collision-free output names
    queue.ts           the job runner: spawn, progress, cancel, cleanup
    store.ts           settings persistence
src/                   React renderer
```

## Licence

MIT — see [LICENSE](LICENSE). The bundled FFmpeg carries its own terms; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
