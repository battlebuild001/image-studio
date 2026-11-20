import {normalizeYouTubeMetadata,normalizeYouTubeUploadRecord,youtubeExportSourceKey} from './youtube-protocol.js';

/** Normal videos wait for their required thumbnail before any public release or schedule. */
export function stageMainVideoMetadata(input){const metadata=normalizeYouTubeMetadata(input);delete metadata.publishAt;return{...metadata,privacyStatus:'private'};}
export function mainVideoReceipt(record,metadata,sourceKey){const plan=normalizeYouTubeMetadata(metadata);return normalizeYouTubeUploadRecord({...record,thumbnailStatus:'pending',publicationStatus:'pending',intendedPrivacyStatus:plan.privacyStatus,sourceKey,...(plan.publishAt?{publishAt:plan.publishAt,scheduleTimeZone:plan.scheduleTimeZone||'Asia/Seoul',scheduleConfirmed:false}:{})});}
export function mainVideoPublication(record){return{privacyStatus:record.intendedPrivacyStatus,...(record.publishAt?{publishAt:record.publishAt,scheduleTimeZone:record.scheduleTimeZone||'Asia/Seoul'}:{})};}
export function hasCompletedMainUpload(project){return Boolean(project?.production?.youtube?.uploads?.some(record=>record.thumbnailStatus==='uploaded'&&record.publicationStatus==='completed'&&record.sourceKey===youtubeExportSourceKey(project)));}
