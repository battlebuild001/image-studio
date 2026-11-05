/** Explicit navigation only. No route performs generation, analysis or an upload. */
export const TOOL_ROUTE_IDS = Object.freeze([
  'script-draft','topic-research','source-files','reference-images','speech-texts','pronunciation',
  'voice-generation','voice-samples','audio-files','music','captions-edit','transcript','sync',
  'scene-timing','images-batch','image-reference','scene-layout','scene-effects','title-cards','diagrams',
  'quality','fidelity','chat-edit','partial-regenerate','image-review','version-history',
  'publishing','upload-video','shorts','shorts-framing','series','upload-settings',
  'project-defaults','channel-presets','budget','project-files','api-settings','workspace-management',
]);
const routeIds = new Set(TOOL_ROUTE_IDS);
const displayScript = project => project.scriptDraft?.displayScript ?? project.scriptDraft?.draftScript ?? project.scriptDraft?.result?.script ?? '';

export function getToolRouteAvailability(id, project, {canMutate = true, narrationPresent = false, hasSelection = false, planValid = false} = {}) {
  if (!routeIds.has(id)) return {available: false, reason: '알 수 없는 도구예요.'};
  if (!canMutate) return {available: false, reason: '진행 중인 파일 처리나 영상 출력을 마친 뒤 열어 주세요.'};
  const hasScenes = Boolean(project?.scenes?.length), hasScript = Boolean(String(displayScript(project || {})).trim() || project?.scenes?.some(scene => scene.caption?.trim())), hasImages = Boolean(project?.scenes?.some(scene => scene.imageId));
  if (['image-review','shorts-framing'].includes(id) && !hasImages) return {available: false, reason: '장면에 이미지를 먼저 추가한 뒤 사용할 수 있어요.'};
  if (['voice-generation','fidelity'].includes(id) && !hasScript) return {available: false, reason: '대본을 준비하거나 도구에서 직접 입력해 주세요.'};
  if (['shorts','chat-edit','partial-regenerate'].includes(id) && !hasScenes) return {available: false, reason: '장면을 먼저 추가한 뒤 사용할 수 있어요.'};
  if (id === 'images-batch' && !planValid) return {available: false, reason: '먼저 타이밍을 확인·확정하세요. 선택하면 타이밍 설정으로 이동해요.'};
  if (['transcript','sync'].includes(id) && !narrationPresent && !hasScenes) return {available: false, reason: '음성이나 장면을 먼저 추가하세요. 음성·자막 도구로 안내해요.'};
  if (id === 'transcript' && !narrationPresent) return {available: false, reason: '내레이션 파일을 먼저 추가하세요. 음성·자막 도구로 안내해요.'};
  if (['scene-layout','scene-effects'].includes(id) && (!hasScenes || !hasSelection)) return {available: false, reason: hasScenes ? '장면을 선택하면 편집할 수 있어요.' : '이미지를 먼저 추가하세요. 장면 목록으로 안내해요.'};
  if (id === 'scene-timing' && !hasScenes && !hasScript) return {available: false, reason: '대본을 입력하거나 이미지를 추가한 뒤 시간을 정할 수 있어요.'};
  return {available: true, reason: ''};
}

