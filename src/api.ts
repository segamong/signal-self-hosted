import { androidApi } from './androidBridge';
export const SERVER_ORIGIN = 'https://13.143.172.92:9443';

type DesktopEvent = {type:string;[key:string]:unknown};
type DesktopSettings = {openAtLogin:boolean;closeToTray:boolean};
export type UpdateState = {
  status:'idle'|'checking'|'available'|'current'|'downloading'|'ready'|'error';
  currentVersion:string;version?:string;progress?:number;error?:string;
};
declare global {
  interface Window {
    signalAndroidBridge?: {
      postMessage(message:string):void;
      onmessage:((event:{data:string})=>void)|null;
    };
    signalDesktop?: {
      getInfo():Promise<{version:string;serverOrigin:string;platform:string;screenAudioExcludesOwnAudio?:boolean}>;
      requestApi(path:string,body?:unknown):Promise<{status:number;data:any}>;
      subscribeEvents(callback:(event:DesktopEvent)=>void):()=>void;
      windowAction(action:'minimize'|'maximize'|'close'):void;
      getSettings():Promise<DesktopSettings>;
      setSettings(settings:Partial<DesktopSettings>):Promise<DesktopSettings>;
      show():void;
      getUpdateState():Promise<UpdateState>;
      checkUpdate():Promise<UpdateState>;
      downloadUpdate():Promise<UpdateState>;
      installUpdate():Promise<UpdateState>;
    };
  }
}

export async function api<T>(path:string,body?:unknown):Promise<T> {
  if(window.signalAndroidBridge) {
    const result = await androidApi(`/api${path}`,body);
    if(result.status===204)return undefined as T;
    if(result.status<200||result.status>=300)throw new Error(result.data?.error||'Не удалось связаться с сервером.');
    return result.data as T;
  }
  if(window.signalDesktop) {
    const result = await window.signalDesktop.requestApi(`/api${path}`,body);
    if(result.status===204)return undefined as T;
    if(result.status<200||result.status>=300)throw new Error(result.data?.error||'Не удалось связаться с сервером.');
    return result.data as T;
  }
  const response = await fetch(`/api${path}`,{credentials:'same-origin',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  if(response.status===204)return undefined as T;
  const data = await response.json().catch(()=>({error:'Сервер вернул неожиданный ответ.'}));
  if(!response.ok)throw new Error(data.error||'Не удалось выполнить запрос.');
  return data;
}

export function invitationCode(input:string):string {
  const value=input.trim();
  if(/^[A-Za-z0-9_-]{32}$/.test(value))return value;
  try {
    const url=new URL(value);
    if(url.protocol==='signal:'&&url.hostname==='invite'&&/^\/[A-Za-z0-9_-]{32}$/.test(url.pathname))return url.pathname.slice(1);
    if(url.origin===SERVER_ORIGIN&&/^[A-Za-z0-9_-]{32}$/.test(url.searchParams.get('invite')||''))return url.searchParams.get('invite')!;
  }catch{/* A plain code is also accepted. */}
  return '';
}
