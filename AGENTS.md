# CONTENT STUDIO

## Purpose

Korean browser-based video editor combining user-provided images, narration,
captions, motion, and optional BGM. The primary navigation is 대본 → 타이밍 → 이미지
→ 편집·저장. Narration and subtitles are optional tools in the initially closed
음성·자막 drawer. Users may generate or import externally prepared narration
and either import images or explicitly request optional reference-based image generation.
Keep the default workflow free from paid video-generation APIs and preserve the
Korean interface. Manual draft editing and document extraction work without APIs.
Optional researched script creation, CLOVA voice synthesis, fixed-reference image
generation and narration transcription use providers only on explicit actions.
Users choose an image-change interval, review and confirm the timeline, then explicitly authorize sequential image generation for its slots. Sentence count must not automatically determine new image slots.
Users configure their own OpenAI key in the app Settings for browser-direct script, image and timestamped transcription requests; Render is optional.
Category workspaces keep independent in-progress projects; users can add their
own topics beyond the four defaults. Keep branding and new-project titles neutral.
The old fixed channel name must not appear automatically in the editor, generated
templates, preview, PNG or video export. Keep legacy settings.branding compatible,
but use it only for the user's project title; UI label is 영상 제목 표시. Never
rename internal storage/database/backup identifiers or erase user-entered text.
Voice-provider choice is undecided. Keep user-visible voice guidance, demo captions
and API errors provider-neutral (음성 API / 음성 생성). Preserve implementation
credential names, official endpoints and provider metadata until an actual adapter
change is requested; neutral copy does not add support for another provider.
Optional settings.aiImageNotice controls a fixed small bottom AI-image notice.
Default/missing legacy is false; keep it independent of subtitles and branding.
settings.aiImageNoticePosition supports bottom-center (default/legacy), bottom-left
and bottom-right. Preserve the selected position even while notice is off. Side
placements use mirrored safe insets with left/right-aligned text; center pixels remain
unchanged. Expose 위치 only when the notice is enabled.
Render the exact requested text in Canvas for preview, PNG and video export,
reserve caption space, and persist the flag through undo/workspaces/backups.
For notice changes run npm run test:ai-notice-browser and npm test; verify readable
landscape/portrait layouts, off-state pixel parity and a real short exported video
with images, narration, BGM and captions. Do not replace this with a DOM overlay.

## Production management

The header's 제작 관리 dialog contains the requested ten production features in
nine tabs: speech/dictionary, partial changes, budget, history, image review,
information cards, channel presets, shorts and publishing materials. Keep this
secondary workbench separate from the four primary workflow steps.

- `dist/production-workbench.js` / `.css` composes feature modules through toolsApi.
  Flush dirty speech fields before switching sections, projects or workspaces;
  closing cancels active jobs without deleting completed results or manual fields.
- `dist/production-state.js` validates optional production version1 metadata.
  Legacy projects omit it. Keep the 2MiB bound, typed domains, credential/raw-body
  exclusions and asset retention for image/voice version entries.
- `dist/production-speech.js` and `dist/pronunciation.js` separate optional
  scriptDraft.displayScript from spoken draftScript. Equal/missing display scripts
  retain legacy coupling until an explicit separate edit. Timing/subtitles use
  display text; voice generation uses spoken text. Pronunciation rules are local
  project data and explicit prompt context, never provider configuration.
- `dist/production-changes.js` / `.css` and `production-changes-protocol.js` compare
  stable baselines, stage selected image replacements and splice actual decoded
  PCM into a user-reviewed source-audio interval. Image and voice baselines are
  independent. Applying an image must not clear pending voice changes. Measure
  replacement duration, preserve untouched samples and retime downstream scenes,
  cues and scenePlan; update narrationPlanKey after registering the new asset.
  Ambiguous text spans require explicit full-script review instead of silent edits.
- `dist/production-budget.js` guards paid apiFetch POST calls centrally, including
  direct and optional server transports. Rates are editable estimates, not a live
  invoice. Reserve before dispatch, retain uncertain failures/cancellations and
  avoid retries. Metadata updates must not cancel their own job. Undo/redo must
  preserve current cost records. Bridge scope includes workspace and project ID.
