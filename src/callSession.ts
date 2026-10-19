export type CallPreferences={microphone:boolean;camera:boolean;deafened:boolean};
type SavedCall={userId:string;channelId:string;preferences:CallPreferences;updatedAt:number};
const KEY='signal.active-call.v1';
export const DEFAULT_CALL_PREFERENCES:CallPreferences={microphone:false,camera:false,deafened:false};
export function saveCallSession(userId:string,channelId:string,preferences:CallPreferences){
  try{sessionStorage.setItem(KEY,JSON.stringify({userId,channelId,preferences,updatedAt:Date.now()}));}catch{/* Storage may be disabled by the browser. */}
}
export function readCallSession(userId:string):SavedCall|null{
  try{
    const value=JSON.parse(sessionStorage.getItem(KEY)||'null');
    if(!value||value.userId!==userId||typeof value.channelId!=='string'||value.channelId.length>100||typeof value.updatedAt!=='number'||Date.now()-value.updatedAt>12*60*60*1000)return null;
    return {userId,channelId:value.channelId,updatedAt:value.updatedAt,preferences:{microphone:value.preferences?.microphone===true,camera:value.preferences?.camera===true,deafened:value.preferences?.deafened===true}};
  }catch{return null;}
}
export function clearCallSession(){try{sessionStorage.removeItem(KEY);}catch{}}
