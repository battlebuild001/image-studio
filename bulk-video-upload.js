import {youtubeClient} from './youtube-client.js';
import {normalizeYouTubeMetadata,normalizeYouTubeUploadDraft,normalizeYouTubeUploadRecord,publishingToYouTubeMetadata,validateYouTubeVideoFile,YOUTUBE_MAX_THUMBNAIL_BYTES} from './youtube-protocol.js';
import {assertYouTubeScheduleFuture,normalizePublishAt,normalizeScheduleTimeZone} from './youtube-schedule.js';
import {composeVideoDescription,getDescriptionPreferences} from './description-preferences.js';
import {getDisplayScript} from './production-speech.js';

const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/u;
const VIDEO = /^[A-Za-z0-9_-]{11}$/u;
const settingsFields = new Set(['privacyStatus','selfDeclaredMadeForKids','containsSyntheticMedia','scheduleTimeZone','defaultLanguage','channelId']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const abort = () => new DOMException('영상 예약 업로드를 중지했어요. 이미 전송한 영상은 YouTube에서 유지돼요.','AbortError');
const instant = value => {const current = typeof value === 'function' ? value() : value;const epoch = current instanceof Date ? current.getTime() : current;if (!Number.isFinite(epoch)) throw new Error('현재 시각을 확인하지 못했어요.');return epoch;};
const check = (signal,guard) => {if (signal?.aborted || guard?.() === false) throw abort();};
const immutable = value => {if (value && typeof value === 'object') {for (const item of Object.values(value)) immutable(item);Object.freeze(value);}return value;};

/** Local session checks only. This does not connect, widen scopes or fetch Google. */
export function validateBulkUploadChannel(prepared,client = youtubeClient) {
  const session = client.getSession();
  if (!session?.connected || !CHANNEL.test(session.channelId || '')) throw new Error('YouTube 채널을 한 번 연결한 뒤 대량 제작을 시작해 주세요.');
  if (prepared?.channelId && session.channelId !== prepared.channelId) throw new Error('확인한 업로드 채널이 바뀌었어요. 원래 채널로 다시 연결한 뒤 제작 범위를 확인해 주세요.');
  return session;
}

function currentMetadata(project) {
  if (project.production?.youtube?.draft) return normalizeYouTubeUploadDraft(project.production.youtube.draft);
  if (project.production?.publishing?.result) return publishingToYouTubeMetadata(project);
  // This is a factual local draft from the actual supplied script, not an AI
  // rewrite or a claim that the resulting title/summary was web-verified.
  const script = getDisplayScript(project);
  const title = String(project.title || script.split('\n').find(line => line.trim()) || '새 영상').trim();
  return normalizeYouTubeUploadDraft({title,description:composeVideoDescription(script,getDescriptionPreferences(project)),tags:[]});
}

/** Pure preflight. Exact metadata and destination are displayed before one run. */
export function prepareBulkUpload({project,publishAt,settings = {},session,client = youtubeClient,thumbnail,now = Date.now()} = {}) {
  if (!plain(project) || !plain(settings) || Object.keys(settings).some(key => !settingsFields.has(key))) throw new Error('대량 업로드의 공통 설정을 확인해 주세요. 인증 정보는 프로젝트에 저장하지 않아요.');
  const target = session || validateBulkUploadChannel(null,client);
  if (!target.connected || !CHANNEL.test(target.channelId || '')) throw new Error('YouTube 채널을 먼저 연결해 주세요.');
  if (settings.channelId && settings.channelId !== target.channelId) throw new Error('대량 업로드 대상 채널이 연결한 채널과 달라요.');
  if (target.uploading || client.getUploadState?.().available) throw new Error('기존 YouTube 전송의 완료 여부를 먼저 확인해 주세요. 새 영상을 자동으로 올리지 않아요.');
  if (settings.privacyStatus !== undefined && settings.privacyStatus !== 'private') throw new Error('예약 공개 영상은 비공개로 먼저 업로드해야 해요.');
  const source = currentMetadata(project);
  const metadata = normalizeYouTubeMetadata({...source,privacyStatus:'private',
    selfDeclaredMadeForKids:settings.selfDeclaredMadeForKids ?? false,
    containsSyntheticMedia:settings.containsSyntheticMedia ?? true,
    publishAt:normalizePublishAt(publishAt),scheduleTimeZone:normalizeScheduleTimeZone(settings.scheduleTimeZone || 'Asia/Seoul'),
    defaultLanguage:settings.defaultLanguage || 'ko'});
  assertYouTubeScheduleFuture(metadata,{now:instant(now)});
  const channelTitle = typeof target.channelTitle === 'string' ? target.channelTitle : target.channelId;
  if (!channelTitle || Array.from(channelTitle).length > 150 || /[\u0000-\u001f\u007f]/u.test(channelTitle)) throw new Error('업로드 채널 이름을 확인하지 못했어요.');
  let selectedThumbnail;
  if (thumbnail) {
    const value = thumbnail instanceof Blob ? {blob:thumbnail,name:'썸네일.png'} : thumbnail;
    const mime = String(value?.blob?.type || value?.type || '').toLowerCase();
    if (!(value?.blob instanceof Blob) || !value.blob.size || value.blob.size > YOUTUBE_MAX_THUMBNAIL_BYTES || !['image/png','image/jpeg'].includes(mime)) throw new Error('함께 올릴 썸네일은 5MiB 이하의 PNG·JPEG 이미지여야 해요.');
    const name = value.name || (mime === 'image/png' ? '썸네일.png' : '썸네일.jpg');
    if (typeof name !== 'string' || !name.trim() || Array.from(name).length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(name)) throw new Error('썸네일 파일 이름을 확인해 주세요.');
    selectedThumbnail = {blob:value.blob,name,type:mime,...(Number.isInteger(value.width)?{width:value.width}:{}),...(Number.isInteger(value.height)?{height:value.height}:{})};
  }
  return immutable({metadata,channelId:target.channelId,channelTitle,scheduled:true,uploadCalls:1,thumbnailCalls:selectedThumbnail?1:0,...(selectedThumbnail?{thumbnail:selectedThumbnail}:{})});
}

/** Engine persists its uploading intent before calling this guarded transport.
 * No retry, new session recovery or metadata rewriting is performed here.
 */
export async function runBulkUpload({job,video,prepared,client = youtubeClient,signal,guard,onProgress,persist} = {}) {
  let metadata,fileName;
  try {
    check(signal,guard);
    if (!job?.project || !prepared?.metadata || !CHANNEL.test(prepared.channelId || '')) throw new Error('예약 업로드 범위를 다시 확인해 주세요.');
    if (!(video?.blob instanceof Blob) || !['mp4','webm'].includes(video.extension)) throw new Error('업로드할 실제 영상 파일을 먼저 만들어 주세요.');
    validateYouTubeVideoFile(video.blob);
    metadata = normalizeYouTubeMetadata(prepared.metadata);
    validateBulkUploadChannel(prepared,client);
    if (client.getUploadState?.().available) throw new Error('중단된 YouTube 전송이 있어요. 완료 여부를 먼저 확인해 주세요.');
    assertYouTubeScheduleFuture(metadata);
    check(signal,guard);
    fileName = `${job.project.title || metadata.title}.${video.extension}`.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'_').slice(0,170);
  } catch (cause) {cause.uploadNotStarted = true;throw cause;}
  const received = await client.uploadVideo({blob:video.blob,fileName,metadata,signal,onProgress,
    onSession:() => {onProgress?.({phase:'uploading',progress:0,uploadedBytes:0,totalBytes:video.blob.size,message:'영상 전송을 시작했어요. 응답이 불확실하면 새 업로드를 만들지 않아요.'});}});
  // A returned, canonical receipt must survive cancellation or a local-save error.
  // Never discard known remote completion and then initialize a duplicate upload.
  const receipt = normalizeYouTubeUploadRecord(received);
  if (receipt.channelId !== prepared.channelId || receipt.bytes !== video.blob.size) throw new Error('업로드 결과의 채널이나 파일 크기가 확인한 영상과 달라요. YouTube에서 먼저 확인해 주세요.');
  const {categoryId,defaultLanguage,...draft} = metadata;
  job.project.production ||= {version:1};
  job.project.production.youtube = {...job.project.production.youtube,draft,
    uploads:[...(job.project.production.youtube?.uploads || []).filter(item => item.videoId !== receipt.videoId),receipt].slice(-10)};
  if (persist) {
    try {await persist(job);} catch {
      const cause = new Error('YouTube 업로드는 완료됐지만 기록을 저장하지 못했어요. 같은 영상을 다시 올리지 말고 저장 공간을 확인해 주세요.');
      cause.code = 'BULK_UPLOAD_RECEIPT_SAVE_FAILED';cause.receipt = receipt;throw cause;
    }
  }
  return receipt;
}