- `dist/production-history.js` captures versions in the same mutation before
  replacing scripts, image IDs or narration IDs. Retain actual old media and keep
  BGM unchanged when restoring narration. Do not nest version histories.
- `dist/production-assistant-protocol.js`, `production-visual-protocol.js` and
  `production-api.mjs` share strict bounded task schemas for actual image review,
  diagrams, shorts and publishing. Use the fixed Responses provider, current
  script model, explicit calls, cancellation and the existing shared paid-job lock.
- `dist/production-visual.js`, `production-diagrams.js`,
  `production-diagram-renderer.js` and `production-visual-utils.js` send resized
  actual images/references, detect stale inputs and render editable real Canvas
  cards. Maps are schematic and must retain their disclaimer. Never invent data
  measurements or claim a text-only check inspected image pixels.
- `dist/production-channels.js`, `production-shorts.js`,
  `production-publishing.js` and `production-delivery-utils.js` provide allowlisted
  presets, title cards, source-timed 9:16 variants and real PNG/ZIP downloads.
  Archive the original before installing a shorts project. Cut/concatenate actual
  narration and cues, preserve image/BGM assets and start its cost ledger empty.
  Publishing creates downloadable materials; it does not upload to a channel.

Run npm test and the six test:production-*-browser scripts after suite changes.
Browser suites use synthetic media and mocked providers, with actual IndexedDB,
Web Audio, PNG/ZIP and backup roundtrips. Changes to partial audio or shorts also
need a real short export with images, narration, BGM and captions; inspect decoded
playback and ffprobe audio/video streams. Run real exports sequentially. Never
describe these fixtures as live AI quality or actual billing verification.

## Architecture

- `dist/index.html` and `dist/style.css`: editor UI.
- `dist/main.js`: state, media import, multi-selection, scene operations, undo/redo,
  keyboard controls, timeline resizing, preview, autosave, export flow.
- `dist/studio-layout.js` / `.css`: presentation-only grouping of existing controls
  into native details drawers and the project menu, with keyboard/focus handling.
  Initialize after all tool and workspace setup; refresh its derived status on render.
- `dist/operation-status.js` / `.css`: shared operation-scoped loading, elapsed time,
  delayed-response and terminal feedback; stale handles cannot complete newer jobs.
- `dist/narration-text.js`: browser-safe spoken-text helper exports; the shared
  script protocol implements styles, conservative cleanup and numeric reading.
- `dist/workspace-store.js`: category records, per-workspace project/media saves,
  legacy autosave migration and safe active-workspace transitions.
- `dist/workspace-tabs.js` / `.css`: category tabs, add/rename/reorder and reversible
  archive/reopen controls.
- `dist/project.js`: validation, pure scene operations, timeline, captions, SRT,
  IndexedDB autosave/library, portable backup.
- `dist/engine.js`: Canvas rendering, Web Audio mixing, MediaRecorder export.
- `dist/scene-effects.js`: bounded deterministic scene-local dust/fog/light overlays;
  camera presets and final compositing remain in engine.js.
- `dist/editor-tools.js` / `.css`: framing/motion controls, caption editor/styles,
  source audio trims, waveform and A–B repeat.
- `dist/library-tools.js` / `.css`: local project shelf/copy, reusable title cards
  with optional local logos, current-frame PNG downloads.
- `dist/api-client.js` and `dist/api-settings.js` / `.css`: global app Settings for personal OpenAI API keys/models and optional authenticated server connection. Keys are memory-only by default; explicit remember-for-tab consent permits sessionStorage, explicit remember-in-browser consent permits a dedicated localStorage entry. Never include keys in project/backups. Backend endpoint may remain in localStorage and app access code only in sessionStorage.
- `dist/direct-openai.js`: browser requests to fixed HTTPS api.openai.com endpoints, without custom destinations, redirects or automatic paid retries.
- `dist/script-protocol.js`, `dist/transcript-protocol.js`, `dist/image-prompt.js`: browser-safe shared request/response validation and reference-image prompt construction. Preserve real search/citation and speech timestamp requirements in both transports.
- `dist/script-planning.js`: fixed-interval timeline construction, script/cue placement, narration signature and stale-plan checks.
- `dist/scene-timing-ui.js` / `.css`: preview-only image cadence/duration/count review before explicit confirmation.
- `dist/storyboard-protocol.js`: whole-video storyboard request/response validation,
  exact slot coverage and canonical context keys; shared by direct and Node routes.
