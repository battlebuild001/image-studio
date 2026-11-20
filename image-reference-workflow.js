import {apiFetch} from './api-client.js';
import {mediaSearchClient} from './media-search-client.js';
import {mediaAttributionText, normalizeReferenceMediaState, normalizeMediaCandidate, MAX_REFERENCE_MEDIA_BYTES} from './media-search-protocol.js';
import {validateTopicResearchRequest, normalizeTopicResearchResult} from './topic-research-protocol.js';
import {createOperationStatus, nextPaint} from './operation-status.js';

const node = (tag, className = '', text) => {const item = document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;};
const button = (id, text, className = 'outline') => {const item=node('button',className,text);item.id=id;item.type='button';return item;};
const clip = (text, limit) => Array.from(String(text || '')).slice(0,limit).join('');
const abortError = () => new DOMException('자료 찾기를 취소했어요.','AbortError');

/** Research has a smaller contract than the script editor. Label excerpts honestly. */
export function imageReferenceResearchInput(script, projectTitle = '') {
  const text=String(script || '').trim();if(!text)throw new Error('먼저 1단계에서 대본을 입력해 주세요.');
  const chars=Array.from(text),excerpted=chars.length>1500;
  const excerpt=excerpted?`${chars.slice(0,500).join('')}\n[중간 발췌]\n${chars.slice(Math.max(0,Math.floor(chars.length/2)-250),Math.floor(chars.length/2)+250).join('')}\n[마지막 발췌]\n${chars.slice(-500).join('')}`:text;
  const instructions=[
    '이 대본의 이미지 제작을 위한 실제 자료를 웹에서 조사하세요. 게임·세계관·판본을 구별하고 주요 인물·미니어처·전장·장비의 외형과 실제 게임 화면 구성을 우선하세요.',
    'searchTerms에는 Wikimedia Commons에서 실제 참조 사진을 찾기 좋은 구체적인 영문 검색어를 중요도 순으로 넣으세요. 실제로 확인한 출처만 사용하고 다른 게임이나 현실 사건으로 대체하지 마세요.',
    excerpted?'[대본 앞·중간·마지막 발췌 · 전체 대본이 아님]':'[전체 대본]',excerpt,
  ].join('\n');
  return {request:validateTopicResearchRequest({topic:clip([projectTitle,text].filter(Boolean).join('\n'),500),instructions,projectTitle:clip(projectTitle,200)}),excerpted};
}

export function randomReferenceIndex(length, previous = -1, random = Math.random) {
  if(!Number.isInteger(length)||length<1)return -1;
  if(length===1)return 0;
  const value=Math.max(0,Math.min(.999999999999,Number(random())||0));
  const index=Math.floor(value*(previous>=0&&previous<length?length-1:length));
  return previous>=0&&previous<length&&index>=previous?index+1:index;
}

