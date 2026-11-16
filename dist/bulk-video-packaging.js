import {apiFetch} from './api-client.js';
import {validateProject, getTimeline} from './project.js';
import {buildUploadMetadataContext, generateUploadMetadata} from './upload-metadata.js';
import {normalizeProductionAssistantResult, validateProductionAssistantRequest} from './production-assistant-protocol.js';
import {composeDescriptionHashtags} from './description-hashtags.js';
import {getDescriptionPreferences, composeVideoDescription} from './description-preferences.js';
import {renderPublishingThumbnail} from './production-publishing.js';
import {canvasBlob, safeFilename} from './production-delivery-utils.js';
import {normalizeYouTubeUploadDraft, validateYouTubeThumbnailFile} from './youtube-protocol.js';

const reviews = new WeakMap();
const MAX_PIXELS = 32000000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abort = () => new DOMException('게시 자료 작성을 중지했어요. 기존 입력과 썸네일은 유지돼요.', 'AbortError');
const sourceKey = project => JSON.stringify({id: project.id, title: project.title, scenes: project.scenes, scriptDraft: project.scriptDraft,
  captions: project.captions, captionMode: project.captionMode, captionAnalysis: project.captionAnalysis,
  description: project.production?.description, channel: project.production?.channel, tags: project.production?.youtube?.draft?.tags || project.production?.publishing?.result?.tags || []});
const normalizedTitle = value => normalizeYouTubeUploadDraft({title: value, description: '', tags: []}).title;

async function decodeThumbnail(blob) {
  if (typeof createImageBitmap === 'function') {
    const image = await createImageBitmap(blob);
    return {width: image.width, height: image.height, release() {image.close();}};
  }
  if (typeof Image !== 'function') throw new Error('썸네일 이미지를 읽을 수 있는 브라우저에서 다시 시도해 주세요.');
  const image = new Image(), url = URL.createObjectURL(blob);
  try {image.src = url;await image.decode();return {width: image.naturalWidth, height: image.naturalHeight, release() {URL.revokeObjectURL(url);}};}
  catch (cause) {URL.revokeObjectURL(url);throw cause;}
}

/** Validate bytes and decoded pixels before a selected image enters the durable
 * queue. The same shared YouTube size/MIME contract is used at dispatch. */
export async function validateBulkThumbnail(input, {decode = decodeThumbnail} = {}) {
  if (!plain(input) || !(input.blob instanceof Blob)) throw new Error('썸네일 PNG·JPEG 파일을 선택해 주세요.');
  const name = input.name === undefined ? '썸네일.png' : input.name;
  if (typeof name !== 'string' || !name.trim() || Array.from(name).length > 180 || /[\u0000-\u001f\u007f\\/]/u.test(name) || /(?:api[_-]?key|access[_-]?token|authorization|sk-[A-Za-z0-9_-]{10})/iu.test(name)) throw new Error('썸네일 파일 이름은 경로와 인증 정보 없이 180자 이내로 정해 주세요.');
  const type = await validateYouTubeThumbnailFile(input.blob);
  let image;
  try {
    image = await decode(input.blob);
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 8192 || image.height > 8192 || image.width * image.height > MAX_PIXELS) throw new Error('썸네일 크기는 가로·세로 8,192픽셀, 합계 3,200만 픽셀 이내로 준비해 주세요.');
    return {blob: input.blob.type === type ? input.blob : input.blob.slice(0, input.blob.size, type), name, type, width: image.width, height: image.height};
  } catch (cause) {
    if (cause?.message?.startsWith('썸네일 크기')) throw cause;
    throw new Error('썸네일의 실제 이미지 픽셀을 읽지 못했어요. 정상 PNG·JPEG 파일로 다시 선택해 주세요.');
  } finally {image?.release?.();}
}

/** Pure scope preparation. Full kits use one existing text-AI request; rendering
 * scene-based thumbnails by themselves is local and never calls an image API. */
export function prepareBulkPackaging(project, options = {}) {
  const value = validateProject(project);
  if (!plain(options) || Object.keys(options).some(key => !['field','title','description','sceneId','layout','titlePosition'].includes(key))) throw new Error('일괄 게시 자료 설정을 확인해 주세요.');
  const field = options.field || 'all';
  if (!['all', 'description', 'thumbnail'].includes(field)) throw new Error('작성할 게시 자료 종류를 선택해 주세요.');
  if (!getTimeline(value).scenes.length) throw new Error('먼저 영상을 제작한 뒤 게시 자료를 작성해 주세요.');
  const title = normalizedTitle(options.title === undefined ? value.title : options.title);
  if (options.description !== undefined) normalizeYouTubeUploadDraft({title, description: options.description, tags: []});
  const sceneId = options.sceneId || value.scenes.find(scene => scene.imageId)?.id || '';
  if (field !== 'description' && !value.scenes.some(scene => scene.id === sceneId && scene.imageId)) throw new Error('썸네일에 사용할 실제 장면 이미지가 필요해요.');
  const layout = options.layout || 'overlay', titlePosition = options.titlePosition || 'center';
  if (!['overlay','split','band'].includes(layout) || !['top','center','bottom'].includes(titlePosition)) throw new Error('썸네일 배치와 문구 위치를 확인해 주세요.');
  const preferences = getDescriptionPreferences(value);
  const context = buildUploadMetadataContext(value, {currentTitle: title});
  const request = field === 'all' ? validateProductionAssistantRequest({task:'publishing', context, options:{descriptionLength:preferences.length}}) : null;
  const prepared = Object.freeze({field,requestCount:field === 'thumbnail' ? 0 : 1,title,sceneId,layout,titlePosition,
    ...(options.description === undefined ? {} : {description:options.description})});
  reviews.set(prepared, {sourceKey:sourceKey(project), request, preferences});
  return prepared;
}