/** Explicit user-observed recovery is kept separate from an API upload receipt. */
export function resolveBulkUploadConfirmation({videoId,channelId,session,now = Date.now()} = {}) {
  let id = videoId;
  if (typeof id === 'string' && !VIDEO.test(id)) {
    let url;try {url = new URL(id);} catch {}
    if (url?.protocol === 'https:' && !url.username && !url.password) {
      if (['www.youtube.com','youtube.com','m.youtube.com'].includes(url.hostname) && url.pathname === '/watch') id = url.searchParams.get('v');
      else if (url.hostname === 'youtu.be' && url.pathname.split('/').length === 2) id = url.pathname.slice(1);
    }
  }
  if (!VIDEO.test(id || '') || !CHANNEL.test(channelId || '')) throw new Error('YouTube에서 확인한 영상 주소와 업로드 채널을 확인해 주세요.');
  if (!session?.connected || session.channelId !== channelId) throw new Error('이 영상을 올리려던 같은 YouTube 채널로 연결한 뒤 확인해 주세요.');
  return {videoId:id,videoUrl:`https://www.youtube.com/watch?v=${id}`,channelId,confirmedAt:new Date(instant(now)).toISOString(),source:'user-confirmed'};
}


/** The video receipt must already be durable before this separate thumbnail action.
 * Failure retries this image only against the same uploaded video, never a new video.
 */
export async function runBulkThumbnail({receipt,thumbnail,client = youtubeClient,signal,guard,onProgress,validateThumbnail} = {}) {
  const record = normalizeYouTubeUploadRecord(receipt);
  try {
    check(signal,guard);validateBulkUploadChannel(record,client);
    const validate = validateThumbnail || (await import('./bulk-video-packaging.js')).validateBulkThumbnail;
    const selected = await validate(thumbnail instanceof Blob ? {blob:thumbnail,name:'썸네일.png'} : thumbnail);
    check(signal,guard);validateBulkUploadChannel(record,client);
    onProgress?.({phase:'thumbnail',message:'업로드한 같은 영상에 확인한 썸네일을 적용하고 있어요.'});
    const result = await client.setThumbnail({videoId:record.videoId,channelId:record.channelId,blob:selected.blob,signal});
    if (result?.videoId !== record.videoId || result?.uploaded !== true) throw new Error('썸네일 적용 결과를 확인하지 못했어요. 영상 업로드 결과는 유지돼요.');
    return {status:'completed',videoId:record.videoId,bytes:selected.blob.size};
  } catch (cause) {
    cause.bulkThumbnailOnly = true;cause.receipt = record;throw cause;
  }
}
