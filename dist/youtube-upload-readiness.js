/** Readonly UI guidance. Actual channel, video and transfer guards remain in the upload path. */
export function getYouTubeUploadReadiness({busy = '', canMutate = true, connected = false,
  videoReady = false, videoSource = 'export', exportState = 'missing', pausedUpload = false,
  pendingThumbnail = false, receiptPending = false, playlistError = '', hashtagError = '', scheduleValid = true, scheduleError = ''} = {}) {
  const blocked = (code, title, message, action = null) => ({code, ready: false, title, message, action});
  if (busy) return blocked('busy', '현재 작업을 마쳐 주세요',
    busy === 'upload' ? '영상을 YouTube로 전송하고 있어요. 진행 상태를 확인하거나 전송을 중지한 뒤 다시 시도하세요.'
      : '진행 중인 작업이 있어요. 완료하거나 취소한 뒤 업로드할 수 있어요.');
  if (!canMutate) return blocked('editor-busy', '파일 처리·영상 출력을 기다려 주세요',
    '파일 처리나 영상 내보내기가 진행 중이에요. 작업이 끝나면 업로드 준비 상태를 다시 확인해요.');
  if (receiptPending && connected) return blocked('receipt-pending', '영상 업로드는 완료됐어요', '이 앱에 업로드 기록을 저장하지 못했어요. 영상을 새로 올리지 말고 완료된 영상 기록 저장 버튼으로 이어 처리하세요.', 'receipt');
  if (pendingThumbnail && connected) return blocked('thumbnail-pending', '영상은 이미 업로드됐어요',
    '선택한 썸네일만 아직 완료되지 않았어요. 같은 영상에 썸네일만 다시 올리거나 썸네일 없이 완료하세요.', 'thumbnail');
  if (!connected) return blocked('connection-required', '업로드할 YouTube 채널을 연결해 주세요',
    '업로드 설정에서 Google 계정과 대상 채널을 연결하세요. 연결이 만료됐다면 같은 채널로 다시 연결하세요.', 'settings');
  if (pausedUpload) return blocked('upload-paused', '중단한 전송을 먼저 확인해 주세요',
    '원래 프로젝트에서 진행 상태를 확인한 뒤 이어 올리세요. 새 업로드를 시작하면 같은 영상이 중복으로 올라갈 수 있어요.', 'resume');
  if (!videoReady) {
    if (videoSource === 'file') return blocked('file-required', '올릴 영상 파일을 선택해 주세요',
      '이미 저장한 MP4·WebM 영상 파일을 선택하세요. 채널과 썸네일 선택만으로 영상 파일이 준비되지는 않아요.', 'video');
    if (exportState === 'changed') return blocked('export-changed', '수정한 영상을 다시 만들어 주세요',
      '영상 편집 내용이 바뀌어 이전 완성 파일을 현재 영상으로 올릴 수 없어요. 현재 프로젝트를 다시 영상으로 만들거나 올릴 영상 파일을 직접 선택하세요.', 'video');
    if (exportState === 'other-project') return blocked('export-other-project', '현재 프로젝트의 완성 영상이 없어요',
      '다른 프로젝트의 완성 파일을 자동으로 사용하지 않아요. 현재 프로젝트를 MP4·WebM 영상으로 만들거나 이미 저장한 영상 파일을 선택하세요.', 'video');
    return blocked('export-required', '업로드할 완성 영상 파일이 필요해요',
      '채널과 썸네일을 준비해도 실제 MP4·WebM 영상 파일이 있어야 올릴 수 있어요. 새로고침 후에는 이미 저장한 파일을 다시 선택하거나 현재 프로젝트를 영상으로 만드세요.', 'video');
  }
  if(playlistError)return blocked('playlist-required','재생목록 설정을 확인해 주세요',String(playlistError).slice(0,500),'playlist');
  if(hashtagError)return blocked('hashtags-required','설명에 해시태그를 반영해 주세요',String(hashtagError).slice(0,500),'hashtags');
  if (!scheduleValid) return blocked('schedule-invalid', '예약 공개 시간을 확인해 주세요',
    typeof scheduleError === 'string' && scheduleError.trim()
      ? scheduleError.trim().slice(0, 500) : '예약할 날짜·시간과 시간대를 확인한 뒤 다시 업로드하세요.', 'schedule');
  return {code: 'ready', ready: true, title: '업로드할 준비가 됐어요',
    message: '영상 파일과 대상 채널이 준비됐어요. 제목·설명·썸네일·공개 상태를 확인한 뒤 업로드하세요.', action: null};
}
