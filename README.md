# Movie Cast Browser

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/thuongtin/movie-cast-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/thuongtin/movie-cast-browser/actions/workflows/ci.yml)
[![Electron](https://img.shields.io/badge/Electron-39-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)

A small desktop browser that detects direct video URLs inside a web page and casts that media to a Chromecast or a TV with Chromecast built in. It does not mirror your screen: it sends the media URL to the device so the TV streams it directly. The renderer is built with React, Tailwind CSS, and shadcn/ui style components.

> Read this in Vietnamese: [README.vi.md](README.vi.md)

## Features

- Detects `video` tags and direct media files (`.mp4`, `.m3u8`, `.mpd`, `.webm`) while you browse.
- Detects standalone subtitle tracks from `<track>`, HLS subtitle groups, and common subtitle URLs.
- Casts the selected media to a Chromecast on the same LAN, no screen mirroring.
- Auto scans for devices on launch and remembers the last device you cast to.
- In app preview of the selected link, including HLS playback through `hls.js`.
- Shows media duration and resolution when available.
- TV controls: play, pause, seek, volume, mute, stop, and a media queue.
- Remembers the app audio mute setting.
- Resumes playback position per media URL when you cast the same link again.
- Smart cast handling that retries when a sleeping TV is still waking up.

## Requirements

- Node.js 20 or newer.
- A Chromecast or Chromecast built in TV on the same local network.
- A network that allows mDNS so devices can be discovered.

## Install and run

```bash
npm install
npm start
```

`npm start` checks the Electron binary before opening the app. On macOS, allow the Local Network permission when prompted so the app can discover Chromecast devices.

## Usage

1. Open the app. If you used it before, it reopens the last page. Otherwise, type the URL of a video page.
2. When the page exposes a `video` tag or a `.mp4`, `.m3u8`, `.mpd`, or `.webm` file, the link appears under "Link phim".
3. Use the history list to reopen a recently visited page.
4. Click "Quét" to scan for Chromecast devices on the LAN.
5. Select a video, select a device, then click "Cast video".
6. After casting, use the TV controls to play, pause, seek, change volume, mute, or stop.
7. If the TV already has an active cast session, select the device and click "Kết nối TV" to take back control.
8. While casting, select another link and click "Thêm hàng đợi" to add it to the TV queue.

## Preview

The selected link shows a preview panel below it. For HLS `.m3u8` links, the app uses `hls.js` to try the preview in app before casting. If the CDN blocks the preview with CORS or custom headers, you can still try to cast the link to the TV.

## Advanced casting

- Playback position is saved per media URL and resumed when you cast the same link again.
- Standalone WebVTT, TTML, and HLS subtitle tracks can be attached to the Cast media request. Public SRT files are converted through a temporary local WebVTT proxy.
- TV control buttons enable or disable based on the capabilities the Chromecast reports, such as seek, skip, volume, or mute.
- The queue uses the Default Media Receiver queue API, so it only works when the receiver supports queueing for that media.

## Technical limits

- The app only casts direct media URLs that the TV can fetch on its own.
- Detached subtitles only work when the TV can fetch the subtitle URL, or when the desktop app can fetch and proxy a public SRT file.
- DRM protected video such as Netflix, Disney+, or Prime Video, and streams that require cookies, short lived tokens, or custom headers, usually cannot be cast through the Default Media Receiver.
- The TV and the computer must be on the same LAN, and the network must allow mDNS.
- This build focuses on Chromecast. AirPlay and DLNA can be added later as separate adapters.

## Responsible use

This project is a general purpose media casting tool. It does not host, index, decrypt, or distribute any content, and it includes no mechanism to bypass DRM or other technical protection measures.

Use it only with content you own or are legally allowed to access, and respect the terms of service of any website you visit and the copyright laws of your country. You are solely responsible for how you use this software. The authors do not endorse or support copyright infringement or any unlawful use.

## Development

```bash
npm test        # runs the static checks and the production build
npm run smoke   # builds and runs an Electron smoke capture against a local sample page
```

The smoke test loads a bundled sample page and verifies that at least one media candidate is detected. It needs a display and is intended for local runs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, validate, and submit changes.

## License

[MIT](LICENSE)
