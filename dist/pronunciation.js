/** Pure, bounded pronunciation dictionary shared by AI requests and local edits. */
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = value => value.replace(/\u0000/g, '').normalize('NFC').trim();
const count = value => Array.from(value).length;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function normalizePronunciations(value = []) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('발음 사전은 최대 200개까지 저장할 수 있어요.');
  const seen = new Set();
  return value.map(entry => {
    if (!plain(entry) || Object.keys(entry).some(key => !['term', 'reading'].includes(key)) || typeof entry.term !== 'string' || typeof entry.reading !== 'string') throw new Error('발음 사전은 용어와 읽는 발음으로 입력해 주세요.');
    const rawTerm = clean(entry.term), reading = clean(entry.reading);
    if (/[\r\n\u2028\u2029]/u.test(rawTerm + reading)) throw new Error('발음 사전의 용어와 발음은 한 줄로 입력해 주세요.');
    const term = rawTerm.replace(/\s+/gu,' '), key = term.toLocaleLowerCase('en-US');
    if (!term || !reading || count(term) > 100 || count(reading) > 200) throw new Error('사전 용어는 1~100자, 읽는 발음은 1~200자의 한 줄로 입력해 주세요.');
    if (seen.has(key)) throw new Error('발음 사전에 같은 용어가 겹쳐요. 중복 항목을 정리해 주세요.');
    seen.add(key);return {term, reading};
  });
}

/** Longest matches win in one pass, so one rule's output never triggers another.
 * Latin/numeric terms have Latin boundaries: ABOL은 matches, ABOLITE does not. */
export function applyPronunciationDictionary(text, entries = []) {
  if (typeof text !== 'string' || count(text) > 100000) throw new Error('발음 적용 대본은 100,000자 이하로 입력해 주세요.');
  const rules = normalizePronunciations(entries).sort((a, b) => count(b.term) - count(a.term));
  if (!rules.length) return text;
  const alternatives = rules.map(({term}) => {
    const value = term.split(/\s+/u).map(escape).join('[^\\S\\r\\n\\u2028\\u2029]+');
    return /^[A-Za-z0-9_]/u.test(term) || /[A-Za-z0-9_]$/u.test(term) ? `(?<![A-Za-z0-9_])(?:${value})(?![A-Za-z0-9_])` : value;
  });
  const byTerm = new Map(rules.map(rule => [rule.term.replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'), rule.reading]));
  return text.replace(new RegExp(alternatives.join('|'), 'giu'), match => byTerm.get(match.replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')) || match);
}

export function parsePronunciationLines(value) {
  if (typeof value !== 'string' || count(value) > 65000) throw new Error('발음 사전 입력이 너무 길어요.');
  const entries = value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const at = line.search(/=|→/u);
    if (at < 1) throw new Error(`발음 사전 ${index + 1}번째 줄을 ‘용어 = 읽는 발음’으로 입력해 주세요.`);
    return {term: line.slice(0, at), reading: line.slice(at + 1)};
  });
  return normalizePronunciations(entries);
}

export const pronunciationLines = entries => normalizePronunciations(entries).map(({term, reading}) => `${term} = ${reading}`).join('\n');
