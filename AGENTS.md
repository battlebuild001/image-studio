# BTH CONTENT STUDIO

## Purpose

Korean browser-based video editor combining user-provided images, narration,
captions, motion, and optional BGM. The primary workflow is draft script, generate
API narration, then edit video. Users may also import externally prepared narration
and either import images or explicitly request optional reference-based image generation.
Keep the default workflow free from paid video-generation APIs and preserve the
Korean interface. Manual draft editing and document extraction work without APIs.
Optional researched script creation, CLOVA voice synthesis, fixed-reference image
generation and narration transcription use providers only on explicit actions.
Category workspaces keep independent in-progress projects; users can add their
own topics beyond the four defaults. Keep branding and new-project titles neutral.

## Architecture

- `dist/index.html` and `dist/style.css`: editor UI.
- `dist/main.js`: state, media import, multi-selection, scene operations, undo/redo,
  keyboard controls, timeline resizing, preview, autosave, export flow.
- `dist/workspace-store.js`: category records, per-workspace project/media saves,
  legacy autosave migration and safe active-workspace transitions.
- `dist/workspace-tabs.js` / `.css`: category tabs, add/rename/reorder and reversible
  archive/reopen controls.
- `dist/project.js`: validation, pure scene operations, timeline, captions, SRT,
  IndexedDB autosave/library, portable backup.
- `dist/engine.js`: Canvas rendering, Web Audio mixing, MediaRecorder export.
- `dist/editor-tools.js` / `.css`: framing/motion controls, caption editor/styles,
  source audio trims, waveform and A–B repeat.
- `dist/library-tools.js` / `.css`: local project shelf/copy, reusable title cards
  with optional local logos, current-frame PNG downloads.
- `dist/api-client.js` and `dist/api-settings.js` / `.css`: global authenticated backend connection; endpoint in localStorage, app access token only in sessionStorage and never in project/backups.
- `dist/script-studio.js` / `.css`: actual AI rewriting of reference files/text and user production instructions, target duration,
  always-available manual draft editing, researched results, sources and handoff.
- `dist/script-local-files.js` and `dist/vendor/`: local TXT/MD/PDF/DOCX extraction
  using pinned browser libraries; never upload originals or fetch external CDN code.
- `dist/voice-studio.js` / `.css`: CLOVA narration generation, preview, download and
  explicit application to the editor.
- `dist/voice-audio.js`: Unicode-preserving script chunking, actual MP3 decoding
  and mono 24kHz WAV merging with measured audio duration.
- `dist/image-studio.js` / `.css`: fixed reference images/background settings,
  image generation preview, downloads and explicit scene application.
- `dist/transcript-studio.js` / `.css`: narration transcription, staged timed cues,
  cancellation and explicit application.
- `dist/speech-timing.js`: source-window chunking, mono WAV encoding and grouping
  words/segments using actual recognition timestamps.
- `tests/*.test.mjs`: project-data, backup, framing and audio-envelope tests.
- `scripts/serve.mjs`: development server; serves only `dist/` as static files and
  routes `/api/script/*`, `/api/voice/*`, `/api/image/*` and `/api/transcript/*` requests.
- `scripts/backend-access.mjs`: authenticated public API gateway, exact CORS origins, bounded request rate and one active paid request. `/healthz` is public.
- `render.yaml` and `docs/AI_SERVER_DEPLOY.md`: free Render Node backend deployment from `image-studio-server`; user enters provider key securely on Render. Never treat a source upload as a running backend.
- `scripts/script-api.mjs`: server-only AI configuration and web-search script generation.
- `scripts/voice-api.mjs`: server-only CLOVA Voice Premium credentials and Korean
  MP3 generation through the official Naver endpoint.
- `scripts/image-api.mjs`: server-only image editing with actual reference bytes.
- `scripts/transcript-api.mjs`: server-only speech recognition with actual selected
  narration WAV bytes and validated provider timestamps.
- `scripts/script-files.mjs`: bounded server compatibility/test extraction with
  `mammoth` and `unpdf`; normal UI extraction uses browser-local code.
- `dist/` is the actual application source and static deployment directory;
  do not delete it as generated build output.

## Commands

Use Node.js 22 or newer for normal local operation; Node.js 24.5+ is required for
the supported environment-proxy initialization in cloud/proxy environments.
Run `npm ci` on a fresh checkout for document-extraction dependencies. No build
step is required. Basic media editing, fixed-reference management and document
extraction need no API key. Image generation and transcription add no package dependencies.