- `scripts/image-plan-api.mjs`: authenticated optional POST /api/image/plan using
  the existing text model/key and safe timeout/cancellation/concurrency.
- `dist/scene-image-batch.js` / `.css`: reviewed, confirmed-plan image generation, sequential application to existing slot IDs, safe cancellation and explicit resumption.
- `dist/script-studio.js` / `.css`: actual AI rewriting of reference files/text and user production instructions, target duration,
  always-available manual draft editing, researched results, sources and handoff.
- `dist/topic-research-protocol.js`: shared topic-driven web research requests,
  completed-search/citation validation and canonical evidence storage. Visual
  composition suggestions stay separate from factual script reference text.
- `scripts/topic-research-api.mjs`: optional authenticated research config/collect
  routes; direct OpenAI mode shares the user's script model and key. Both use
  actual Responses web_search, no fallback to unsearched model recollection.
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
- `render.yaml` and `docs/AI_SERVER_DEPLOY.md`: optional free Render Node backend deployment from `image-studio-server`, required for CLOVA or shared server-held provider keys. Personal OpenAI direct mode needs no Render account. Never treat a source upload as a running backend.
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
- Timing preview regression: `npm run test:scene-timing-browser`.
- Confirmed-scene image batch regression: `npm run test:scene-batch-browser`.
- Whole timed-scene workflow regression: `npm run test:timed-workflow-browser`.
- Layout/navigation browser regression: `npm run test:layout-browser`. Existing
  browser suites use `tests/ui-navigation.browser.cjs` to open real details summaries
  before interacting with their controls; never force clicks on hidden controls.
- Operation feedback browser regression: `npm run test:operation-browser`.
- Local operation feedback regression: `npm run test:local-operations-browser`;
  delayed real IndexedDB calls verify loading, success/error and retained content.
- Reference-image browser regression: `npm run test:image-browser`. Fixture-based
  AI responses verify UI behavior, never live model/search/image quality.
- Narration-caption browser regression: `npm run test:transcript-browser`. Real
  synthetic WAV bytes and mocked recognition timestamps do not establish live
  Korean speech-recognition accuracy.

The server never serves repository files or credentials as static assets.
The user explicitly requested API configuration inside the app. This authorizes
personal key input through Settings and supersedes the earlier blanket ban on
browser key input. Direct OpenAI mode calls Responses web_search, Images edits
and timestamped transcription through standard CORS; it does not use a cloud
server key or require Render. The user requested persistent API settings; this
authorizes an explicit browser-retention choice alongside tab-only retention.
Keep the key in module memory by default; only remember it in sessionStorage or a
dedicated localStorage entry when the user explicitly selects that scope and saves.
Explain device-local retention, shared-device risk and site-data clearing. Never embed keys
in shipped code, project/library data, backups, tests or logs; getters
and status text expose only presence, never values. Clear/mask fields after use,
clear remembered values on removal and abort obsolete requests on settings changes.
For retention changes run `npm run test:api-retention-browser`, existing direct/API
settings and operation-feedback browser suites, and `npm test`. Verify actual
browser-process restart with a persistent test profile, memory/tab/browser scope
transitions, masked restore and blank saves, no keys in project/library/backups,
mobile controls and cross-tab deletion including delayed verification that must
never re-save a removed key. Use synthetic credentials and mock provider replies.
Connection checking uses non-paid GET /v1/models without reference/media uploads.
Allow explicit save without model-list verification for restricted keys; a models
403 does not prove the key lacks generation permissions. Actual content generation
requires its own explicit action. Direct keys go only to fixed HTTPS api.openai.com
routes with credentials omitted and redirects rejected, never to a configured
third-party backend. Do not silently switch to server billing after direct-mode
failure. CLOVA has no verified browser CORS route and remains server-only.

