/** Playlist metadata only. OAuth credentials and API response bodies never belong in projects. */
export const YOUTUBE_PLAYLIST_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/u, PLAYLIST = /^[A-Za-z0-9_-]{10,150}$/u, VIDEO = /^[A-Za-z0-9_-]{11}$/u, ITEM = /^[A-Za-z0-9_-]{6,240}$/u;
const CREDENTIAL = /\b(?:ya29\.[A-Za-z0-9_-]{16,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/u;
const CAPABILITY = /https:\/\/[^\s]*[?&](?:upload_id|access_token|refresh_token|signature|x-goog-signature)=/iu;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
function fail(message) {throw new Error(message);}
function fields(value, allowed, label) {if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}에 지원하지 않는 항목이 있어요.`);}
function identifier(value, pattern, label) {if (typeof value !== 'string' || !pattern.test(value) || CREDENTIAL.test(value)) fail(`${label}을 확인해 주세요.`);return value;}
function title(value) {if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 150 || /[\u0000-\u001f\u007f]/u.test(value) || CREDENTIAL.test(value) || CAPABILITY.test(value)) fail('재생목록 제목의 길이와 문자를 확인해 주세요.');return value;}
function timestamp(value) {if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) fail('재생목록 처리 시각을 확인해 주세요.');const normalized=new Date(value).toISOString();if(normalized.slice(0,19)!==value.slice(0,19))fail('재생목록 처리 시각이 올바르지 않아요.');return normalized;}
export function validatePlaylistId(value) {return identifier(value,PLAYLIST,'재생목록 ID');}
export function validatePlaylistVideoId(value) {return identifier(value,VIDEO,'재생목록에 추가할 영상 ID');}
export function validatePlaylistChannelId(value) {return identifier(value,CHANNEL,'재생목록의 소유 채널');}
export function validatePlaylistItemId(value) {return identifier(value,ITEM,'재생목록 항목 ID');}
export function normalizePlaylistSelection(input) {
  if (input === undefined || input === null) return null;
  fields(input,['id','title','channelId'],'재생목록 선택');
  return {id:validatePlaylistId(input.id),title:title(input.title),channelId:validatePlaylistChannelId(input.channelId)};
}
export function normalizePlaylistTransfer(input) {
  fields(input,['videoId','playlistId','playlistTitle','channelId','status','updatedAt','playlistItemId'],'재생목록 처리 기록');
  if (!['pending','added','needs-check','failed','skipped'].includes(input.status)) fail('재생목록 처리 상태를 확인해 주세요.');
  const value={videoId:validatePlaylistVideoId(input.videoId),playlistId:validatePlaylistId(input.playlistId),playlistTitle:title(input.playlistTitle),channelId:validatePlaylistChannelId(input.channelId),status:input.status,updatedAt:timestamp(input.updatedAt)};
  if (input.playlistItemId !== undefined) value.playlistItemId=validatePlaylistItemId(input.playlistItemId);
  if (value.status === 'added' && !value.playlistItemId) fail('추가가 확인된 재생목록 항목 ID가 필요해요.');
  return value;
}
export function normalizePlaylistPageToken(input) {
  if (input === undefined || input === null || input === '') return '';
  if (typeof input !== 'string' || !/^[A-Za-z0-9._~+\/=\-]{1,1000}$/u.test(input) || CREDENTIAL.test(input)) fail('재생목록의 다음 페이지 정보를 확인해 주세요.');
  return input;
}
