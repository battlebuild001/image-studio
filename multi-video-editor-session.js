import {saveLibraryProject} from './project.js';
import {youtubeExportSourceKey} from './youtube-protocol.js';

/** Durable queue edits never overwrite the user's original category workspace.
 * Derived shorts have a new identity and are saved separately in the library. */
export function createMultiVideoEditorSession({engine,jobId,snapshot,saveDerived=saveLibraryProject}){
 let token=snapshot.token,restoring=false;
 const projectId=snapshot.project.id;
 return{
  jobId,projectId,get token(){return token;},get restoring(){return restoring;},set restoring(value){restoring=Boolean(value);},
  async save(project,assets,video){
   if(restoring)return;
   if(project.id!==projectId){await saveDerived(project,assets);return{derived:true};}
   const actualVideo=video?.blob instanceof Blob&&video.projectId===project.id&&video.sourceKey===youtubeExportSourceKey(project)?{blob:video.blob,sourceKey:video.sourceKey,extension:video.extension||video.name?.split('.').at(-1),mime:video.blob.type}:undefined;
   const result=await engine.replaceSnapshot(jobId,{project,assets,expectedToken:token,...(actualVideo?{video:actualVideo}:{})});
   token=result.token;return result;
  },
 };
}
