/** Pure, credential-free YouTube publication times. Upload bytes are sent now. */
export const DEFAULT_SCHEDULE_TIME_ZONE = 'Asia/Seoul';
export const YOUTUBE_SCHEDULE_MIN_LEAD_MS = 120000;
export const YOUTUBE_SCHEDULE_TRANSFER_LEAD_MS = 30000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const formatters = new Map();
function fail(message, code = 'YOUTUBE_SCHEDULE_INVALID') {const error = new Error(message);error.code = code;throw error;}
export function normalizeScheduleTimeZone(value = DEFAULT_SCHEDULE_TIME_ZONE) {
  if (typeof value !== 'string' || !value || value.length > 100 || !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/u.test(value)) fail('예약 공개의 시간대를 확인해 주세요.');
  try {return new Intl.DateTimeFormat('en-US', {timeZone: value}).resolvedOptions().timeZone;} catch {fail('지원하지 않는 시간대예요. 한국 시간 또는 다른 시간대를 선택해 주세요.');}
}
export function normalizePublishAt(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) fail('예약 공개 시각은 시간대가 포함된 올바른 날짜와 시간이어야 해요.');
  const [year, month, day, hour, minute, second] = match.slice(1,7).map(Number), civil = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || civil.getUTCFullYear() !== year || civil.getUTCMonth() !== month - 1 || civil.getUTCDate() !== day || match[8] !== 'Z' && (Number(match[8].slice(1,3)) > 23 || Number(match[8].slice(4,6)) > 59)) fail('예약 공개 날짜가 올바르지 않아요.');
  const result = new Date(value).toISOString();if (!/^\d{4}-/u.test(result)) fail('예약 공개 날짜 범위를 확인해 주세요.');return result;
}
function localParts(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(value);
  if (!match) fail('예약 공개 날짜와 시간을 모두 입력해 주세요.');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(part => Number(part || 0)), millisecond = Number((match[7] || '').padEnd(3, '0'));
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) fail('존재하는 날짜와 시간을 입력해 주세요.');
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, millisecond), date = new Date(epoch);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail('존재하지 않는 예약 공개 날짜예요.');
  return {year, month, day, hour, minute, second, millisecond, epoch};
}
function formatter(zone) {
  let value = formatters.get(zone);
  if (!value) {if (formatters.size > 32) formatters.clear();value = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});formatters.set(zone, value);}
  return value;
}
function partsAt(epoch, zone) {
  const result = {};for (const part of formatter(zone).formatToParts(new Date(epoch))) if (['year','month','day','hour','minute','second'].includes(part.type)) result[part.type] = Number(part.value);return result;
}
const padded = value => String(value).padStart(2, '0');
/** Reject both DST gaps and duplicate wall times instead of silently choosing a different instant. */
export function localDateTimeToUtc(value, timeZone = DEFAULT_SCHEDULE_TIME_ZONE) {
  const requested = localParts(value), zone = normalizeScheduleTimeZone(timeZone), offsets = new Set(), matches = [];
  for (let hours = -48; hours <= 48; hours += 6) {const instant = requested.epoch + hours * 3600000, sample = partsAt(instant, zone);offsets.add(Date.UTC(sample.year, sample.month - 1, sample.day, sample.hour, sample.minute, sample.second) - Math.floor(instant / 1000) * 1000);}
  for (const offset of offsets) {const epoch = requested.epoch - offset, actual = partsAt(epoch, zone);if (['year','month','day','hour','minute','second'].every(key => requested[key] === actual[key])) matches.push(epoch);}
  if (!matches.length) fail('이 시간대에는 선택한 현지 시각이 존재하지 않아요. 서머타임 전환을 피해 다른 시간을 선택해 주세요.');
  if (matches.length !== 1) fail('서머타임 전환으로 같은 현지 시각이 두 번 있어요. 구분되는 다른 시각이나 UTC 시간대를 선택해 주세요.');
  return normalizePublishAt(new Date(matches[0]).toISOString());
}
export function utcToLocalDateTime(value, timeZone = DEFAULT_SCHEDULE_TIME_ZONE) {
  const canonical = normalizePublishAt(value), date = new Date(canonical), actual = partsAt(date.getTime(), normalizeScheduleTimeZone(timeZone));
  return `${String(actual.year).padStart(4, '0')}-${padded(actual.month)}-${padded(actual.day)}T${padded(actual.hour)}:${padded(actual.minute)}${actual.second || date.getUTCMilliseconds() ? ':' + padded(actual.second) + (date.getUTCMilliseconds() ? '.' + String(date.getUTCMilliseconds()).padStart(3,'0') : '') : ''}`;
}
export function formatScheduleTime(value, timeZone = DEFAULT_SCHEDULE_TIME_ZONE) {
  const zone = normalizeScheduleTimeZone(timeZone), canonical = normalizePublishAt(value), local = utcToLocalDateTime(canonical, zone), milliseconds = Date.parse(canonical), civil = localParts(local), minutes = Math.round((civil.epoch - milliseconds) / 60000);
  const offset = minutes === 0 ? 'UTC+00:00' : `UTC${minutes > 0 ? '+' : '-'}${padded(Math.floor(Math.abs(minutes) / 60))}:${padded(Math.abs(minutes) % 60)}`;
  return `${local.replace('T', ' ')} · ${zone} (${offset})`;
}
/** Structural loading accepts past values. Only explicit arm/dispatch checks the moving clock. */
export function assertYouTubeScheduleFuture(metadata, {now = Date.now(), minLeadMs = YOUTUBE_SCHEDULE_MIN_LEAD_MS} = {}) {
  if (!metadata || metadata.publishAt === undefined) return null;
  const publishAt = normalizePublishAt(metadata.publishAt), current = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(current) || !Number.isFinite(minLeadMs) || minLeadMs < 0) fail('현재 시각을 확인하지 못했어요. 기기 시간을 확인해 주세요.');
  if (metadata.privacyStatus !== undefined && metadata.privacyStatus !== 'private') fail('예약 공개 영상은 비공개로 먼저 전송해야 해요.', 'YOUTUBE_SCHEDULE_PRIVATE');
  const remaining = Date.parse(publishAt) - current;
  if (remaining <= 0) fail('예약 공개 시각이 지났어요. 이미 완료된 영상은 YouTube에서 확인하고, 미완료 전송은 기존 전송 정보를 비운 뒤 새 예약으로 준비해 주세요.', 'YOUTUBE_SCHEDULE_EXPIRED');
  if (remaining < minLeadMs) fail(`예약 공개까지 최소 ${Math.ceil(minLeadMs / 1000)}초가 남아 있어야 해요. 전송을 완료할 수 있도록 예약 시각을 여유 있게 지정해 주세요.`, 'YOUTUBE_SCHEDULE_TOO_SOON');
  return publishAt;
}
function own(value, keys) {return plain(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => value[key] !== undefined);}
export function normalizeSeriesSchedulePlan(input) {
  if (!own(input, ['version','mode','startLocal','timeZone','intervalMinutes','dailyTimes']) || input.version !== 1 || !['interval','daily'].includes(input.mode) || !Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 525600 || !Array.isArray(input.dailyTimes) || input.dailyTimes.length > 24) fail('회차 예약 방식과 시간 간격을 확인해 주세요.');
  localParts(input.startLocal);const timeZone = normalizeScheduleTimeZone(input.timeZone);localDateTimeToUtc(input.startLocal, timeZone);
  if (input.dailyTimes.some(value => typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) || new Set(input.dailyTimes).size !== input.dailyTimes.length || input.mode === 'daily' && !input.dailyTimes.length) fail('하루 시간대는 중복 없이 시:분 형식으로 최대 24개까지 입력해 주세요.');
  return {version: 1, mode: input.mode, startLocal: input.startLocal, timeZone, intervalMinutes: input.intervalMinutes, dailyTimes: [...input.dailyTimes].sort()};
}
/** Exact reviewed UTC slots. Interval uses elapsed time; daily slots follow civil calendar dates. */
export function buildSeriesSchedule(input, count, options = {}) {
  const plan = normalizeSeriesSchedulePlan(input);if (!Number.isInteger(count) || count < 1 || count > 120) fail('예약할 회차는 1~120개여야 해요.');
  const result = [];
  if (plan.mode === 'interval') {const first = Date.parse(localDateTimeToUtc(plan.startLocal, plan.timeZone));for (let index = 0; index < count; index++) result.push(new Date(first + index * plan.intervalMinutes * 60000).toISOString());}
  else {const first = localParts(plan.startLocal);let day = Date.UTC(first.year, first.month - 1, first.day);
    while (result.length < count) {const date = new Date(day).toISOString().slice(0,10);for (const time of plan.dailyTimes) {const local = `${date}T${time}`;if (localParts(local).epoch < first.epoch) continue;result.push(localDateTimeToUtc(local, plan.timeZone));if (result.length === count) break;}day += 86400000;}
  }
  for (const publishAt of result) assertYouTubeScheduleFuture({publishAt, privacyStatus: 'private'}, options);
  if (result.some((value, index) => index > 0 && Date.parse(value) <= Date.parse(result[index-1]))) fail('회차별 공개 시각이 겹치거나 시간순이 아니에요.');
  return result;
}
