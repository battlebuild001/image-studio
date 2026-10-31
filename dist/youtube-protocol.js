/** Browser-safe YouTube upload data. OAuth tokens and upload-session URLs never belong here. */
export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_SCOPES = `${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_READONLY_SCOPE}`;
export const YOUTUBE_MAX_VIDEO_BYTES = 256 * 1024 ** 3;
export const YOUTUBE_MAX_DESCRIPTION_BYTES = 5000;

const encoder = new TextEncoder();
const PRIVACY = new Set(['private', 'unlisted', 'public']);
const DRAFT_FIELDS = new Set(['title', 'description', 'tags', 'privacyStatus', 'selfDeclaredMadeForKids', 'containsSyntheticMedia']);
const METADATA_FIELDS = new Set([...DRAFT_FIELDS, 'categoryId', 'defaultLanguage']);
const RECORD_FIELDS = new Set(['videoId', 'videoUrl', 'title', 'privacyStatus', 'channelId', 'channelTitle', 'uploadedAt', 'fileName', 'bytes']);
const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/mpeg', 'video/mp2t', 'video/x-msvideo', 'video/avi', 'video/x-flv', 'video/x-ms-wmv', 'video/3gpp', 'video/3gpp2', 'video/ogg']);
const FILE_MIME = new Map([['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['webm', 'video/webm'], ['mkv', 'video/x-matroska'], ['mov', 'video/quicktime'], ['mpeg', 'video/mpeg'], ['mpg', 'video/mpeg'], ['ts', 'video/mp2t'], ['avi', 'video/x-msvideo'], ['flv', 'video/x-flv'], ['wmv', 'video/x-ms-wmv'], ['3gp', 'video/3gpp'], ['3g2', 'video/3gpp2'], ['ogv', 'video/ogg']]);
const CREDENTIAL = /\b(?:ya29\.[A-Za-z0-9_-]{16,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/u;
function fail(message) {throw new Error(message);}
function plain(value) {return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);}
function fields(input, allowed, label) {
  if (!plain(input) || Object.keys(input).some(key => !allowed.has(key))) fail(`${label}에 지원하지 않는 항목이나 인증 정보가 있어요.`);
}
function string(value, max, label, {blank = true, multiline = false, trim = false} = {}) {
  if (typeof value !== 'string' || Array.from(value).length > max || CREDENTIAL.test(value) || /[<>\u0000]/u.test(value) || (multiline ? /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0001-\u001f\u007f]/u).test(value)) fail(`${label}은 ${max.toLocaleString('ko-KR')}자 이하이고 < > 및 제어 문자가 없어야 해요.`);
  const result = trim ? value.trim() : value;
  if (!blank && !result.trim()) fail(`${label}을 입력해 주세요.`);
  return result;
}
function bool(value, label) {if (typeof value !== 'boolean') fail(`${label}을 선택해 주세요.`);return value;}
function displayText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max || CREDENTIAL.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}의 길이와 문자를 확인해 주세요.`);
  return value;
}
function privacy(value) {if (!PRIVACY.has(value)) fail('공개 상태는 비공개·일부 공개·공개 중에서 선택해 주세요.');return value;}
function tags(input) {
  if (!Array.isArray(input) || input.length > 30) fail('태그는 최대 30개까지 입력할 수 있어요.');
  const result = input.map(value => string(value, 500, '태그', {blank: false, trim: true}));
  if (youtubeTagCharacterCount(result) > 500) fail('태그는 쉼표와 공백 태그의 따옴표를 포함해 합계 500자 이하여야 해요.');
  return result;
}

/** YouTube counts separators and an implied pair of quotes for tags containing spaces. */
export function youtubeTagCharacterCount(values) {
  if (!Array.isArray(values)) fail('태그 목록을 확인해 주세요.');
  return values.reduce((sum, value) => {
    if (typeof value !== 'string') fail('태그는 글자로 입력해 주세요.');
    return sum + Array.from(value).length + (/\s/u.test(value) ? 2 : 0);
  }, Math.max(0, values.length - 1));
}

/** A Web OAuth client ID is public configuration; API keys/client secrets are not accepted. */
export function normalizeYouTubeClientId(input) {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string' || input.length > 256) fail('Google 웹 OAuth 클라이언트 ID를 확인해 주세요.');
  const value = input.trim();
  if (!value) return '';
  if (!/^[0-9]{6,}-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(value)) fail('Google 웹 OAuth 클라이언트 ID(.apps.googleusercontent.com)를 입력해 주세요. API 키나 클라이언트 보안 비밀은 사용하지 않아요.');
  return value;
}

/** Incomplete project drafts may have no title; all values still fit the real upload limits. */
export function normalizeYouTubeUploadDraft(input) {
  const value = input === undefined || input === null ? {} : input;
  fields(value, DRAFT_FIELDS, '유튜브 업로드 설정');
  const result = {
    title: string(value.title ?? '', 100, '영상 제목', {trim: true}),
    description: string(value.description ?? '', 5000, '영상 설명', {multiline: true}),
    tags: tags(value.tags ?? []),
    privacyStatus: privacy(value.privacyStatus ?? 'private'),
    selfDeclaredMadeForKids: bool(value.selfDeclaredMadeForKids ?? false, '아동용 여부'),
    containsSyntheticMedia: bool(value.containsSyntheticMedia ?? true, 'AI·합성 콘텐츠 여부'),
  };
  if (encoder.encode(result.description).byteLength > YOUTUBE_MAX_DESCRIPTION_BYTES) fail('영상 설명은 UTF-8 기준 5,000바이트 이하여야 해요. 한국어는 보통 한 글자에 3바이트예요.');
  return result;
}

export function normalizeYouTubeMetadata(input) {
  fields(input, METADATA_FIELDS, '유튜브 업로드 정보');
  for (const key of ['privacyStatus', 'selfDeclaredMadeForKids', 'containsSyntheticMedia']) if (input[key] === undefined || input[key] === null) fail('공개 상태·아동용 여부·AI 합성 여부를 확인해 주세요.');
  const draft = normalizeYouTubeUploadDraft(Object.fromEntries([...DRAFT_FIELDS].filter(key => input[key] !== undefined).map(key => [key, input[key]])));
  if (!draft.title) fail('영상 제목을 입력해 주세요.');
  // A fixed, valid category keeps this uploader small; project category names are unrelated.
  if (input.categoryId !== undefined && input.categoryId !== '22') fail('지원하는 유튜브 동영상 카테고리는 22번이에요.');
  if (input.defaultLanguage !== undefined && !['ko', 'en'].includes(input.defaultLanguage)) fail('영상 언어는 한국어 또는 영어로 선택해 주세요.');
  return {...draft, categoryId: '22', defaultLanguage: input.defaultLanguage ?? 'ko'};
}

export function buildYouTubeVideoResource(input) {
  const value = normalizeYouTubeMetadata(input);
  return {
    snippet: {title: value.title, description: value.description, tags: [...value.tags], categoryId: value.categoryId, defaultLanguage: value.defaultLanguage},
    status: {privacyStatus: value.privacyStatus, selfDeclaredMadeForKids: value.selfDeclaredMadeForKids, containsSyntheticMedia: value.containsSyntheticMedia},
  };
}

/** Only a small canonical receipt is portable; never store an OAuth response or session URI. */
export function normalizeYouTubeUploadRecord(input) {
  fields(input, RECORD_FIELDS, '유튜브 업로드 기록');
  if (typeof input.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/u.test(input.videoId)) fail('업로드된 유튜브 영상 ID를 확인하지 못했어요.');
  if (typeof input.channelId !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/u.test(input.channelId)) fail('업로드 채널 ID를 확인하지 못했어요.');
  const videoUrl = `https://www.youtube.com/watch?v=${input.videoId}`;
  if (input.videoUrl !== undefined && input.videoUrl !== videoUrl) fail('업로드 영상 주소가 유튜브 영상 ID와 맞지 않아요.');
  if (typeof input.uploadedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(input.uploadedAt) || !Number.isFinite(Date.parse(input.uploadedAt))) fail('업로드 시각을 확인해 주세요.');
  const uploadedAt = new Date(input.uploadedAt).toISOString();
  if (uploadedAt.slice(0, 19) !== input.uploadedAt.slice(0, 19)) fail('업로드 시각이 올바른 날짜가 아니에요.');
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > YOUTUBE_MAX_VIDEO_BYTES) fail('업로드한 영상 크기를 확인해 주세요.');
  const fileName = displayText(input.fileName, 180, '영상 파일 이름').trim();
  if (/[\\/]/u.test(fileName) || fileName === '.' || fileName === '..') fail('영상 파일 이름에 폴더 경로를 넣을 수 없어요.');
  return {videoId: input.videoId, videoUrl, title: string(input.title, 100, '업로드 제목', {blank: false, trim: true}), privacyStatus: privacy(input.privacyStatus), channelId: input.channelId, channelTitle: displayText(input.channelTitle, 150, '업로드 채널 이름'), uploadedAt, fileName, bytes: input.bytes};
}

