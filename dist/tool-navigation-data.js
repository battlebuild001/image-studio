/** Readonly tool discovery. These entries open editors; they never run generation. */
export const TOOL_CATEGORIES = Object.freeze([
  {id: 'script', title: '자료·대본', description: '주제 조사부터 자막용·보이스용 대본까지', number: '01'},
  {id: 'audio', title: '음성·자막', description: '목소리, 음악과 자막의 시간 맞추기', number: '02'},
  {id: 'visual', title: '이미지·장면', description: '이미지 준비와 장면 구성·움직임', number: '03'},
  {id: 'review', title: '편집·검수', description: '완성도 점검과 필요한 구간 수정', number: '04'},
  {id: 'delivery', title: '게시·업로드', description: '썸네일, 영상 공개와 쇼츠 시리즈', number: '05'},
  {id: 'project', title: '프로젝트·연결', description: '저장, 기본 설정과 서비스 연결', number: '06'},
].map(Object.freeze));

const entries = [
  ['script-draft', 'script', '대본 작성', '주제나 참고 자료로 대본을 작성하고 직접 수정해요.', ['글쓰기', '시나리오', '스크립트', 'script', 'gpt', 'ai']],
  ['topic-research', 'script', '주제 자료 조사', '주제를 정하고 참고 자료·출처를 모아요.', ['자료 찾기', '레퍼런스 수집', '웹 검색', 'research', '조사']],
  ['source-files', 'script', '참고 파일 가져오기', 'TXT·PDF·DOCX 등의 글을 대본 참고 자료로 읽어요.', ['원문', '자료 파일', '문서', 'txt', 'md', 'pdf', 'docx']],
  ['reference-images', 'script', '이미지 자료 찾기', '실제 이미지 자료를 검색하고 사용할 자료를 골라요.', ['사진 검색', '시각 자료', '레퍼런스 검색', 'reference', '이미지 검색']],
  ['speech-texts', 'script', '자막용·보이스용 대본', '화면에 표시할 글과 목소리로 읽을 글을 따로 다듬어요.', ['영문 괄호', '헤드리스', '화면 대본', '음성 대본', '음차', '숫자']],
  ['pronunciation', 'script', '발음 사전', '이름·약어를 원하는 방식으로 읽도록 정해요.', ['고유명사', '영어', '음차', '발음', 'pronunciation']],
  ['voice-generation', 'audio', 'AI 음성 만들기', '목소리를 고르고 대본을 내레이션으로 만들어요.', ['목소리', '보이스', 'typecast', '타입캐스트', 'tts', 'voice'], 'script'],
  ['voice-samples', 'audio', '만든 음성 샘플', '이 프로젝트에 보관한 목소리 샘플을 다시 들어요.', ['샘플 보관함', '음성 저장', 'voice sample', '미리 듣기']],
  ['audio-files', 'audio', '내레이션·음악 파일', '음성·음악을 불러오고 사용 구간과 음량을 조절해요.', ['음성 불러오기', '오디오', '음악 추가', '볼륨', 'audio', 'mp3', 'wav']],
  ['music', 'audio', '배경음악 찾기', '영상 분위기에 맞는 음악을 추천받고 실제 음원을 찾아요.', ['음악 추천', 'bgm', '사운드', 'music', '배경 음악']],
  ['captions-edit', 'audio', '자막 문구·시간 편집', '자막을 직접 고치거나 SRT 파일을 사용해요.', ['srt', 'cc', 'subtitle', '자막 편집', '자막 이동', '자막 파일'], 'scenes'],
  ['transcript', 'audio', '음성 분석·자동 자막', '현재 내레이션의 실제 발화 시간으로 자막을 만들어요.', ['stt', '음성 인식', '자동 자막', 'transcript', '분석'], 'narration'],
  ['sync', 'audio', '싱크 다시 맞추기', '음성·영상·자막의 어긋난 시간을 확인하고 맞춰요.', ['싱크', '동기화', 'sync', '시간 보정', '자막 타이밍'], 'scenes'],
  ['scene-timing', 'visual', '이미지 전환 타이밍', '몇 초마다 이미지를 바꿀지 정하고 장면 시간표를 확인해요.', ['장면 수', '이미지 개수', '전환 간격', '타이밍', 'timeline'], 'script'],
  ['images-batch', 'visual', '영상 전체 이미지 만들기', '확정한 장면 계획을 검토하고 전체 이미지를 만들어요.', ['이미지 생성', '전체 생성', '일괄 생성', '컷', 'image', 'ai'], 'scenes'],
  ['image-reference', 'visual', '레퍼런스·한 컷 만들기', '기준 이미지·화풍을 정하고 필요한 한 장을 만들어요.', ['고정 레퍼런스', '배경 설정', '화풍', '프롬프트', 'reference', '한 장']],
  ['scene-layout', 'visual', '이미지 위치·구도', '선택한 장면의 크롭·맞춤·확대 위치를 조절해요.', ['프레이밍', '잘림', 'crop', 'pan', '이미지 맞춤', '위치'], 'selection'],
  ['scene-effects', 'visual', '장면 움직임·효과', '선택 장면에 확대·이동·밝기·먼지·안개 효과를 조절해요.', ['특수 효과', '카메라', '애니메이션', 'motion', 'fx', '밝기', '어둡게'], 'selection'],
  ['title-cards', 'visual', '제목 화면·템플릿', '영상에 넣을 제목·챕터·정보 화면의 기본 틀을 골라요.', ['카드', '템플릿', 'template', '챕터', '제목']],
  ['diagrams', 'visual', '연표·관계도·차트', '이야기를 설명할 정보 화면을 만들고 장면으로 추가해요.', ['인포그래픽', '다이어그램', '지도', '정보 화면', 'chart', 'diagram']],
  ['quality', 'review', '영상 자동 검수', '이미지·자막·음성의 문제 후보를 무료로 검사해요.', ['품질', 'quality', '빈 이미지', '검사', '검수', '자막 잘림'], 'scenes'],
  ['fidelity', 'review', '원본·대본 비교', '참고 자료에서 빠지거나 달라진 내용을 검토해요.', ['원작', '누락', '추가', '원본 충실도', '비교', 'fidelity'], 'script'],
  ['chat-edit', 'review', '채팅으로 편집', '원하는 수정을 말로 요청하고 전후 차이를 확인해 적용해요.', ['자연어', '챗', '대화', 'chat', '어둡게', '앞부분 자르기'], 'scenes'],
  ['partial-regenerate', 'review', '수정한 구간만 다시 만들기', '바뀐 장면 이미지나 필요한 음성 구간만 교체해요.', ['부분 재생성', '이미지 수정', '음성 수정', '구간 교체', '변경 구간'], 'scenes'],
  ['image-review', 'review', '대본·이미지 점검', '실제 장면 이미지를 대본·콘셉트와 비교해 검토해요.', ['이미지 검수', '일관성', '외형', '컨셉', '콘셉트', 'visual review'], 'images'],
  ['version-history', 'review', '버전 비교·복원', '이전 대본·이미지·음성을 비교하고 필요한 버전으로 돌아가요.', ['버전', '되돌리기', '복원', '히스토리', 'history', '기록']],
  ['publishing', 'delivery', '제목·설명·썸네일', '게시할 제목·내용 요약·썸네일·태그를 준비해요.', ['게시 자료', '영상 설명', '썸네일', 'thumbnail', '제목 생성', '태그']],
  ['upload-video', 'delivery', '영상 업로드·예약 공개', '편집한 영상과 게시 자료를 확인하고 공개 시각을 정해요.', ['유튜브', 'youtube', '예약 업로드', '예약 공개', 'publish', 'upload']],
  ['shorts', 'delivery', '쇼츠·드라마 만들기', '핵심 구간 쇼츠나 이야기 순서에 따른 드라마 회차를 만들어요.', ['쇼츠 제작', '분할', '시리즈 제작', 'shorts', '세로 영상'], 'scenes'],
  ['shorts-framing', 'delivery', '쇼츠 자동 구도', '세로 영상의 피사체 위치와 자막 안전 영역을 확인해요.', ['피사체', '자동 크롭', '세로 구도', '안전 영역', 'reframe'], 'images'],
  ['series', 'delivery', '시리즈 업로드·시간표', '회차별 게시 내용과 예약 시간대를 정해 순서대로 올려요.', ['예약 업로드', '예약 시간표', '매일', '일정 간격', '일괄 업로드', '시리즈', 'schedule'], 'scenes'],
  ['upload-settings', 'delivery', 'YouTube 연결 설정', '업로드할 Google 계정과 YouTube 채널을 연결해요.', ['구글', 'google', 'oauth', '채널 연결', 'youtube 연결']],
  ['project-defaults', 'project', '프로젝트 기본 설정', '화면 비율·인트로·자막·AI 이미지 안내를 설정해요.', ['설정', '가로', '세로', '안내문', '기본값', '페이드인', '인트로 효과', '밝아짐', '어둠에서 시작', 'fade in', 'settings']],
  ['channel-presets', 'project', '채널 프리셋·인트로·아웃트로', '채널 스타일과 처음·마지막 화면을 만들고 재사용해요.', ['채널명', '프리셋', '인트로', '아웃트로', '에필로그', 'outro', 'intro']],
  ['budget', 'project', '예상 비용·예산', '생성 비용의 추정치와 사용 내역을 확인하고 예산을 정해요.', ['요금', '비용', '단가', 'budget', '가격', '사용량']],
  ['project-files', 'project', '저장·열기·보관함', '프로젝트 저장·백업·불러오기와 보관함을 찾아요.', ['파일', '저장', '백업', '열기', '프로젝트 보관함', 'save', 'backup', 'library']],
  ['api-settings', 'project', 'API 연결 설정', 'OpenAI·Typecast 키와 선택적인 서버 연결을 관리해요.', ['gpt api', 'api key', 'api키', '연결', 'openai', 'typecast', '서버']],
  ['workspace-management', 'project', '작업 분야 관리', '주제별 작업 공간을 추가하고 이름·순서·보관 상태를 바꿔요.', ['분야', '워크스페이스', '탭', 'workspace', '주제 관리']],
];
export const TOOL_CATALOG = Object.freeze(entries.map(([id, categoryId, title, description, keywords, requirement]) => Object.freeze({
  id, categoryId, title, description, keywords: Object.freeze(keywords), routeId: id, ...(requirement ? {requirement} : {}),
})));