The following environment variables apply only to optional server mode.
Optional script generation reads `SCRIPT_AI_API_KEY` on the server (ordinary local
machines may use `OPENAI_API_KEY` as fallback) and `SCRIPT_AI_MODEL` (default
`gpt-5-mini`). The selected model must support the Responses API web-search tool.
Cloud setup uses the non-reserved secret name `SCRIPT_AI_API_KEY` with HTTPS
destination `api.openai.com`; preserve proxy/CA verification. Server-held credentials must not be returned to the browser. Never put secret values in
shipped frontend code, localStorage, project state, saved instructions or tests.
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

- Keep four primary actions: 대본 → 타이밍 → 이미지 → 편집·저장. Voice remains
  optional in the initially closed 음성·자막 drawer. Group new/open/backup/library/
  help/example actions in the top 프로젝트 menu while keeping API 설정 visible.
  The primary whole-video image launcher stays outside 제작 도구 after timing confirmation.
  Optional manual/reference-single-image/template/PNG tools belong in 제작 도구;
  multiselect/bulk controls in 선택 장면 편집; motion/framing/actions in
  움직임·장면 도구; global transitions/caption style in 영상·자막 스타일.
  Reparent existing nodes without replacing IDs/listeners or changing project data.
  Preserve drawer open state across renders and workspace switches in page memory
  only, never in projects or backups. Opening drawers must not invoke AI/network
  requests or paid actions. Keep batch count/cost/acknowledgement controls visible
  in the generation dialog and retain the explicit confirmation gate.
- Native details summaries must retain keyboard behavior and be excluded from
  global editor shortcuts. Restore focus only when a closed dialog's native opener
  is hidden; never steal focus from a newer visible user target. Retain accessible
  labels, mobile layouts and normal modal focus handling.
- All asynchronous user actions need immediate, visible activity feedback in the
  relevant screen/modal. Use operation-status.js for a spinner, truthful phase,
  elapsed time and delayed-response notice; never invent provider substeps, a
  percentage or remaining time. Keep real export/batch progress when known.
  Finish as success, error or cancellation, stop timers and clear aria-busy.
  Reset/cancel obsolete jobs on workspace/settings changes and use scoped handles
  so late responses cannot overwrite a newer status. Keep live announcements to
  phase changes, not every elapsed second, and respect reduced motion. Feedback
  must not start, retry or resume paid requests, clear drafts or bypass confirmation.
- Narration styles are standard, korean, korean-digits and korean-native-digits.
  New UI drafts default to korean-digits; missing legacy saved/API styles mean
  standard. Persist the chosen style with schema-version-1 scriptDraft/results.
  Selection alone never rewrites an existing draft. Explicit local numeric/markup
  cleanup may map digits to 영일이삼사오육칠팔구 or 공하나둘셋넷다섯여섯일곱여덟아홉;
  lexical English-name/acronym phonetics require actual AI generation. The korean
  mode requests contextual Korean number readings. Preserve meaning and evidence.
  Copy/TXT and voice/timing handoffs use narration-only cleaned text; source URLs,
  citation marks and research-method explanations belong outside the spoken script.
  Keep genuine story events about finding/verifying facts. Keep summary, notes and
  real source evidence in the initially closed 조사 메모·출처 section and preserve
  them in dedicated research export, autosave, library and portable backups.
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
- Gentle camera motions are subtle-zoom and subtle-drift; existing presets/defaults
  remain unchanged. Optional scene.effect is none/dust/fog/light (legacy none),
  scene.effectIntensity is finite 0..1 (legacy .25). Newscene effects are passive
  until an explicit edit. Preserve schema1 backups, referencedmedia and timings.
  Render bounded deterministic overlays from scene.id and scene-local time with no
  timers, per-frame randomness, network calls or paid providers. Intensity0/none
  must match legacy pixels; respect cover/contain and small viewport displacement.
  Composite image+effect together during transitions, then captions/branding above.
  Include effect fields in renderer cache invalidation and copied/bulk settings.
  A split creates a newscene-local effect clock/pattern; retain effect parameters.
  Use currentselection for one-undo gentle preset/batch effect edits, preserve
  image bytes/captions/timingplans, and disable controls during media/export work.
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
  reference-conditioned generation. The manual one-image tool stages one preview at
  a time; only explicit Apply places it in an existing/new scene, and PNG download
  remains available. The separately authorized confirmed-plan batch may instead
  generate and apply one image at a time to its existing scene IDs after the user
  reviews all prompts/references/settings/count and checks its acknowledgement.
  Preserve settings, source media and completed results on validation/provider
  errors, cancellation and stale project responses. Do not guarantee identical
  likeness. Prompt-copy fallback requires attaching the actual references manually.