export function createToolRouter(api, doc = document) {
  function reveal(selector, {focus = true, scroll = true} = {}) {
    const target = doc.querySelector(selector);if (!target) return null;
    api.revealEditorTarget?.(target);
    if (target.tagName === 'DETAILS') target.open = true;
    const parents = [];for (let value = target.parentElement; value; value = value.parentElement) if (value.tagName === 'DETAILS') parents.push(value);
    for (const parent of parents.reverse()) parent.open = true;
    if (scroll) target.scrollIntoView?.({block: 'center', behavior: 'auto'});
    const focusTarget = target.tagName === 'DETAILS' ? target.querySelector(':scope > summary') : target;
    if (focus && !focusTarget?.disabled) focusTarget?.focus?.({preventScroll: true});
    return target;
  }
  function launch(id) {
    const target = doc.getElementById(id);
    if (!target || target.disabled) throw new Error('현재 작업을 마치거나 필요한 자료를 추가한 뒤 도구를 열어 주세요.');
    target.click();return target;
  }
  function openScript(target) {launch('scriptStudioBtn');if (target) reveal(target);}
  function editorTarget(target) {reveal(target);}
  function audio() {api.openAudioTools?.();editorTarget('#narrationBtn');}
  function ensureScene() {
    const project = api.getProject();if (!project.scenes.length) {api.showEditorPane?.('scenes');editorTarget('#imageDropzone');api.toast?.('이미지를 추가하거나 빈 장면을 만든 뒤 구도와 효과를 조정하세요.');return false;}
    if (!project.scenes.some(scene => scene.id === api.getSelectedId?.())) api.selectScene?.(project.scenes[0].id);
    return true;
  }
  async function open(id) {
    if (!routeIds.has(id)) throw new Error('등록되지 않은 도구는 열 수 없어요.');
    if (api.canMutate && !api.canMutate()) throw new Error('진행 중인 파일 처리나 영상 출력을 마친 뒤 도구를 열어 주세요.');
    api.flushProjectEditors?.({strict: true});api.pause?.();
    // Normal dialog close events cancel obsolete work; dirty fields have been flushed.
    for (const dialog of doc.querySelectorAll('dialog[open]')) if (dialog.id !== 'toolNavigationDialog') dialog.close();
    switch (id) {
      case 'script-draft': openScript();break;
      case 'topic-research': openScript('#researchTopic');break;
      case 'source-files': openScript('#chooseResearchFilesBtn');break;
      case 'reference-images': openScript('#referenceImageQuery');break;
      case 'speech-texts': api.openProductionSection('speech');break;
      case 'pronunciation': api.openProductionSection('speech');reveal('#productionPronunciations');break;
      case 'voice-generation': await api.openVoiceStudio();break;
      case 'voice-samples': await api.openVoiceStudio();reveal('#voiceSavedSampleSelect');break;
      case 'audio-files': audio();break;
      case 'music': api.openMusicRecommendations();break;
      case 'captions-edit': launch('captionEditorBtn');break;
      case 'transcript': if (!api.getAssets().get(api.getProject().audio?.narrationId)) {audio();api.toast?.('내레이션 파일을 추가한 뒤 음성 분석을 실행하세요.');} else api.openTranscriptStudio();break;
      case 'sync': if (!api.getProject().scenes.length) {audio();api.toast?.('장면과 음성을 추가한 뒤 싱크를 맞출 수 있어요.');} else api.openSyncStudio();break;
      case 'scene-timing': api.openTimingPlan();break;
      case 'images-batch': if (!api.hasConfirmedScenePlan?.()) {api.openTimingPlan();api.toast?.('이미지 전환 타이밍을 확인·확정한 뒤 장면 이미지를 만들 수 있어요.');} else api.openSceneImageBatch();break;
      case 'image-reference': api.openImageStudio();break;
      case 'scene-layout': if (ensureScene()) editorTarget('#focusX');break;
      case 'scene-effects': if (ensureScene()) editorTarget('#sceneExposure');break;
      case 'title-cards': launch('templatesBtn');break;
      case 'diagrams': api.openProductionSection('diagrams');break;
      case 'quality': api.openAiAssistant('quality');break;
      case 'fidelity': api.openAiAssistant('fidelity');break;
      case 'chat-edit': api.openAiAssistant('chat');break;
      case 'partial-regenerate': api.openProductionSection('changes');break;
      case 'image-review': api.openProductionSection('visual');break;
      case 'version-history': api.openProductionSection('versions');break;
      case 'publishing': api.openProductionSection('publishing');break;
      case 'upload-video': api.openProductionSection('youtube');break;
      case 'shorts': api.openProductionSection('shorts');break;
      case 'shorts-framing': api.openProductionSection('shorts');reveal('#shortsFramingSection');break;
      case 'series': api.openProductionSection('series');break;
      case 'upload-settings': api.openProductionSection('settings');break;
      case 'project-defaults': api.openProductionSection('basics');break;
      case 'channel-presets': api.openProductionSection('channels');break;
      case 'budget': api.openProductionSection('budget');break;
      case 'project-files': api.openProjectMenu?.();reveal('#projectMenuSummary', {scroll: false});break;
      case 'api-settings': api.openApiSettings();break;
      case 'workspace-management': launch('manageWorkspacesBtn');break;
    }
    return {opened: true};
  }
  function availability(id) {
    const project = api.getProject();return getToolRouteAvailability(id, project, {canMutate: !api.canMutate || api.canMutate(), narrationPresent: Boolean(api.getAssets().get(project.audio?.narrationId)), hasSelection: Boolean(api.getSelectedId?.()), planValid: Boolean(api.hasConfirmedScenePlan?.())});
  }
  return {open, availability};
}
