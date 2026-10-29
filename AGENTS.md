# BTH BLKOUT Image Studio

## Purpose

Korean browser-based video editor combining user-provided images, narration,
captions, motion, and optional BGM. Users prepare GPT images and CLOVA Dubbing
audio outside this app. Keep the default workflow free from paid video-generation
APIs and preserve the Korean interface.

## Architecture

- `dist/index.html` and `dist/style.css`: editor UI.
- `dist/main.js`: state, media import, preview, undo, autosave, export flow.
- `dist/project.js`: validation, timeline, captions, SRT, IndexedDB, portable backup.
- `dist/engine.js`: Canvas rendering, Web Audio mixing, MediaRecorder export.
- `tests/project.test.mjs`: project-data and backup tests.
- `scripts/serve.mjs`: dependency-free local development server.
- `dist/` is the actual application source and static deployment directory;
  do not delete it as generated build output.

## Commands

Use Node.js 22 or newer. No dependency installation, API key, or build step is required.

- Start: `npm start` (http://127.0.0.1:4173/).
- Alternate host/port: `npm start -- --host 0.0.0.0 --port 4173`.
- Tests: `npm test`.

The development server serves only `dist/`, not repository files or credentials.

## Behavior to preserve

- Process user media locally in the browser.
- Preserve IndexedDB media blobs and portable backup compatibility.
- Automatic caption times are script-length estimates, not speech recognition.
- Imported SRT retains its exact timing and separate editing mode.
- MP4/WebM availability must reflect actual browser support; never fake a format
  by changing a filename extension.
- Export is real-time; hidden tabs cancel the job.
- Reject missing scene images and warn when narration exceeds video duration.
- The renderer uses explicit canvas `requestFrame()` calls. Avoid reintroducing
  animation-frame/offscreen throttling or waiting for the recorder start event
  before producing initial frames/audio.

## Validation

Run `npm test` for project-data changes. For rendering or audio changes, verify a
short export with actual images, narration, BGM, and subtitles in a supported
browser. Inspect the exported file's metadata and playback. If browser testing
is unavailable, report that limitation instead of claiming export was verified.
Tests should address behavior and concrete regression risks.

## Source and deployment

Keep `.openai/hosting.json` and its project ID intact. GitHub commits do not
automatically update the existing Sites deployment. Never commit credentials,
user media, project backups, or exported videos. Synthetic test fixtures are safe
to keep. Do not enable paid APIs or publish user media as part of a routine fix.
