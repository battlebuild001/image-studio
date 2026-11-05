import {filterMiniatureTags} from './miniature-tags.js';
import {SUPPORT_BLOCK, getDescriptionSummary, composeSupportBlock} from './description-preferences.js';

const encoder = new TextEncoder();
const MAX_HASHTAGS = 5;
const tokenKey = value => value.normalize('NFKC').toLocaleLowerCase('ko-KR');
function fail(message) {throw new Error(message);}
function descriptionText(value) {
  if (typeof value !== 'string' || value.length > 300000) fail('영상 설명의 형식과 길이를 확인해 주세요.');
  return value;
}
function checkBudget(value) {
  if (encoder.encode(value).byteLength > 5000) fail('해시태그를 포함한 영상 설명이 5,000바이트를 넘어요. 본문을 줄인 뒤 다시 적용해 주세요.');
  return value;
}

/** Use only explicitly selected catalog tags, without changing the actual YouTube tags array. */
export function deriveDescriptionHashtags(tags = []) {
  if (!Array.isArray(tags)) fail('선택한 미니어처 게임 태그를 확인해 주세요.');
  const result = [], seen = new Set();
  for (const tag of filterMiniatureTags(tags)) {
    const token = tag.normalize('NFKC').replace(/[^\p{L}\p{N}_]/gu, '');
    if (!token) continue;
    const key = tokenKey(token);if (seen.has(key)) continue;
    seen.add(key);result.push('#' + token);
    if (result.length === MAX_HASHTAGS) break;
  }
  return result;
}

/** A portable ownership marker is a bounded exact line, not an API metadata field. */
export function normalizeOwnedHashtagLine(value = '') {
  if (typeof value !== 'string' || Array.from(value).length > 500 ||
      value !== '' && !/^#[\p{L}\p{N}_]+(?: #[\p{L}\p{N}_]+){0,4}$/u.test(value)) {
    fail('설명 해시태그 기록의 형식을 확인해 주세요.');
  }
  if (value) {
    const tokens = value.split(' ').map(tokenKey);
    if (new Set(tokens).size !== tokens.length) fail('설명 해시태그 기록에 중복이 있어요.');
  }
  return value;
}

function supportParts(text) {
  const body = getDescriptionSummary(text);
  return {body, tail: body === text ? '' : text.slice(body.length)};
}
function supportPayload(tail) {const index=tail.indexOf(SUPPORT_BLOCK);return index<0?{leading:'',payload:tail}:{leading:tail.slice(0,index),payload:tail.slice(index)};}
function appendSupport(body, tail) {
  if (!tail) return body;
  // A support-only description has no body separator until a hashtag line is inserted.
  if (!body) return tail.replace(/^\n{1,2}/u, '');
  return body + (/^\n/u.test(tail) ? tail : '\n\n' + tail);
}
function removeOwnedLine(body, line) {
  if (!line) return {body, removed: false};
  const candidate = body.replace(/\s+$/u, '');
  if (candidate === line) return {body: '', removed: true};
  for (const separator of ['\n\n', '\n']) {
    const suffix = separator + line;
    if (candidate.endsWith(suffix)) return {body: candidate.slice(0, -suffix.length), removed: true};
  }
  return {body, removed: false};
}

/** Remove only the exact previously owned final line; ordinary or edited hashtags remain untouched. */
export function stripOwnedDescriptionHashtags(text, ownedLine = '') {
  text = descriptionText(text);const line = normalizeOwnedHashtagLine(ownedLine);
  if (!line) return text;
  const {body, tail} = supportParts(text);
  if (tail) {
    const candidate=body.replace(/\s+$/u,''),offset=candidate.length-line.length;
    if(offset>=0&&candidate.slice(offset)===line&&/^\s*$/u.test(candidate.slice(0,offset))) {
      return candidate.slice(0,offset)+supportPayload(tail).payload;
    }
  }
  const next=removeOwnedLine(body,line);
  return next.removed ? appendSupport(next.body, tail) : text;
}

function manualHashtags(text) {
  const found = new Set();
  for (const match of text.matchAll(/#[\p{L}\p{N}_]+/gu)) {
    const index = match.index;
    if (index > 0 && /[\p{L}\p{N}_#]/u.test(text[index - 1])) continue;
    const before = text.slice(0, index), lastBreak = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\r'), before.lastIndexOf('\t'));
    // A URL fragment is not a visible standalone YouTube hashtag.
    if (/https?:\/\/\S*$/iu.test(before.slice(lastBreak + 1))) continue;
    found.add(tokenKey(match[0]));
  }
  return found;
}

/** The returned line records only text added by this action, before the exact support footer. */
export function composeDescriptionHashtags(text, tags, {enabled = true, ownedLine = ''} = {}) {
  if (typeof enabled !== 'boolean') fail('설명 해시태그 표시를 다시 선택해 주세요.');
  const stripped = stripOwnedDescriptionHashtags(text, ownedLine);
  if (!enabled) return {description: checkBudget(stripped), hashtagLine: ''};
  const desired = deriveDescriptionHashtags(tags), existing = manualHashtags(stripped);
  const hashtagLine = normalizeOwnedHashtagLine(desired.filter(token => !existing.has(tokenKey(token))).join(' '));
  if (!hashtagLine) return {description: checkBudget(stripped), hashtagLine: ''};
  const {body, tail} = supportParts(stripped);
  if(tail&&body.trim()==='') {
    const {leading,payload}=supportPayload(tail);
    return {description:checkBudget(body+leading+hashtagLine+'\n\n'+payload),hashtagLine};
  }
  const withLine=body?body+'\n\n'+hashtagLine:hashtagLine;
  return {description: checkBudget(appendSupport(withLine, tail)), hashtagLine};
}

/** Support changes never compact manual prose or delete hashtags the user wrote directly. */
export function composeDescriptionSupport(text, support, tags, {enabled = true, ownedLine = ''} = {}) {
  const withoutOwnedLine = stripOwnedDescriptionHashtags(text, ownedLine);
  const supported = composeSupportBlock(withoutOwnedLine, support);
  return composeDescriptionHashtags(supported, tags, {enabled, ownedLine: ''});
}