- Reference files: TXT/MD/PDF/DOCX, at most 10MiB each, 5 files/20MiB per batch,
  and at most 100,000 combined text characters. Scanned/image PDFs have no OCR.
  Preserve user input on extraction failure; never silently truncate it.
- Script target duration is an integer 1..60 minutes; reading speed is 200..500
  non-whitespace characters/minute (defaults 8 minutes and 330 characters/minute).
  Generated duration is an estimate. New image slot count follows the user's
  interval between images (default 10 seconds), never paragraph/sentence count.
  At 8 minutes, a 10-second interval creates 48 slots and 20 seconds creates 24. Preview must not mutate scenes or call any
  image API; explicit timing confirmation creates/replaces only the planned slots.
  The 200-scene limit requires an actionable request to increase the interval,
  never a silently changed cadence or appended leftover image scenes.
- Scene planning is explicitly staged: interval/duration -> review timestamps and
  slot count -> confirm -> review per-slot visual requests, references/settings and
  actual request count -> acknowledge and start paid generation. Existing loaded
  projects (including old drafts with 157 slots) are never automatically replanned or
  generated. The panel count is scene slots, not generated-image/API-call count.
  Archive the existing project/media to the library before explicit retiming and
  retain undo/backups; a failed archive must leave the current work untouched.
- Optional project.scenePlan is compatible with schema version 1 and persists bounded
  confirmedAt/sourceScript/interval/duration/basis/narrationKey/items with expected
  scene IDs, start/end times, captions and editable prompts. Keep stale plans saved
  for undo, but block generation until changes to script, scene order/timing or
  narration/trim are reviewed and confirmed again. Image-only application does
  not invalidate timing; never generate extra scenes or change durations in a batch.
- Whole-video visual planning is a separate explicit paid text-AI action at
  /api/image/plan. Send complete confirmed sourceScript and every timing slot,
  common brief/background/style; require exact returned IDs/order before applying
  all prompts. Never claim a local fallback is AI storyboarding. Preserve timings,
  captions, images and old prompts on planning/cancel/save failures. Store optional
  scenePlan.visualBrief and visualPlan(version1,model,createdAt,globalConcept,inputKey)
  with legacy schema1 compatibility. Context keys exclude images/prompts but cover
  script/title/slots/brief/settings/enabled reference metadata; changes require new
  AI composition. Guard active jobs with actual Blob identity/settings/project scope.
  Every image uses shared full-story-derived visual bible, common brief and cut/
  nearby context. Do not force a reference soldier/weapon into unrelated eras.
  References remain optional:0 uses fixed images/generations JSON;>0 uses fixed
  images/edits multipart with actual ordered pixels, never silent reference loss.
  Image settings.prompt<=30000 and final composed provider prompt<=32000; validate
  all pending prompts before charging first image. Keep sequential durable writes,
  explicit quantity/cost acknowledgement, skip-filled default and replacement opt-in.
  Full-script storyboarding and image generation each require their own explicit
  action; opening, typing, saving or confirming timing must never incur a paid call.
- Batch generation skips filled slots by default; replacing existing images is an
  explicit opt-in. Show each time range and the resulting request count, require
  the review acknowledgement, then issue sequential image requests only after
  Start. Apply each successful result to its exact planned scene; preserve completed
  results on Stop/error/stale changes and stop future requests. No automatic paid
  retry, restart or resumption. Resuming requires a new review and explicit Start.
- Preserve matching speech/SRT captions and their actual times during retiming.
  Use cue-based script placement only when cue text matches the complete draft and
  lies within the selected narration/current timeline. Otherwise use a clearly
  labelled proportional text estimate without claiming speech recognition or
  silently dropping source text. Duration/cadence changes never fabricate ASR.
