import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_SCHEDULE_TIME_ZONE, normalizePublishAt, normalizeScheduleTimeZone, localDateTimeToUtc, utcToLocalDateTime, formatScheduleTime, assertYouTubeScheduleFuture, normalizeSeriesSchedulePlan, buildSeriesSchedule} from '../dist/youtube-schedule.js';
import {normalizeYouTubeUploadDraft, normalizeYouTubeMetadata, buildYouTubeVideoResource, normalizeYouTubeUploadRecord} from '../dist/youtube-protocol.js';

const now = Date.parse('2027-01-01T00:00:00Z'), future = '2027-01-02T00:00:00.000Z';
const metadata = patch => ({title: '예약할 영상', description: '검토한 내용 요약', tags: [], privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true, ...patch});
const pattern = patch => ({version: 1, mode: 'interval', startLocal: '2027-01-02T09:00', timeZone: 'Asia/Seoul', intervalMinutes: 360, dailyTimes: ['09:00','18:00'], ...patch});

test('valid dates canonicalize to exact UTC while invalid calendar/offset/input shapes reject', () => {
  assert.equal(normalizePublishAt('2027-01-02T09:00:00+09:00'), future);assert.equal(normalizePublishAt('2027-01-02T00:00:00Z'), future);
  assert.equal(normalizePublishAt('2027-01-02T00:00:00.12Z'), '2027-01-02T00:00:00.120Z');
  for (const value of [null, [], {}, '2027-02-29T00:00:00Z', '2027-04-31T00:00:00Z', '2027-01-01T24:00:00Z', '2027-01-01T00:00:60Z', '2027-01-01T00:00:00', '2027-01-01T00:00:00+24:00', '2027-01-01T00:00:00+01:60']) assert.throws(() => normalizePublishAt(value));
});

test('Korean and UTC wall times convert independently of machine zone and preserve seconds', () => {
  assert.equal(DEFAULT_SCHEDULE_TIME_ZONE, 'Asia/Seoul');assert.equal(localDateTimeToUtc('2027-01-02T09:00'), future);assert.equal(localDateTimeToUtc('2027-01-02T00:00', 'UTC'), future);
  assert.equal(utcToLocalDateTime(future), '2027-01-02T09:00');assert.equal(utcToLocalDateTime('2027-01-02T00:00:01.123Z'), '2027-01-02T09:00:01.123');
  assert.equal(localDateTimeToUtc('2027-01-02T09:00:01.123'), '2027-01-02T00:00:01.123Z');
  assert.match(formatScheduleTime(future), /2027-01-02 09:00.*Asia\/Seoul.*UTC\+09:00/u);assert.match(formatScheduleTime(future, 'UTC'), /UTC\+00:00/u);
  assert.equal(localDateTimeToUtc('2028-02-29T00:00', 'UTC'), '2028-02-29T00:00:00.000Z');
  for (const value of ['2027-02-29T12:00', '2027-01-01T24:00', '2027-01-01T09:60', '2027-01-01', '2027-01-01T01:00Z']) assert.throws(() => localDateTimeToUtc(value));
  for (const zone of ['', 'invalid/zone', [], {}, 'https://example.test']) assert.throws(() => normalizeScheduleTimeZone(zone));
});

test('DST gaps and duplicate local times reject instead of moving or choosing a different time', () => {
  assert.throws(() => localDateTimeToUtc('2027-03-14T02:30','America/New_York'), /존재하지/u);
  assert.throws(() => localDateTimeToUtc('2027-11-07T01:30','America/New_York'), /두 번/u);
  assert.equal(localDateTimeToUtc('2027-03-14T03:30','America/New_York'), '2027-03-14T07:30:00.000Z');
  assert.equal(localDateTimeToUtc('2027-11-07T02:30','America/New_York'), '2027-11-07T07:30:00.000Z');
  assert.match(formatScheduleTime('2027-07-01T12:00:00Z','America/New_York'), /UTC-04:00/u);assert.match(formatScheduleTime('2027-01-01T12:00:00Z','America/New_York'), /UTC-05:00/u);
});

test('legacy drafts/resources retain identical keys and past schedules survive structural restoration', () => {
  const legacy = normalizeYouTubeUploadDraft(metadata());assert.equal(Object.hasOwn(legacy, 'publishAt'), false);assert.equal(Object.hasOwn(legacy, 'scheduleTimeZone'), false);
  const draft = normalizeYouTubeUploadDraft(metadata({publishAt: '2026-01-01T09:00:00+09:00', scheduleTimeZone: 'Asia/Seoul'}));assert.equal(draft.publishAt, '2026-01-01T00:00:00.000Z');
  assert.equal(normalizeYouTubeMetadata(draft).publishAt, draft.publishAt);assert.throws(() => assertYouTubeScheduleFuture(draft, {now}), {code: 'YOUTUBE_SCHEDULE_EXPIRED'});
  const disabled = normalizeYouTubeUploadDraft(metadata({scheduleTimeZone: 'UTC'}));assert.equal(disabled.scheduleTimeZone, 'UTC');assert.equal(Object.hasOwn(disabled, 'publishAt'), false);
  const resource = buildYouTubeVideoResource(metadata({publishAt: future, scheduleTimeZone: 'Asia/Seoul'}));assert.deepEqual(resource.status, {privacyStatus:'private', selfDeclaredMadeForKids:false, containsSyntheticMedia:true, publishAt:future});assert.equal(JSON.stringify(resource).includes('scheduleTimeZone'), false);
  for (const privacyStatus of ['unlisted','public']) assert.throws(() => normalizeYouTubeUploadDraft(metadata({privacyStatus,publishAt:future})), /비공개/u);
});