function chapterTimestamp(value) {
  if (!Number.isFinite(value) || value < 0 || value > 86400) fail('게시 챕터 시간을 확인해 주세요.');
  const seconds = Math.floor(value), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(hours ? minutes : Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Explicit import only: keep the supplied description and add actual chapter lines. */
export function publishingToYouTubeMetadata(project) {
  if (!plain(project)) fail('게시 자료를 가져올 프로젝트를 확인해 주세요.');
  const result = project.production?.publishing?.result;
  if (!result) return normalizeYouTubeUploadDraft({title: project.title ?? ''});
  if (!plain(result) || !Array.isArray(result.titles) || !result.titles.length || !Array.isArray(result.chapters) || result.chapters.length > 60) fail('저장된 게시 자료를 확인해 주세요.');
  const selected = project.production?.publishing?.selectedTitle ?? 0;
  const title = result.titles[selected] ?? result.titles[0];
  const description = result.description ?? '';
  if (typeof description !== 'string') fail('게시 설명을 확인해 주세요.');
  const chapters = result.chapters.map(chapter => {
    if (!plain(chapter)) fail('게시 챕터를 확인해 주세요.');
    return `${chapterTimestamp(chapter.start)} ${string(chapter.title, 200, '챕터 제목', {blank: false, trim: true})}`;
  });
  return normalizeYouTubeUploadDraft({title, description: `${description}${chapters.length ? `${description ? '\n\n' : ''}챕터\n${chapters.join('\n')}` : ''}`, tags: result.tags ?? []});
}

/** Deterministic canonicalization: unrelated metadata or key insertion order cannot stale an export. */
export function youtubeExportSourceKey(project) {
  if (!plain(project)) fail('영상 내보내기 프로젝트를 확인해 주세요.');
  const selected = {id: project.id ?? '', title: project.title ?? '', aspect: project.aspect ?? '16:9', settings: project.settings ?? {}, scenes: project.scenes ?? [], audio: project.audio ?? {}, captions: project.captions ?? [], captionMode: project.captionMode ?? 'auto', captionAnalysis: project.captionAnalysis ?? null};
  const seen = new Set();let nodes = 0;
  function canonical(value, depth = 0) {
    if (++nodes > 60000 || depth > 20) fail('영상 상태가 너무 복잡해요.');
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {if (!Number.isFinite(value)) fail('영상 상태에 올바르지 않은 숫자가 있어요.');return value;}
    if (typeof value !== 'object' || seen.has(value)) fail('영상 상태를 확인하지 못했어요.');
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = value.map(item => canonical(item, depth + 1));
    else {if (!plain(value)) fail('영상 상태를 확인하지 못했어요.');result = {};for (const key of Object.keys(value).sort()) if (value[key] !== undefined) result[key] = canonical(value[key], depth + 1);}
    seen.delete(value);return result;
  }
  const serialized = JSON.stringify(canonical(selected));
  let first = 2166136261, second = 5381;
  for (let index = 0; index < serialized.length; index++) {const code = serialized.charCodeAt(index);first = Math.imul(first ^ code, 16777619);second = Math.imul(second, 33) ^ code;}
  return `youtube-export-v1-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}-${serialized.length}`;
}

/** Validate the file descriptor, not codec content: YouTube performs media processing after upload. */
export function validateYouTubeVideoFile(blob) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob) || !Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > YOUTUBE_MAX_VIDEO_BYTES) fail('비어 있지 않은 256GB 이하 영상 파일을 선택해 주세요.');
  const name = typeof blob.name === 'string' ? blob.name : '';
  if (name && (!name.trim() || Array.from(name).length > 180 || CREDENTIAL.test(name) || /[\u0000-\u001f\u007f\\/]/u.test(name))) fail('영상 파일 이름은 폴더 경로 없이 180자 이하여야 해요.');
  let mimeType = String(blob.type || '').split(';', 1)[0].trim().toLowerCase();
  // Some operating systems leave a supported video file's MIME empty. Infer only from an explicit File name.
  if (!mimeType && name) mimeType = FILE_MIME.get(name.slice(name.lastIndexOf('.') + 1).toLowerCase()) ?? '';
  if (mimeType === 'video/x-m4v') mimeType = 'video/mp4';
  if (!VIDEO_MIME.has(mimeType)) fail('MP4·WebM·MOV 등 지원하는 영상 파일을 선택해 주세요.');
  return mimeType;
}