- Keep the right-hand draft editor usable with no AI backend or key. Treat absent
  optional APIs on static Pages as normal informational state, not a generic red
  failure. Store manual text in schema-version-1 `project.scriptDraft.draftScript`
  with `result:null`; manual text and an explicit reference-to-draft copy are not
  web research or AI output. Preserve draft text independently of API evidence.
- Script composition uses optional sourceFidelity (summary/balanced/faithful) and
  detailLevel (concise/standard/expanded), persisted in scriptDraft and its result.
  New UI drafts default faithful/expanded; missing legacy fields canonicalize to
  balanced/standard without rewriting text or changing schema version 1.
  Faithful mode preserves event/year/entity order, qualifiers and unknowns; detailed
  explanations may use supported context, never invented actions, mechanisms,
  environmental conditions, motives or casualty figures. Keep actual web evidence
  and phonetic/clean-narration rules in both transports. No claimed coverage audit.
  targetMinutes remains the sole length budget: explicit 1.5x/2x buttons edit the
  actual 1..60 integer minutes, with no hidden multiplier or automatic paid retry.
  Option changes preserve existing text and result metadata until a new request.
  Source-size warnings are heuristics, not translation or semantic coverage checks.
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
For scene effects, run npm run test:scene-effects-browser and npm test. The browser
suite requires local ffprobe in addition to Playwright/Chromium for stream inspection. Verify
actual Canvas pixels, deterministic seek/reload/backup frames, none/intensity0
legacy behavior, bounded tiny motion/no blackedges, readable captions aboveFX,
selection/undo/copy/workspace/media roundtrips, mobile access, and one actual short
video with image, narration, BGM and subtitles. Inspect exported metadata/playback
and frame differences; keep real exports sequential. Local camera/overlay effects
are not a claim of generative subject or character animation.
For script creation, test local extraction with actual synthetic TXT/MD/PDF/DOCX
bytes and no original-file upload, including static Pages with absent API routes.
Verify manual draft editing, explicit source copy and independent persistence with
`result:null`, plus draft → timing → image/edit handoff without a voice API key
and the optional draft → voice → video handoff without an OpenAI key.
For topic collection run `npm run test:topic-research-browser` and `npm test`,
plus script, direct API settings, key retention, timing, whole-video and layout
regressions. Verify topic-only research→script stage ordering, production direction
and chosen duration, real citation requirements, separate factual/visual guidance,
no manual source overwrite, scope/input/API cancellation, stale result treatment,
project/backup/workspace persistence and mobile access. Research and script actions
authorize their own text/search calls; they never authorize automatic paid images.
Current collected visualBrief may seed a new confirmed scenePlan without replacing
an explicit existing brief. Original images are not fetched by the text research
API; do not describe generated visual suggestions as retrieved original art.
Use synthetic sources/keys; mocked results do not prove live fact accuracy,
coverage, search quality, account access or billing.
For optional research, test duration estimates, validated source links, cancellation/error preservation,
draft restoration and handoff to scene creation. API/unit/browser fixtures must
not be described as verified live AI generation. Without configured credentials,
finish independent tests and report live web-search/generation as unverified.
For whole-video image changes, run npm run test:whole-video-browser, existing
scene-batch/timed-workflow/direct-image regressions and npm test. Verify complete
source/all IDs in planner, no images before separate acknowledgement, global and
local prompt context, all remaining slots despite single selection, exact placement,
partial error/stop/explicit resume, zero-ref JSON versus actual-ref multipart,
canonical backup/workspace/stale-response guards, authenticated public route and
paid-job lock, and mobile controls. Synthetic replies do not verify live image
quality, model permissions or billing. Never execute paid generation in tests.
For source-fidelity changes, run npm run test:script-fidelity-browser and npm test.
Verify strict enum validation, full source/settings in actual direct/Node transport,
8->12/16 minute presets and 60-minute bounds, non-destructive selection, canonical
legacy/default backup and workspace roundtrips, actual character estimates, and
cancel/error preservation. Use synthetic reference material in committed tests;
never add user uploads to public source, fixtures or release archives. Mocked
provider responses do not establish actual narrative fidelity or completeness.
For operation feedback, run npm run test:operation-browser and
npm run test:local-operations-browser. Exercise delayed success, provider/storage
failure, cancel/restart, terminal elapsed-time freeze, aria-busy cleanup and stale
response guards. New-page status panels remain hidden until their relevant action.
For narration styles, test all four request modes, legacy defaults and backup
roundtrips, numeric examples, URL/citation/research-meta cleanup without removing
story facts, preserved evidence and narration-only copy/TXT/voice/timing handoffs.
Changing the selector must preserve current text; local cleanup must not claim
English phonetic AI rewriting or web verification. Mocked output cannot establish
actual pronunciation, search quality or provider model access.
For timing/batch changes, verify 157-sentence text becomes48slots at8minutes/10s,
partial final intervals, all-text preservation, <=200 bounds and stable preview IDs.
Verify no mutation/provider call before confirmation and no image call on timing
confirmation; old project/media archival precedes retiming. Exercise per-slot prompt
review, required acknowledgement, exact scene/time application, skip/replace,
partial completion/error/cancel, explicit resume, stale reference/script/voice
rejection, and plan retention in workspace/library/backups/undo. Matching speech/SRT
keeps actual cue times; mismatched text falls back without fake alignment.
Use npm run test:scene-timing-browser, test:scene-batch-browser and
test:timed-workflow-browser plus npm test. Synthetic image fixtures do not prove
live generation quality, model permissions, per-image pricing or billing.
For layout changes, run npm run test:layout-browser and relevant existing browser
suites through actual menu/drawer interactions. Verify initially closed optional
tools, project menu actions, summary keyboard handling, modal return focus, retained
drawer state across rerenders/workspaces, and mobile access without horizontal
overflow. Presentation changes must not affect project/media persistence, provider
request authorization, API-key lifetime or the image batch confirmation gate.
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
Current cloud server credentials are absent; users may still supply a personal key in app Settings for direct requests. Finish independent unit/API/browser tests
with synthetic audio and clearly report live Korean recognition as unverified unless an actual authorized request succeeds.
For CLOVA voice, inspect real text/form request bytes, exact Unicode chunk
preservation, credential isolation and sanitized failures. Test actual synthetic
MP3 decoding, measured-duration WAV merging, preview/download/Apply, undo/redo,
cancellation/error/stale preservation and unconfigured static Pages behavior.
Current CLOVA credentials are absent: fixture tests do not verify live Korean
pronunciation, audio quality, account permissions or billing.