export function normalizeToolQuery(value) {
  return typeof value === 'string' ? value.slice(0, 200).normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/gu, ' ').trim() : '';
}
const compact = value => normalizeToolQuery(value).replace(/[\s·ㆍ.,:;/_-]+/gu, '');
export function getToolCategory(id) {return TOOL_CATEGORIES.find(category => category.id === id) || TOOL_CATEGORIES[0];}

/** Empty discovery shows one category; a query searches across all six groups. */
export function searchToolCatalog(query = '', categoryId = 'script') {
  const normalized = normalizeToolQuery(query), category = getToolCategory(typeof categoryId === 'object' ? categoryId?.categoryId : categoryId);
  if (!normalized) return TOOL_CATALOG.filter(tool => tool.categoryId === category.id);
  const terms = normalized.split(' ').map(compact).filter(Boolean), needle = compact(normalized);
  if (!terms.length || !needle) return [];
  return TOOL_CATALOG.map((tool, index) => {
    const title = compact(tool.title), keywords = tool.keywords.map(compact), description = compact(tool.description), haystack = [title, ...keywords, description].join(' ');
    if (!terms.every(term => haystack.includes(term))) return null;
    const score = (title === needle ? 100 : title.startsWith(needle) ? 70 : title.includes(needle) ? 45 : 0)
      + (keywords.some(keyword => keyword === needle) ? 35 : keywords.some(keyword => keyword.includes(needle)) ? 20 : 0)
      + terms.reduce((sum, term) => sum + (title.includes(term) ? 5 : keywords.some(keyword => keyword.includes(term)) ? 3 : 1), 0);
    return {tool, score, index};
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index).map(value => value.tool);
}
export const searchTools = searchToolCatalog;

/** Prerequisites are advisory navigation hints, never authorization for a request. */
export function toolAvailability(tool, project, {assets, selectedId} = {}) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [], requirement = tool?.requirement;
  let available = true, reason = '';
  if (requirement === 'scenes' && !scenes.length) {available = false;reason = '장면을 먼저 추가해 주세요.';}
  if (requirement === 'images' && !scenes.some(scene => scene.imageId && (typeof assets?.has !== 'function' || assets.has(scene.imageId)))) {available = false;reason = '장면에 이미지를 먼저 넣어 주세요.';}
  if (requirement === 'narration' && (!project?.audio?.narrationId || typeof assets?.has === 'function' && !assets.has(project.audio.narrationId))) {available = false;reason = '내레이션을 먼저 추가해 주세요.';}
  if (requirement === 'selection' && !scenes.some(scene => scene.id === selectedId)) {available = false;reason = '편집할 장면을 먼저 선택해 주세요.';}
  if (requirement === 'script' && ![project?.scriptDraft?.displayScript, project?.scriptDraft?.draftScript, ...scenes.map(scene => scene.caption)].some(value => typeof value === 'string' && value.trim())) {available = false;reason = '대본을 먼저 작성하거나 붙여 넣어 주세요.';}
  return {available, reason};
}
