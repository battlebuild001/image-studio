// Shared browser/Node diagnostics. Provider prose, prompts, credentials and URLs
// are never returned, logged, persisted or interpolated into an error message.
export const OPENAI_ERROR_BODY_LIMIT = 16 * 1024;
const CODE = new Set(['model_not_found','invalid_model','model_not_available','model_access_denied','unsupported_model','invalid_request_error','invalid_value','unsupported_value','invalid_parameter','unknown_parameter','unsupported_parameter','invalid_image','invalid_image_format','invalid_image_url','invalid_image_size','image_too_large','unsupported_image','unsupported_image_format','content_policy_violation','moderation_blocked','safety_violation','invalid_prompt','image_generation_user_error','organization_verification_required','organization_not_verified','verification_required','organization_restricted','org_not_verified','organization_verification','insufficient_quota','billing_hard_limit_reached','billing_not_active','rate_limit_exceeded','requests_limit_exceeded','tokens_limit_exceeded','invalid_api_key','account_deactivated','permission_denied','access_denied','server_error','internal_error','service_unavailable','invalid_size','invalid_quality']);
const TYPE = new Set(['invalid_request_error','insufficient_quota','rate_limit_error','server_error','authentication_error','permission_error']);
const PARAMETER = new Set(['model','size','quality','image','image[]','input_fidelity','output_format','prompt','n','background','response_format','moderation','mask']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abortError = () => new DOMException('요청을 취소했어요.', 'AbortError');
const hasSecret = (value, secrets) => /sk-/iu.test(value) || secrets.some(secret => typeof secret === 'string' && secret.length > 0 && value.includes(secret));
function parameter(value) {return PARAMETER.has(value) ? value : typeof value === 'string' && /^image\[\d{1,2}\]$/u.test(value) ? 'image[]' : undefined;}

/** Validate even backend-supplied diagnostic objects before showing their fields. */
export function sanitizeOpenAiDiagnostic(input, {secrets = []} = {}) {
  if (!plain(input) || input.provider !== 'openai' || !Number.isInteger(input.providerStatus) || input.providerStatus < 400 || input.providerStatus > 599) return null;
  const result = {provider:'openai',providerStatus:input.providerStatus};
  if (CODE.has(input.providerCode)) result.providerCode = input.providerCode;
  const field = parameter(input.parameter);if (field) result.parameter = field;
  if (typeof input.requestId === 'string' && /^req_[A-Za-z0-9_-]{1,128}$/u.test(input.requestId) && !hasSecret(input.requestId,secrets)) result.requestId = input.requestId;
  if (typeof input.model === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/u.test(input.model) && !hasSecret(input.model,secrets)) result.model = input.model;
  if (typeof input.size === 'string' && /^(?:auto|\d{2,5}x\d{2,5})$/u.test(input.size) && !hasSecret(input.size,secrets)) result.size = input.size;
  if (Number.isInteger(input.referenceCount) && input.referenceCount >= 0 && input.referenceCount <= 5) result.referenceCount = input.referenceCount;
  return result;
}

/** Only fixed known tokens determine actionable messages; unknown values vanish. */
export function classifyOpenAiProviderError({status,error,requestId,context,secrets = []} = {}) {
  const details = plain(error) ? error : {},code = CODE.has(details.code) ? details.code : undefined,type = TYPE.has(details.type) ? details.type : undefined,param = parameter(details.param);
  const diagnostic = sanitizeOpenAiDiagnostic({provider:'openai',providerStatus:status,providerCode:code,parameter:param,requestId,
    model:context?.model,size:context?.size,referenceCount:context?.referenceCount},{secrets});
  let reason,message;
  if (status === 401 || ['invalid_api_key','account_deactivated'].includes(code)) {
    reason='AUTH_FAILED';message='OpenAI API 키가 올바르지 않거나 만료됐어요. 설정에서 키를 확인해 주세요.';
  } else if (['insufficient_quota','billing_hard_limit_reached','billing_not_active'].includes(code) || type === 'insufficient_quota') {
    reason='INSUFFICIENT_QUOTA';message='OpenAI API 잔액이나 결제 한도에 도달했어요. OpenAI 계정의 결제·사용 한도를 확인해 주세요. 자동 재시도는 하지 않았어요.';
  } else if (['organization_verification_required','organization_not_verified','verification_required','organization_restricted','org_not_verified','organization_verification'].includes(code) ||
      // Some official organization-verification responses contain a null code.
      // Recognize a fixed phrase, but never copy provider prose into diagnostics.
      (typeof details.message === 'string' && details.message.length <= OPENAI_ERROR_BODY_LIMIT && /(?:organization must be verified|verify your organization|organization verification is required)/iu.test(details.message))) {
    reason='ORGANIZATION_VERIFICATION_REQUIRED';message='이 이미지 모델은 OpenAI 조직 인증이 필요해요. OpenAI의 조직 설정에서 인증 상태와 모델 사용 권한을 확인해 주세요.';
  } else if (['content_policy_violation','moderation_blocked','safety_violation'].includes(code)) {
    reason='CONTENT_POLICY';message='OpenAI가 요청 내용이나 참고 이미지를 안전 정책에 따라 거절했어요. 해당 장면의 요청과 참고 이미지를 확인해 주세요.';
  } else if (['model_not_found','invalid_model','model_not_available','unsupported_model'].includes(code) || status === 404 && param === 'model') {
    reason='MODEL_NOT_FOUND';message='설정한 OpenAI 모델을 찾지 못했거나 이 API 키로 사용할 수 없어요. API 설정의 모델 이름과 해당 프로젝트의 모델 권한을 확인해 주세요.';
  } else if (code === 'model_access_denied' || status === 403 && param === 'model') {
    reason='MODEL_ACCESS_DENIED';message='이 OpenAI 모델의 사용 권한이 없어요. API 키가 속한 프로젝트와 모델 사용 권한을 확인해 주세요.';
  } else if (param === 'size' || code === 'invalid_size') {
    reason='IMAGE_SIZE_UNSUPPORTED';message='OpenAI가 선택한 이미지 크기를 지원하지 않아요. 이미지 모델과 가로·세로 크기 설정을 확인해 주세요.';
  } else if (param === 'quality' || code === 'invalid_quality') {
    reason='IMAGE_QUALITY_UNSUPPORTED';message='OpenAI가 선택한 이미지 품질 설정을 지원하지 않아요. 이미지 모델과 출력 품질 설정을 확인해 주세요.';
  } else if (['invalid_image','invalid_image_format','invalid_image_url','invalid_image_size','image_too_large','unsupported_image','unsupported_image_format'].includes(code) || ['image','image[]','mask'].includes(param)) {
    reason='IMAGE_REFERENCE_INVALID';message='OpenAI가 참고 이미지의 형식·크기 또는 내용을 처리하지 못했어요. 참고 이미지를 PNG·JPG·WebP로 다시 저장하거나 선택을 확인해 주세요.';
  } else if (code === 'invalid_prompt' || param && ['input_fidelity','output_format','response_format','background','moderation','n','prompt'].includes(param)) {
    reason='REQUEST_INVALID';message='OpenAI가 이미지 요청의 입력 또는 출력 설정을 받지 못했어요. 장면 요청과 이미지 모델의 지원 설정을 확인해 주세요.';
  } else if (status === 403) {
    reason='ACCESS_DENIED';message='OpenAI 키의 모델 사용 권한을 확인해 주세요.';
  } else if (status === 429 || ['rate_limit_exceeded','requests_limit_exceeded','tokens_limit_exceeded'].includes(code) || type === 'rate_limit_error') {
    reason='RATE_LIMITED';message='OpenAI 사용 한도·잔액 또는 요청 한도를 확인해 주세요. 자동 재시도는 하지 않았어요.';
  } else if ([400,404,422].includes(status)) {
    reason='CONFIGURATION_ERROR';message='OpenAI 모델이나 요청 설정을 사용할 수 없어요. 설정의 모델과 입력 자료를 확인해 주세요.';
  } else {
    reason='UNAVAILABLE';message='OpenAI 서비스가 응답하지 않아요. 기존 자료와 결과는 유지돼요.';
  }
  return {reason,message,...(diagnostic ? {diagnostic} : {})};
}

function header(response, name) {
  try {const value=typeof response.headers?.get === 'function' ? response.headers.get(name) : response.headers?.[name];return typeof value === 'string' ? value : null;} catch {return null;}
}
function discard(response) {
  try {const pending=response.body?.cancel?.();pending?.catch?.(()=>{});} catch {}
  try {response.destroy?.();} catch {}
}

/** Read at most 16 KiB from fetch or Node streams. A stalled error body cannot
 * hold a paid-generation slot indefinitely, and caller cancellation still wins. */
export async function readOpenAiProviderError(response, {signal,timeoutMs = 2000,maxBytes = OPENAI_ERROR_BODY_LIMIT,context,secrets = []} = {}) {
  const status=response?.status ?? response?.statusCode,requestId=header(response,'x-request-id');let details=null;
  const finish=()=>classifyOpenAiProviderError({status,error:details,requestId,context,secrets});
  if (signal?.aborted) {discard(response);throw abortError();}
  maxBytes=Math.min(OPENAI_ERROR_BODY_LIMIT,Number.isSafeInteger(maxBytes)&&maxBytes>0 ? maxBytes : OPENAI_ERROR_BODY_LIMIT);
  timeoutMs=Number.isFinite(timeoutMs)&&timeoutMs>0 ? Math.min(timeoutMs,2000) : 2000;
  const length=header(response,'content-length');if(length && (/^\d+$/u.test(length) ? Number(length)>maxBytes : true)){discard(response);return finish();}
  let reader,iterator,timer,rejectAbort;
  try {
    if (typeof response?.body?.getReader === 'function') reader=response.body.getReader();
    else if (typeof response?.[Symbol.asyncIterator] === 'function') iterator=response[Symbol.asyncIterator]();
    else {discard(response);return finish();}
    const stop=new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('bounded error body deadline')),timeoutMs);
      rejectAbort=()=>reject(abortError());signal?.addEventListener('abort',rejectAbort,{once:true});
      if(signal?.aborted)rejectAbort();
    });
    const chunks=[];let total=0;
    for (;;) {
      const part=await Promise.race([reader ? reader.read() : iterator.next(),stop]);if (part.done) break;
      const bytes=part.value instanceof Uint8Array ? part.value : typeof part.value==='string' ? new TextEncoder().encode(part.value) : null;
      if (!bytes) throw new Error('Invalid error stream');total+=bytes.byteLength;if(total>maxBytes) throw new Error('Oversized error stream');chunks.push(bytes);
    }
    if(signal?.aborted)throw abortError();
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const value=JSON.parse(new TextDecoder().decode(bytes));details=plain(value)&&plain(value.error) ? value.error : null;
  } catch (cause) {
    if(signal?.aborted || cause?.name==='AbortError')throw abortError();
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',rejectAbort);
    try {const pending=reader?.cancel();pending?.catch?.(()=>{});} catch {}
    try {reader?.releaseLock();} catch {}
    try {const pending=iterator?.return?.();pending?.catch?.(()=>{});} catch {}
    discard(response);
  }
  return finish();
}