## Source and deployment

The latest public static editor is https://battlebuild001.github.io/image-studio/,
served from the owned image-studio-web branch. The older chatgpt.site deployment
was not updated. Static Pages hosts no Node API, but app-configured personal OpenAI
keys support browser-direct script/image/transcription requests. CLOVA and shared
server-key mode need the optional authenticated backend. Manual drafts, local
document extraction and normal media editing work without credentials.

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
Public shared-key API backends require authentication and per-user usage controls;
do not expose the local development server as an unauthenticated billing proxy.
Personal browser-direct OpenAI mode uses the user-supplied key and account limits
and must not embed or distribute a shared provider credential.

## Public AI connection

Use `apiFetch` for frontend studio requests; it selects the explicitly configured direct OpenAI or authenticated server transport. Connection changes abort obsolete requests and must not trigger paid generation or copy references into a draft. Script generation sends source text, production instructions and duration to the chosen provider transport; manual reference copying stays explicitly separate. Missing CLOVA keys never block script or image generation. In optional server mode accept cross-origin provider routes only after `createBackendAccess` sets the internal `req.studioAuthenticated` marker; never trust an incoming marker/header. Server-held credentials never go to the browser. Public server APIs require a separate app access token, exact allowed origin, at most ten accepted POST requests per minute and one active paid job per server.

Image creation shares the same personal OpenAI settings/key as script creation. Optional server mode may reuse SCRIPT_AI_API_KEY. Unavailable studios must open app API settings while keeping references/input/results intact. Opening settings and checking configuration never uploads image pixels or starts paid generation. Verify authenticated cross-origin image bytes with tests/image-backend-integration.test.mjs and the browser connection flow with tests/image-ai-connection.browser.cjs. These use synthetic provider responses, not live AI fidelity checks.