test('moving-clock checks enforce private future publication and initial/transfer lead without mutating drafts', () => {
  const scheduled = metadata({publishAt: '2027-01-01T00:02:00Z'}), copy = structuredClone(scheduled);
  assert.equal(assertYouTubeScheduleFuture(scheduled, {now}), '2027-01-01T00:02:00.000Z');assert.deepEqual(scheduled, copy);
  assert.throws(() => assertYouTubeScheduleFuture(scheduled, {now: now+1}), {code:'YOUTUBE_SCHEDULE_TOO_SOON'});
  assert.equal(assertYouTubeScheduleFuture(scheduled, {now: now+90000,minLeadMs:30000}), '2027-01-01T00:02:00.000Z');
  assert.throws(() => assertYouTubeScheduleFuture(scheduled, {now:now+90001,minLeadMs:30000}), {code:'YOUTUBE_SCHEDULE_TOO_SOON'});
  assert.throws(() => assertYouTubeScheduleFuture(scheduled, {now:now+120000,minLeadMs:0}), {code:'YOUTUBE_SCHEDULE_EXPIRED'});
  assert.throws(() => assertYouTubeScheduleFuture({...scheduled,privacyStatus:'public'}, {now}), {code:'YOUTUBE_SCHEDULE_PRIVATE'});assert.equal(assertYouTubeScheduleFuture(metadata(), {now}), null);
});

test('portable requested schedules and confirmation flags remain distinct from actual current privacy', () => {
  const record = {videoId:'synthetic01',title:'기록',privacyStatus:'public',channelId:'UC'+'a'.repeat(22),channelTitle:'합성 채널',uploadedAt:'2027-01-01T00:00:00Z',fileName:'test.webm',bytes:12,publishAt:future,scheduleTimeZone:'Asia/Seoul',scheduleConfirmed:false};
  assert.equal(normalizeYouTubeUploadRecord(record).scheduleConfirmed,false);assert.equal(normalizeYouTubeUploadRecord(record).privacyStatus,'public');
  assert.throws(() => normalizeYouTubeUploadRecord({...record,scheduleConfirmed:true}));
  const old = {...record,publishAt:'2026-01-01T00:00:00Z',privacyStatus:'private',scheduleConfirmed:true};assert.equal(normalizeYouTubeUploadRecord(old).publishAt,'2026-01-01T00:00:00.000Z');
  const orphan = {...record};delete orphan.publishAt;assert.throws(() => normalizeYouTubeUploadRecord(orphan));
});

test('interval and daily time slots produce exact chronological UTC series without dropped or duplicate slots', () => {
  assert.deepEqual(buildSeriesSchedule(pattern(),4,{now}), ['2027-01-02T00:00:00.000Z','2027-01-02T06:00:00.000Z','2027-01-02T12:00:00.000Z','2027-01-02T18:00:00.000Z']);
  assert.deepEqual(buildSeriesSchedule(pattern({mode:'daily',dailyTimes:['18:00','09:00']}),4,{now}), ['2027-01-02T00:00:00.000Z','2027-01-02T09:00:00.000Z','2027-01-03T00:00:00.000Z','2027-01-03T09:00:00.000Z']);
  assert.deepEqual(buildSeriesSchedule(pattern({mode:'daily',startLocal:'2027-01-02T10:00'}),2,{now}), ['2027-01-02T09:00:00.000Z','2027-01-03T00:00:00.000Z']);
  assert.equal(buildSeriesSchedule(pattern({mode:'daily',dailyTimes:['09:00']}),120,{now}).length,120);
  for (const count of [0,121,1.5]) assert.throws(() => buildSeriesSchedule(pattern(),count,{now}));
});

test('daily calendar slots differ from elapsed intervals across DST and invalid plans never silently skip dates', () => {
  const base=pattern({startLocal:'2027-03-13T12:00',timeZone:'America/New_York',intervalMinutes:1440,dailyTimes:['12:00']});
  assert.deepEqual(buildSeriesSchedule(base,2,{now}), ['2027-03-13T17:00:00.000Z','2027-03-14T17:00:00.000Z']);
  assert.deepEqual(buildSeriesSchedule({...base,mode:'daily'},2,{now}), ['2027-03-13T17:00:00.000Z','2027-03-14T16:00:00.000Z']);
  assert.throws(() => buildSeriesSchedule(pattern({startLocal:'2026-01-01T09:00'}),2,{now}), {code:'YOUTUBE_SCHEDULE_EXPIRED'});
  for (const patch of [{dailyTimes:['09:00','09:00']},{mode:'daily',dailyTimes:[]},{dailyTimes:['24:00']},{intervalMinutes:0},{unexpected:'value'}]) assert.throws(() => normalizeSeriesSchedulePlan(pattern(patch)));
  assert.throws(() => buildSeriesSchedule({...base,mode:'daily',startLocal:'2027-03-13T02:30',dailyTimes:['02:30']},2,{now}), /존재하지/u);
});