/** One visible reference, explicit research/import only, and existing durable media. */
export function setupImageReferenceWorkflow(api, {container, isBlocked = () => false, onChange = () => {}, client = mediaSearchClient, fetchImpl = apiFetch} = {}) {
  if(!container?.append)throw new TypeError('레퍼런스 표시 영역이 필요해요.');
  if(!document.getElementById('imageReferenceWorkflowStyles')){const style=node('link');style.id='imageReferenceWorkflowStyles';style.rel='stylesheet';style.href=new URL('./image-reference-workflow.css',import.meta.url).href;document.head.append(style);}
  const section=node('section','image-reference-workflow');section.id='imageReferenceWorkflow';section.setAttribute('aria-labelledby','imageReferenceWorkflowTitle');
  const title=node('h3','','1. 이미지 기준 정하기');title.id='imageReferenceWorkflowTitle';
  const help=node('p','image-reference-help','대본에 맞는 자료를 찾거나 직접 이미지 한 장을 넣으세요. 선택한 이미지를 모든 장면의 생성 기준으로 사용해요.');
  const actions=node('div','image-reference-actions'),search=button('findScriptImageReferenceBtn','대본으로 자료 찾기','primary'),upload=button('uploadImageReferenceBtn','레퍼런스 이미지 넣기'),cancel=button('cancelImageReferenceSearchBtn','취소','ghost');cancel.hidden=true;actions.append(search,upload,cancel);
  const file=node('input');file.id='imageReferenceFile';file.type='file';file.accept='image/png,image/jpeg,image/webp';file.hidden=true;
  const cost=node('p','image-reference-help','자료 찾기는 웹 검색 AI를 1회 요청하며 요금이 발생할 수 있어요. ‘다른 이미지’는 찾은 결과에서만 바꿔 보여줘요. 이미지 생성은 아래에서 따로 시작해요.');
  const card=node('article','image-reference-preview');card.id='imageReferencePreview';card.hidden=true;
  const image=node('img');image.id='imageReferencePreviewImage';image.alt='선택할 레퍼런스';image.referrerPolicy='no-referrer';
  const content=node('div','image-reference-preview-content'),name=node('strong'),meta=node('p','image-reference-credit'),links=node('div','image-reference-links'),previewNote=node('p','image-reference-help');
  const choiceActions=node('div','image-reference-actions'),other=button('nextImageReferenceBtn','다른 이미지'),apply=button('useImageReferenceBtn','이 이미지 사용하기','primary');choiceActions.append(other,apply);content.append(name,meta,links,previewNote,choiceActions);card.append(image,content);
  const currentNote=node('p','image-reference-current');currentNote.id='imageReferenceCurrent';
  const research=node('details','image-reference-research');research.hidden=true;research.append(node('summary','','AI가 찾은 자료와 출처'));const researchBody=node('div');research.append(researchBody);
  const error=node('p','image-reference-error');error.id='imageReferenceError';error.setAttribute('role','alert');
  const status=node('p','image-reference-status');status.id='imageReferenceStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  section.append(title,help,actions,file,cost,card,currentNote,research,status,error);container.append(section);
  const operation=createOperationStatus({container:section,region:card,id:'imageReferenceOperation'});card.before(operation.element);
  let owner='',source='',busy='',controller=null,sequence=0,pool=[],picked=-1,staged=null,objectUrl='',previewBlob=null,previewKey='',saving=false,applying=false,researchResult=null;
  const scope=()=>`${api.getWorkspaceId?.()||''}\0${api.getProject().id}`;
  const script=()=>String(api.getDisplayScript?.()||api.getProject().scriptDraft?.displayScript||api.getProject().scriptDraft?.draftScript||api.getProject().scenePlan?.sourceScript||'').trim();
  const sourceKey=()=>JSON.stringify([scope(),api.getProject().title,script()]);
  const state=()=>normalizeReferenceMediaState(api.getProject().production?.referenceMedia||{});
  const references=()=>api.getProject().imageStudio?.references?.filter(item=>item.enabled!==false&&api.getAssets().get(item.assetId)?.blob)||[];
  const available=()=>!isBlocked()&&(!api.canUseSceneImages||api.canUseSceneImages());
  const link=(label,href)=>{const item=node('a','',label);item.href=href;item.target='_blank';item.rel='noopener noreferrer';return item;};
  function clearPreviewUrl(){if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl='';previewBlob=null;}
  function setBlobPreview(blob){if(previewBlob!==blob){clearPreviewUrl();previewBlob=blob;objectUrl=URL.createObjectURL(blob);}return objectUrl;}
  function refresh(){const blocked=Boolean(busy)||!available();search.disabled=blocked||!script();upload.disabled=blocked;other.disabled=blocked||pool.length<2;other.hidden=!pool.length||Boolean(staged);apply.disabled=blocked||(!staged&&!pool[picked])||typeof api.replaceImageReference!=='function';apply.hidden=!staged&&!pool[picked];cancel.hidden=!busy;section.setAttribute('aria-busy',String(Boolean(busy)));}
  function draw(){
    const refs=references(),current=refs[0],candidate=staged?null:pool[picked],asset=current?api.getAssets().get(current.assetId):null;
    currentNote.textContent=current?`현재 생성 기준: ${current.label||asset?.name||'저장된 레퍼런스'}${refs.length>1?` · 고급 설정의 추가 참조 ${refs.length-1}장도 유지 중`:''}`:'아직 선택한 레퍼런스가 없어요. 직접 넣거나 대본으로 자료를 찾아보세요.';
    const key=staged?staged:candidate?candidate:asset?.blob||null;
    if(previewKey!==key){previewKey=key;image.hidden=false;previewNote.textContent='';links.replaceChildren();card.hidden=!key;
      if(staged){image.src=setBlobPreview(staged);image.alt=staged.name;name.textContent=staged.name;meta.textContent='직접 넣은 이미지 · 사용 권한을 확인해 주세요.';}
      else if(candidate){clearPreviewUrl();image.src=candidate.previewUrl||candidate.mediaUrl;image.alt=candidate.title;name.textContent=candidate.title;meta.textContent=[candidate.artist?`저작자: ${candidate.artist}`:'저작자 정보는 출처에서 확인',candidate.license?`Commons 표기: ${candidate.license}`:'이용 조건은 출처에서 확인'].join(' · ');links.append(link('원본·출처',candidate.sourceUrl));if(candidate.licenseUrl)links.append(link('이용 조건',candidate.licenseUrl));previewNote.textContent='찾은 자료 중 무작위로 고른 이미지예요. 대본과의 관련성·이용 조건을 확인하고 선택하세요.';}
      else if(asset?.blob){image.src=setBlobPreview(asset.blob);image.alt=current.label||asset.name||'저장된 레퍼런스';name.textContent=current.label||asset.name||'저장된 레퍼런스';meta.textContent='프로젝트에 저장된 레퍼런스 · 바로 재사용할 수 있어요.';const saved=state(),matches=item=>item.title.slice(0,120)===current.label||item.title===asset.name;const imported=saved.imports.find(item=>saved.selectedIds.includes(item.id)&&matches(item))||[...saved.imports].reverse().find(matches);if(imported){meta.textContent=mediaAttributionText(imported).split('\n').slice(1,3).join(' · ');links.append(link('원본·출처',imported.sourceUrl));}}
      else{image.removeAttribute('src');clearPreviewUrl();}
    }
    refresh();
  }
  function stop(message='자료 찾기를 취소했어요. 기존 레퍼런스는 유지돼요.') {sequence++;controller?.abort();controller=null;if(busy)operation.cancel(message);busy='';status.textContent=message;refresh();onChange();}
  function render(){const nextOwner=scope(),nextSource=sourceKey();if(nextOwner!==owner){owner=nextOwner;source=nextSource;stop('');pool=[];picked=-1;staged=null;researchResult=null;research.hidden=true;researchBody.replaceChildren();error.textContent='';operation.clear();previewKey='';clearPreviewUrl();}
    else if(source!==nextSource&&!saving){source=nextSource;if(busy&&!applying)stop('대본이 바뀌어 자료 찾기를 중지했어요. 현재 레퍼런스는 유지돼요.');pool=[];picked=-1;staged=null;researchResult=null;research.hidden=true;status.textContent='대본이 바뀌었어요. 필요하면 자료를 다시 찾아보세요.';}
    draw();}
  function rememberResults(query,results){saving=true;try{(api.mutateProductionMetadata||api.mutate)(project=>{project.production||={version:1};const current=normalizeReferenceMediaState(project.production.referenceMedia||{});current.query=query;current.results=results;current.selectedIds=[];current.searchedAt=new Date().toISOString();project.production.referenceMedia=normalizeReferenceMediaState(current);});}finally{saving=false;}}
  function assertCurrent(seq,key,signal){if(sequence!==seq||sourceKey()!==key||signal.aborted||!available())throw abortError();}
  async function find(){if(busy||!available())return;error.textContent='';const input=imageReferenceResearchInput(script(),api.getProject().title),key=sourceKey(),seq=++sequence,abort=new AbortController();controller=abort;busy='research';status.textContent=input.excerpted?'긴 대본의 앞·중간·마지막 발췌를 기준으로 자료를 조사해요.':'전체 대본을 기준으로 자료를 조사해요.';
    const job=operation.start('대본에 맞는 실제 자료를 조사하고 있어요.',{detail:'웹 검색 AI 1회 요청 후 실제 Wikimedia Commons 이미지 파일을 찾아요.'});refresh();onChange();const timeout=setTimeout(()=>abort.abort(),190000);
    try{await nextPaint();assertCurrent(seq,key,abort.signal);const response=await fetchImpl('/api/research/collect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input.request),signal:abort.signal});let raw;try{raw=await response.json();}catch{throw new Error('자료 조사 응답을 읽지 못했어요. 기존 레퍼런스는 유지돼요.');}if(!response.ok)throw new Error(typeof raw.error==='string'?clip(raw.error,500):'자료 조사 API 연결과 설정을 확인해 주세요.');assertCurrent(seq,key,abort.signal);const result=normalizeTopicResearchResult(raw);if(result.topic!==input.request.topic)throw new Error('조사한 주제가 요청과 달라 적용하지 않았어요.');
      const terms=[...new Set(result.searchTerms.map(value=>value.trim()).filter(Boolean))].slice(0,3);if(!terms.length)throw new Error('사용할 이미지 검색어를 받지 못했어요. 직접 레퍼런스를 넣거나 다시 자료를 찾아 주세요.');
      let found=[],used='';for(const term of terms){job.update(`실제 이미지 자료 찾는 중 · ${term}`);found=await client.search(term,{kind:'image',signal:abort.signal});assertCurrent(seq,key,abort.signal);used=term;if(found.length)break;}
      const validated=found.map(item=>normalizeMediaCandidate(item,'image'));pool=validated;picked=randomReferenceIndex(pool.length);staged=null;researchResult=result;researchBody.replaceChildren(node('p','image-reference-help',result.summary),...result.sources.map(item=>{const p=node('p');p.append(link(item.title,item.url));return p;}));research.hidden=false;draw();rememberResults(used,validated);await api.persist?.();assertCurrent(seq,key,abort.signal);
      status.textContent=pool.length?`실제 이미지 ${pool.length}개를 찾았어요. 한 장을 고르거나 ‘다른 이미지’로 바꿔 보세요.`:'해당 주제의 실제 이미지 자료가 없어요. 직접 레퍼런스를 넣거나 기존 이미지로 진행할 수 있어요.';job.finish(pool.length?'자료 조사와 이미지 검색을 마쳤어요.':'자료 조사는 완료했지만 사용할 이미지 검색 결과가 없어요.');
    }catch(cause){if(seq!==sequence)return;if(cause.name==='AbortError'||abort.signal.aborted){job.cancel('자료 찾기를 취소했어요. 기존 레퍼런스는 유지돼요.');status.textContent='자료 찾기가 중단됐어요. 자동으로 재시도하지 않았어요.';}else{error.textContent=cause.message;job.fail(cause.message);}}finally{clearTimeout(timeout);if(seq===sequence){busy='';controller=null;draw();onChange();}}
  }
  async function selectFile(input){if(!input||busy||!available())return;error.textContent='';if(!['image/png','image/jpeg','image/webp'].includes(input.type)||input.size<=0||input.size>MAX_REFERENCE_MEDIA_BYTES){error.textContent='PNG·JPG·WebP 이미지를 10MB 이하로 넣어 주세요.';return;}const seq=++sequence,key=sourceKey();busy='decode';refresh();onChange();try{const bitmap=await createImageBitmap(input);bitmap.close();if(seq!==sequence||sourceKey()!==key)return;staged=input;picked=-1;status.textContent='이미지를 확인하고 ‘이 이미지 사용하기’를 누르세요. 현재 레퍼런스는 적용 전까지 유지돼요.';}catch{if(seq===sequence)error.textContent='이미지를 읽지 못했어요. 정상적인 PNG·JPG·WebP 파일을 넣어 주세요.';}finally{if(seq===sequence){busy='';draw();onChange();}}}
  async function use(){if(busy||!available()||typeof api.replaceImageReference!=='function')return;const candidate=staged?null:pool[picked],local=staged;if(!candidate&&!local)return;const key=sourceKey(),seq=++sequence,abort=new AbortController();controller=abort;busy='apply';error.textContent='';const job=operation.start('선택한 레퍼런스 파일을 준비하고 있어요.');refresh();onChange();try{const selected=local||await client.download(candidate,{signal:abort.signal});assertCurrent(seq,key,abort.signal);job.update('레퍼런스를 저장하고 있어요.');applying=true;let result;try{result=await api.replaceImageReference(selected,{candidate:candidate||undefined,research:researchResult||undefined,signal:abort.signal,guard:()=>sequence===seq&&sourceKey()===key&&!abort.signal.aborted});}finally{applying=false;}if(result===false)throw new Error('레퍼런스를 적용하지 못했어요. 기존 이미지는 유지돼요.');if(seq!==sequence||sourceKey()!==key)return;pool=[];picked=-1;staged=null;previewKey='';status.textContent='레퍼런스를 프로젝트에 저장했어요. 아래에서 이미지 구성을 만들고 생성 장수를 확인하세요.';job.finish('선택한 이미지가 모든 장면의 생성 기준으로 저장됐어요.');}
    catch(cause){if(seq!==sequence)return;if(cause.name==='AbortError'||abort.signal.aborted)job.cancel('레퍼런스 가져오기를 취소했어요.');else{error.textContent=cause.message;job.fail(cause.message);}}finally{applying=false;if(seq===sequence){busy='';controller=null;draw();onChange();}}}
  image.addEventListener('error',()=>{image.hidden=true;previewNote.textContent='미리보기를 읽지 못했어요. 출처에서 확인하거나 다른 이미지를 선택해 주세요.';});
  search.addEventListener('click',()=>{find().catch(cause=>{error.textContent=cause.message;});});upload.addEventListener('click',()=>file.click());file.addEventListener('change',()=>{const selected=file.files?.[0];file.value='';selectFile(selected);});cancel.addEventListener('click',()=>stop());other.addEventListener('click',()=>{if(busy)return;staged=null;picked=randomReferenceIndex(pool.length,picked);draw();});apply.addEventListener('click',use);
  const settingsChanged=()=>{if(busy)stop('API 설정이 바뀌어 자료 찾기를 중지했어요. 현재 레퍼런스는 유지돼요.');};window.addEventListener('studio-api-settings-change',settingsChanged);
  render();return{element:section,render,isBusy:()=>Boolean(busy),cancel:stop,reset(){stop('');owner='';render();},dispose(){stop('');clearPreviewUrl();operation.dispose();section.remove();window.removeEventListener('studio-api-settings-change',settingsChanged);}};
}