- Install: `npm ci`.
- Start: `npm start` (http://127.0.0.1:4173/).
- Alternate host/port: `npm start -- --host 0.0.0.0 --port 4173`; external binds require a separate server-side `STUDIO_ACCESS_TOKEN` of at least 24 visible ASCII characters. Render supplies `PORT`.
- Tests: `npm test` (runs `node --test tests/*.test.mjs`).
- Browser regression: with the server running and Playwright/Chromium installed, `npm run test:browser` (optional `STUDIO_URL`). Uses synthetic fixtures; outputs go to `/tmp`.
- Script-studio browser regression: `npm run test:script-browser`.
- Workspace browser regression: `npm run test:workspace-browser`; use actual
  Chromium IndexedDB and media roundtrips to verify isolation and migration.
- Script-to-voice workflow regression: `npm run test:voice-browser`. Synthetic
  MP3/WAV and mocked API responses do not establish live Korean TTS quality.
- Reference-image browser regression: `npm run test:image-browser`. Fixture-based
  AI responses verify UI behavior, never live model/search/image quality.
- Narration-caption browser regression: `npm run test:transcript-browser`. Real
  synthetic WAV bytes and mocked recognition timestamps do not establish live
  Korean speech-recognition accuracy.

The server never serves repository files or credentials as static assets.
Optional script generation reads `SCRIPT_AI_API_KEY` on the server (ordinary local
machines may use `OPENAI_API_KEY` as fallback) and `SCRIPT_AI_MODEL` (default
`gpt-5-mini`). The selected model must support the Responses API web-search tool.
Cloud setup uses the non-reserved secret name `SCRIPT_AI_API_KEY` with HTTPS
destination `api.openai.com`; preserve proxy/CA verification. Do not put keys in
frontend code, localStorage, project state, saved instructions or tests.
Optional image generation uses `IMAGE_AI_MODEL` (default `gpt-image-2`) and the
first available server key: `IMAGE_AI_API_KEY`, `SCRIPT_AI_API_KEY`, then local
`OPENAI_API_KEY`. Reuse the existing cloud key binding and `api.openai.com`
destination when appropriate. `gpt-image-2` must omit `input_fidelity`; do not
configure the retired `gpt-image-1` model.
Optional narration recognition uses the first available server key:
`TRANSCRIBE_API_KEY`, `SCRIPT_AI_API_KEY`, then local `OPENAI_API_KEY`.
Reuse the existing cloud key binding and `api.openai.com` destination.
`TRANSCRIBE_MODEL` defaults to `whisper-1`; only that verified timestamp-capable
model is currently supported. Its announced shutdown date is 2027-02-26:
validate a replacement's real word/segment timestamp support and request format
before migration; a text-only transcription model is insufficient.
Optional CLOVA synthesis uses only server-side `CLOVA_VOICE_CLIENT_ID` and
`CLOVA_VOICE_CLIENT_SECRET`; it does not depend on `SCRIPT_AI_API_KEY`.
The verified Premium endpoint is
`https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts` with Korean speaker
`nara` (아라). Preserve proxy/CA verification for `naveropenapi.apigw.ntruss.com`.
Cloud AI/TTS credential requirements must be optional and use `user_provided`
sources. Do not make missing optional keys block environment publication or ask
for credential values in chat. Inspect configured presence without exposing values.

## Behavior to preserve

- Default category tabs are 블랙아웃, 사만, 에오지 and 데이터 분석. Add arbitrary
  names of 1..40 characters, at most 50 records including archived categories.
  Rename/reorder/archive/reopen are supported; archiving retains content and the
  last open workspace cannot be archived. 데이터 분석 is an organizational
  category using the existing tools, not a newly implemented analytics engine.
- Each workspace independently retains its current project, manual/researched
  draft, reference sources, fixed-reference images, scene images, narration/BGM,
  scenes, captions and editor settings. Migrate the existing current autosave
  into 블랙아웃 without data loss. Library projects and caption/title presets
  remain explicitly shared across workspaces; no automatic cross-workspace copying.
  Export and schema-version-1 project backup target only the active project.
- Save workspace ID plus the current autosave atomically when still active;
  delayed saves for another workspace must not replace the active autosave.
  Switching requires strict draft flush and successful save, then validation and
  media hydration before activating the target. Failures retain current state and
  Blobs. Reset all module state and undo/redo on every workspace transition, even
  if target and previous project IDs match. Undo never crosses workspace boundaries.
- Preserve browser-local workspace records and archived content until explicit
  browser data removal; this is not cloud synchronization. Keep the app branded
  BTH CONTENT STUDIO and new project titles neutral. Prompt-copy context follows
  the active category and generic facts/data; do not force BLKOUT, military or
  science-fiction concepts into unrelated categories.
- Process normal image/audio editing locally in the browser. Extract script
  reference documents locally with pinned browser libraries; do not send original
  TXT/MD/PDF/DOCX files to the server or external providers in the normal UI flow.
  Input/extracted reference text is sent to the research provider only on an
  explicit generation action; never send image/audio media through the research API.
  Image generation is a separate explicit action: send only enabled reference
  image bytes and image-generation settings to `/api/image/generate`. Do not
  upload unrelated scene images or audio, and do not submit generation on input
  changes, project restoration, or a configuration check.
- Narration transcription is a separate explicit action. Only Analyze sends the
  selected narration source window as mono 16kHz PCM16 WAV to `/api/transcript/analyze`
  and the speech provider. Never upload audio on import, restoration, configuration
  checks or field changes. Do not send BGM, images or unused original audio ranges.
  Process at most 300 seconds per request and stage all chunks before Apply.
  Preserve existing captions on cancellation, provider failures and stale source,
  trim, offset or project responses. Default language is Korean; preview then Apply
  enables subtitles and uses undoable project mutations.
- CLOVA synthesis is separately user-authorized. Only an explicit Generate sends
  the current draft text and voice settings to `/api/voice/generate` and CLOVA.
  Never send reference documents, images or existing narration audio. Default
  Korean speaker is nara; speed -5..10 (negative faster, positive slower), pitch
  and volume -5..5. Allow at most 30,000 draft characters and split into requests
  of at most 2,000 Unicode characters without loss or surrogate splitting.
  Decode actual returned MP3 chunks, merge into mono 24kHz WAV using measured
  audio timing, and stage preview/download before explicit Apply replaces narration.
  Cancellation, provider errors and stale draft/project responses preserve existing
  media. Importing a user-prepared MP3/WAV remains available without any API.
- Fixed references: at most 5 PNG/JPEG/WebP uploads, 10MiB each and 20MiB total.
  Keep `project.imageStudio` schema-version-1 compatible with background/lore,
  style, negative prompt, scene prompt, size, quality and references. Each reference
  has an asset ID, label, role (concept/background/character/style/other) and enabled
  flag. Include disabled references in `referencedAssetIds`, media validation,
  autosave/library/backups and undo/redo asset retention. Shared scene/reference
  assets must be deduplicated. Preserve reference-only projects before New/Open.
- Image requests must contain the actual enabled images, locally resized to a
  1536px maximum long edge, plus their ordered roles and the saved settings.
  Never replace reference bytes with names or a text-only prompt and call it
  reference-conditioned generation. Generation produces one preview at a time.
  Offer PNG downloads; only explicit Apply places results in existing/new scenes. Preserve
  settings, source media and previous results on validation/provider errors,
  cancellation and stale project responses. Do not guarantee identical likeness.
  Prompt-copy fallback requires the user to attach the reference files manually.
- Reference files: TXT/MD/PDF/DOCX, at most 10MiB each, 5 files/20MiB per batch,
  and at most 100,000 combined text characters. Scanned/image PDFs have no OCR.
  Preserve user input on extraction failure; never silently truncate it.
- Script target duration is an integer 1..60 minutes; reading speed is 200..500
  non-whitespace characters/minute (defaults 8 minutes and 330 characters/minute).
  Generated duration is an estimate. Applying a draft sets the requested scene
  duration and groups long scripts to keep the 200-scene limit.
- Keep the right-hand draft editor usable with no AI backend or key. Treat absent
  optional APIs on static Pages as normal informational state, not a generic red
  failure. Store manual text in schema-version-1 `project.scriptDraft.draftScript`
  with `result:null`; manual text and an explicit reference-to-draft copy are not
  web research or AI output. Preserve draft text independently of API evidence.
- Research results require an actually completed web-search call and valid provider
  sources. Keep summary, source URLs and uncertainties separate from spoken narration.
  Never label a fabricated/local fallback as web-researched content. Cancellation,
  missing configuration and provider failures must preserve the existing draft.
- Keep optional `project.scriptDraft` compatible with schema version 1. Preserve
  reference text, duration settings and result evidence in autosave/library/backups;
  recompute displayed character count and estimated duration after manual edits.
- Preserve IndexedDB media blobs and schema-version-1 portable backup compatibility.
  New optional framing, caption-style and trim fields receive canonical defaults.
  IndexedDB version 2 introduced independent `library` / `libraryMeta` stores.
  Version 3 adds `workspaces` (keyPath `id`) and unkeyed `workspaceMeta`, retaining
  existing `projects`, `assets`, `library` and `libraryMeta` stores and migrating
  the previous current autosave without clearing media. New/Open archives the current project
  before switching; a failed save or hydrate must not discard current media.
- `captionMode:'auto'` times are script-length estimates, not speech recognition.
  `captionMode:'speech'` stores source-file cue times and `captionAnalysis` metadata
  (narration ID, source range, language, model, granularity, creation time).
  Use actual word bounds to group readable cues, or retain actual segment bounds
  if words are unavailable. Do not estimate missing timestamps from text length.
  `getCaptions` maps speech cues through current narration trim and video offset;
  source replacement/removal suppresses old speech cues. Expanded source windows
  need reanalysis for previously unanalyzed audio. Keep schema-version-1 compatibility
  and preserve metadata in autosave, library, backups and undo/redo without retaining
  an otherwise unreferenced old narration asset.
- Imported SRT retains its exact timing and separate editing mode. The timing
  editor explicitly converts auto or speech captions to manual mode on Apply;
  cue offsets reject negative starts. Scene edits do not implicitly retime SRT.
  Prepending a generated title card shifts SRT by the inserted duration and shifts
  speech captions through the narration offset without changing their source times.
- Duplicate scenes use distinct IDs. Undo/redo must retain referenced media for
  both stacks. Merge accepts only consecutive scenes sharing the same image and
  uses the first scene settings (custom motion connects first start to last end);
  split preserves the overall duration.
- Multi-selection uses checkboxes or Ctrl/Cmd/Shift click; copied scene settings
  cover motion, fit and framing. Timeline handles support drag and 0.1-second
  arrow-key adjustment (Shift: 1 second). Global shortcuts must not intercept
  text/form/button editing or modal interaction.
- Caption styles and title-card presets are local browser settings. Template
  logos are rasterized into inserted image scenes, not retained in preset settings.
  Preserve local-only media handling for PNG screenshots and generated cards.
- Audio source trims are nondestructive; BGM loops only the selected source
  window. Preview and export share trim, volume, fade and RMS ducking envelopes.
  Ducking uses audio amplitude rather than speech recognition. A–B repeat
  changes preview playback only; it must not change the exported project duration.
- MP4/WebM availability must reflect actual browser support; never fake a format
  by changing a filename extension.
- Export is real-time; hidden tabs cancel the job.
- With no scenes, clear and hide the preview canvas and show only the HTML
  starting guide. Do not rely on stylesheet opacity to cover a second canvas
  instruction. Restore the canvas for real scenes, including missing-image
  scene placeholders, after imports, deletion/undo and workspace transitions.
- Reject missing scene images and warn when narration exceeds video duration.
- The renderer uses explicit canvas `requestFrame()` calls. Avoid reintroducing
  animation-frame/offscreen throttling or waiting for the recorder start event
  before producing initial frames/audio.

## Validation

Run `npm test` for project-data changes. For rendering or audio changes, verify a
short export with actual images, narration, BGM, and subtitles in a supported
browser. Inspect the exported file's metadata and playback. If browser testing
is unavailable, report that limitation instead of claiming export was verified.
Tests should address behavior and concrete regression risks. Exercise controls in
a supported browser for UI changes: multi-selection and undo/redo, cue timing
Apply/cancel, source trims, library restoration with media, template insertion and
PNG downloads. Check legacy backup restoration and isolation between library
entries when changing persistence.
For workspaces, verify legacy autosave migration with actual Blob bytes, independent
draft/reference/media restoration, active-record reload and archive/reopen retention.
Exercise add, rename and reorder, the name/count limits and last-open guard. Test
delayed saves from an inactive workspace, same-project-ID transitions, strict-flush
and hydrate failures, module resets and undo boundaries. Keep existing library and
style/template preset sharing explicit. Do not claim a public deployment or completed
browser checks until their actual results have been verified.
For script creation, test local extraction with actual synthetic TXT/MD/PDF/DOCX
bytes and no original-file upload, including static Pages with absent API routes.
Verify manual draft editing, explicit source copy and independent persistence with
`result:null`, plus the draft → voice → video handoff without an OpenAI key.
For optional research, test duration estimates, validated source links, cancellation/error preservation,
draft restoration and handoff to scene creation. API/unit/browser fixtures must
not be described as verified live AI generation. Without configured credentials,
finish independent tests and report live web-search/generation as unverified.
For fixed references, verify original Blob roundtrips, disabled-reference retention,
shared scene/reference IDs, undo/redo and reference-only archives. Inspect mocked
provider requests for real image bytes and ordered roles. Verify preview download,
explicit scene application, error/cancellation preservation and mobile controls.
API/UI fixtures do not establish live image fidelity or model access.
For speech captions, verify the actual selected WAV bytes, sample rate/channel/PCM
format, contiguous chunk coverage and source timestamps through trim and offset.
Verify preview/Apply, SRT and export integration, undo/redo, reload/backups,
cancellation/error/stale preservation and mobile controls. Test malformed or absent
provider timestamps, silence and segment-only timing without fabricated fallback.
Current runtime credentials are absent: finish independent unit/API/browser tests
with synthetic audio and clearly report live Korean recognition as unverified.
For CLOVA voice, inspect real text/form request bytes, exact Unicode chunk
preservation, credential isolation and sanitized failures. Test actual synthetic
MP3 decoding, measured-duration WAV merging, preview/download/Apply, undo/redo,
cancellation/error/stale preservation and unconfigured static Pages behavior.
Current CLOVA credentials are absent: fixture tests do not verify live Korean
pronunciation, audio quality, account permissions or billing.

## Source and deployment

The latest public static editor is https://battlebuild001.github.io/image-studio/,
served from the owned image-studio-web branch. The older chatgpt.site deployment
was not updated. The optional AI/TTS APIs remain unavailable on static Pages;
manual drafts, local document extraction and normal media editing work there.

The user explicitly requested a deploy tool and publication of the latest editor.
`npm run deploy:check` validates a static release without network access;
`npm run deploy` uses the documented GitHub Pages REST API through the inherited
proxy and CA trust. This alternative creates/updates a Pages URL; it does not
update the existing Sites project. Keep `.openai/hosting.json` intact. Never
invent a private Sites deployment endpoint or treat an ordinary OpenAI key as a
Sites deployment credential.
Deployment uses an owned dedicated `image-studio-web` branch with public `dist/`
files only, no forced updates and no main-branch changes. Existing unrelated
Pages sources/branches must be refused; retain an existing matching custom domain.
Check `release.json` revision at the public URL before reporting success. Pending
builds, mocked API success, pushed commits and saved network configuration are
not proof of a deployed website. API tests use fixtures and require no credentials.
GitHub credentials resolve PAGES_DEPLOY_TOKEN, GH_TOKEN, GITHUB_TOKEN, server-side
only. Check existing platform credentials before requesting any new binding.
Restricted networks need api.github.com and the returned Pages public hostname.
Do not bypass a proxy denial. Static Pages does not host the optional AI APIs.

Keep `.openai/hosting.json` and its project ID intact. GitHub commits do not
automatically update the existing Sites deployment. Never commit credentials,
user media, project backups, or exported videos. Synthetic test fixtures are safe
to keep. Do not enable paid APIs or publish user media as part of a routine fix.
The user explicitly requested optional research/script generation, fixed-reference
image generation, narration recognition for timed captions and CLOVA voice
synthesis after drafting. This authorizes the explicit draft-to-voice workflow
and publication of its static UI; it does not authorize paid video-generation
services or publishing user media. Static `dist/` deployment alone does not run
`/api/script/*`, `/api/voice/*`, `/api/image/*` or `/api/transcript/*`.
Public AI deployments require a backend plus authentication and
per-user usage controls;
do not expose the local development server as an unauthenticated billing proxy.

## Public AI connection

Use `apiFetch` for all frontend provider API requests. Connection changes abort obsolete requests and must not trigger paid generation or copy references into a draft. The primary script action sends source text, production instructions and duration to the real server; manual reference copying stays explicitly separate. Missing CLOVA keys never block script generation. Accept cross-origin provider routes only after `createBackendAccess` sets the internal `req.studioAuthenticated` marker; never trust an incoming marker/header. Provider credentials never go to the browser. Public APIs require a separate app access token, exact allowed origin, at most ten accepted POST requests per minute and one active paid job per server.
