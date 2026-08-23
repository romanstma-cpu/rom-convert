# Third-party notices

ROM Convert's own source is MIT licensed — see [LICENSE](LICENSE). That grant
does not extend to the components below, which carry their own terms.

This notice lives outside `LICENSE` on purpose: GitHub only recognises a
licence file that matches a known licence verbatim, and text appended to it
makes the repository report its licence as "Other".

## FFmpeg

A static FFmpeg build is bundled with the application and performs every
conversion. It is obtained through the
[`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) package and
accounts for most of the installer's size.

FFmpeg is licensed under the LGPL v2.1 or later, or the GPL v2 or later
depending on how the particular build was configured. The bundled build
reports its configuration with `ffmpeg -version`.

- Project: <https://ffmpeg.org>
- Licensing: <https://ffmpeg.org/legal.html>
- Source: <https://git.ffmpeg.org/ffmpeg.git>

FFmpeg is invoked as a separate process; ROM Convert does not link against it.

## Electron

The application is built on [Electron](https://www.electronjs.org), which is
MIT licensed and bundles Chromium (BSD-3-Clause and others) and Node.js
(MIT and others).

## Runtime dependencies

`electron-updater` (MIT), `react` and `react-dom` (MIT). Full details are in
`package-lock.json`.