/** Stage each job's result; callers explicitly persist only the requested fields.
 * No mutation/upload is performed here, so failed/stale replies leave edits intact. */
export async function generateBulkPackaging(api, prepared, {signal,guard,onProgress=()=>{},render=renderPublishingThumbnail,toBlob=canvasBlob,validateThumbnail=validateBulkThumbnail} = {}) {
  const saved = reviews.get(prepared);
  if (!saved || typeof api?.getProject !== 'function' || typeof api?.getAssets !== 'function') throw new Error('게시 자료의 작성 범위를 다시 확인해 주세요.');
  const imageSnapshots = new Map([...api.getAssets()].filter(([id]) => api.getProject().scenes.some(scene => scene.imageId === id)).map(([id,asset]) => [id,asset.blob]));
  const check = () => {if (signal?.aborted || guard?.() === false) throw abort();if (sourceKey(api.getProject()) !== saved.sourceKey) throw new Error('영상 내용이나 설명 설정이 바뀌었어요. 기존 입력을 유지하고 작성 범위를 다시 확인해 주세요.');if (prepared.field !== 'description' && [...imageSnapshots].some(([id,blob]) => api.getAssets().get(id)?.blob !== blob)) throw new Error('장면 이미지가 바뀌어 이전 썸네일은 적용하지 않았어요.');};
  check();
  const project = api.getProject(), assets = api.getAssets(), result = {};
  let concept = {sceneId:prepared.sceneId,headline:prepared.title,prompt:'현재 영상의 실제 장면 이미지를 사용하는 썸네일입니다.'};
  const scene = project.scenes.find(item => item.id === prepared.sceneId), originalBlob = scene?.imageId ? assets.get(scene.imageId)?.blob : null;
  if (prepared.field !== 'description' && !originalBlob) throw new Error('썸네일로 사용할 장면 이미지 파일을 찾지 못했어요.');
  if (prepared.field === 'all') {
    onProgress({phase:'packaging',message:'이 영상의 제목·소개글·썸네일 문구를 함께 작성하고 있어요.'});
    const response = await (api.apiFetch || apiFetch)('/api/production/assist', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(saved.request),signal});
    check();if (!response.ok) throw new Error('게시 자료를 작성하지 못했어요. AI 연결과 사용 한도를 확인해 주세요.');
    let data;try {data = await response.json();} catch {throw new Error('게시 자료 AI의 응답을 읽지 못했어요. 기존 입력은 유지했어요.');}check();
    const generated = normalizeProductionAssistantResult('publishing', data, saved.request);
    const chosen = generated.titles.find(title => Array.from(title).length <= 100 && !/[<>\r\n]/u.test(title));
    if (!chosen) throw new Error('AI 제목이 업로드 제목 한도를 넘었어요. 기존 제목은 유지했어요.');
    const draft = normalizeYouTubeUploadDraft({title:chosen,description:composeVideoDescription(generated.description,saved.preferences),tags:[]});
    result.title = draft.title;result.description = draft.description;
    concept = generated.thumbnailConcepts.find(item => project.scenes.some(scene => scene.id === item.sceneId && scene.imageId && assets.has(scene.imageId))) || {...concept,headline:generated.thumbnailConcepts[0]?.headline || draft.title};
  } else if (prepared.field === 'description') {
    onProgress({phase:'packaging',message:'이 영상의 소개글을 작성하고 있어요. 제목과 썸네일은 유지해요.'});
    const generated = await generateUploadMetadata(api, {field:'description',project,currentTitle:prepared.title,signal});check();
    result.description = normalizeYouTubeUploadDraft({title:prepared.title,description:generated.description,tags:[]}).description;
  }
  if (result.description !== undefined) {
    const tags = project.production?.youtube?.draft?.tags || project.production?.publishing?.result?.tags || [];
    const composed = composeDescriptionHashtags(result.description, tags, {enabled: saved.preferences.hashtags, ownedLine: ''});
    result.description = composed.description;result.hashtagLine = composed.hashtagLine;
  }
  if (prepared.field !== 'description') {
    check();
    if (assets.get(scene.imageId)?.blob !== originalBlob) throw new Error('장면 이미지가 바뀌어 이전 썸네일은 적용하지 않았어요.');
    onProgress({phase:'thumbnail',message:'실제 장면 이미지와 문구로 썸네일 PNG를 만들고 있어요.'});
    const canvas = await render(project,assets,concept,{signal,width:1280,height:720,thumbnail:{title:concept.headline,layout:prepared.layout,titlePosition:prepared.titlePosition}});check();
    const blob = await toBlob(canvas);check();
    result.thumbnail = await validateThumbnail({blob,name:`${safeFilename(result.title || prepared.title).slice(0,100)}-썸네일.png`});check();
    result.thumbnailSettings = {sceneId:concept.sceneId,title:concept.headline,layout:prepared.layout,titlePosition:prepared.titlePosition};
  }
  return result;
}
