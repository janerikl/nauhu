# Nauhu

A browser-based video editor with a real timeline, transitions, and multi-project support — no install, no upload, no server. Everything runs client-side in React and renders with FFmpeg compiled to WebAssembly.

*"Nauhu" comes from the Finnish "nauha" — tape, reel.*

## Features

- **Timeline editing** — multiple video/audio tracks, drag to move clips, trim in/out points, split at the playhead
- **Transitions** — crossfade, fade to black, wipe, slide, and zoom, applied by dragging onto a clip boundary
- **Live preview** — canvas-based playback that renders transitions in real time, no pre-render needed
- **Multi-project support** — create, rename, switch between, and delete named projects
- **Drag-and-drop media import** — video, audio, and image files, with automatic duration detection
- **Autosave** — every edit persists to IndexedDB, with a visual save-status indicator
- **Export to MP4** — rendered locally in the browser via `ffmpeg.wasm`, no files ever leave your machine

## Why client-side

Nauhu does no server-side processing and stores nothing remotely. Your media, projects, and exports stay in your browser's IndexedDB and local memory — there's no upload step and no account. This also means closing the tab doesn't lose your project: it's autosaved locally and restored next time you open the app.

## Getting started

Requires Node 18+.

```bash
npm install
npm run dev
```

Open the printed local URL. Drag video, audio, or image files into the media bin to get started.

### Other scripts

```bash
npm run build    # type-check and build for production
npm run lint      # run oxlint
npm run preview   # preview the production build locally
```

## Keyboard shortcuts

| Key             | Action                              |
|-----------------|--------------------------------------|
| `Space`         | Play / pause                        |
| `Home`          | Jump to timeline start and play     |
| `S`             | Split the selected clip at the playhead |
| `Delete` / `Backspace` | Remove the selected clip or transition |

## How it works

- **`src/components/`** — UI: timeline, preview canvas, media bin, export panel, project menu, transitions panel
- **`src/store/`** — Zustand store holding editor state (tracks, clips, selection, playback)
- **`src/lib/`** — core logic: timeline math (clip/transition operations), FFmpeg-based export, IndexedDB persistence
- **`src/hooks/`** — `useProjectPersistence`, syncing store state to IndexedDB

Media blobs and project data are stored in IndexedDB (`videoeditor-db`); exports are assembled and encoded with `@ffmpeg/ffmpeg` running in a WebAssembly build of FFmpeg, entirely in-browser.

## Tech stack

React 19 · TypeScript · Vite · Zustand · `@ffmpeg/ffmpeg` (WASM) · IndexedDB (`idb`) · react-dropzone

## Contributing

Issues and pull requests are welcome. If you're proposing a larger change, open an issue first to discuss the approach.

## License

Nauhu is free software, licensed under the [GNU General Public License v3.0](LICENSE) or later.
