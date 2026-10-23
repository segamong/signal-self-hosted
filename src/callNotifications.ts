import {createElement as h,useEffect,useId,useRef,useState} from 'react';
import {getCustomCallAudio,importCustomCallAudio,deleteCustomCallAudio,supportsCustomCallAudio,type CustomCallAudio} from './customCallAudio';
import './call-notifications.css';

export type CallDirection='incoming'|'outgoing';
export type CallMelodyId='signal'|'chime'|'bloom'|'pulse'|'line'|'morning'|'aurora'|'orbit'|'arcade'|'harbor'|'starlight'|'cascade'|'sunrise'|'custom';
export type NotificationCall={id:string;status:string;caller:{id:string;username:string};recipient:{id:string;username?:string};expiresAt:string};
export type CallNotificationPreferences={sound:boolean;incomingSound:boolean;outgoingSound:boolean;incomingMelody:CallMelodyId;outgoingMelody:CallMelodyId;volume:number;notifications:boolean};
export type CallSoundPreviewState={playing:boolean;pending:boolean;direction:CallDirection|null;melody:CallMelodyId|null};
type Permission=NotificationPermission|'unsupported';
type PendingCall={id:string;username:string;expiresAt:number;userId:string;direction:CallDirection};
type Note={at:number;duration:number;frequencies:readonly number[]};
type Melody={id:Exclude<CallMelodyId,'custom'>;label:string;description:string;duration:number;timbre?:'soft'|'bell'|'chip';notes:readonly Note[]};
export const CALL_MELODIES:readonly Melody[]=[
  {id:'signal',label:'Сигнал',description:'Короткий двойной звонок',duration:2.5,notes:[{at:0,duration:.22,frequencies:[440,660]},{at:.34,duration:.22,frequencies:[440,660]}]},
  {id:'chime',label:'Перезвон',description:'Три лёгкие ноты',duration:3.2,notes:[{at:0,duration:.24,frequencies:[659.25]},{at:.24,duration:.25,frequencies:[783.99]},{at:.50,duration:.36,frequencies:[987.77]}]},
  {id:'bloom',label:'Мягкий',description:'Плавная восходящая мелодия',duration:3.5,notes:[{at:0,duration:.30,frequencies:[523.25,659.25]},{at:.34,duration:.30,frequencies:[659.25,783.99]},{at:.68,duration:.42,frequencies:[783.99,1046.5]}]},
  {id:'pulse',label:'Пульс',description:'Три спокойных коротких сигнала',duration:2.9,notes:[{at:0,duration:.19,frequencies:[480,620]},{at:.30,duration:.19,frequencies:[480,620]},{at:.60,duration:.19,frequencies:[480,620]}]},
  {id:'line',label:'Линия',description:'Классическое ожидание ответа',duration:3.6,notes:[{at:0,duration:.85,frequencies:[440,480]},{at:1.05,duration:.85,frequencies:[440,480]}]},
  {id:'morning',label:'Утро',description:'Светлый колокольный мотив',duration:4,timbre:'bell',notes:[{at:0,duration:.26,frequencies:[523.25]},{at:.21,duration:.26,frequencies:[659.25]},{at:.42,duration:.30,frequencies:[783.99]},{at:.72,duration:.42,frequencies:[1046.5]},{at:1.08,duration:.38,frequencies:[783.99]}]},
  {id:'aurora',label:'Северное сияние',description:'Мягкие переливы аккордов',duration:4.5,timbre:'soft',notes:[{at:0,duration:.38,frequencies:[587.33,739.99]},{at:.39,duration:.42,frequencies:[880,1108.73]},{at:.83,duration:.38,frequencies:[739.99,880]},{at:1.25,duration:.48,frequencies:[659.25,783.99]}]},
  {id:'orbit',label:'Орбита',description:'Спокойный круговой мотив',duration:3.9,timbre:'soft',notes:[{at:0,duration:.28,frequencies:[261.63,392]},{at:.29,duration:.24,frequencies:[523.25]},{at:.56,duration:.24,frequencies:[392]},{at:.84,duration:.28,frequencies:[587.33]},{at:1.16,duration:.38,frequencies:[392,523.25]}]},
  {id:'arcade',label:'Аркада',description:'Короткая игровая мелодия',duration:3.5,timbre:'chip',notes:[{at:0,duration:.12,frequencies:[523.25]},{at:.15,duration:.12,frequencies:[659.25]},{at:.30,duration:.12,frequencies:[783.99]},{at:.45,duration:.19,frequencies:[1046.5]},{at:.71,duration:.12,frequencies:[783.99]},{at:.88,duration:.24,frequencies:[1046.5]}]},
  {id:'harbor',label:'Тихая гавань',description:'Тёплая неспешная мелодия',duration:4.7,timbre:'soft',notes:[{at:0,duration:.43,frequencies:[440,523.25]},{at:.47,duration:.38,frequencies:[659.25]},{at:.91,duration:.38,frequencies:[587.33]},{at:1.35,duration:.50,frequencies:[440,523.25]}]},
  {id:'starlight',label:'Звёздный свет',description:'Звонкие высокие ноты',duration:4.2,timbre:'bell',notes:[{at:0,duration:.32,frequencies:[783.99]},{at:.26,duration:.32,frequencies:[987.77]},{at:.54,duration:.40,frequencies:[1174.66]},{at:.91,duration:.32,frequencies:[987.77]},{at:1.23,duration:.43,frequencies:[783.99]}]},
  {id:'cascade',label:'Каскад',description:'Нисходящий перелив',duration:4.2,timbre:'bell',notes:[{at:0,duration:.26,frequencies:[1046.5]},{at:.21,duration:.26,frequencies:[987.77]},{at:.42,duration:.26,frequencies:[783.99]},{at:.63,duration:.26,frequencies:[659.25]},{at:.84,duration:.31,frequencies:[523.25]},{at:1.19,duration:.43,frequencies:[659.25,783.99]}]},
  {id:'sunrise',label:'Рассвет',description:'Плавный подъём от низких нот',duration:4.8,timbre:'soft',notes:[{at:0,duration:.40,frequencies:[261.63,329.63]},{at:.44,duration:.30,frequencies:[392]},{at:.79,duration:.39,frequencies:[523.25,659.25]},{at:1.23,duration:.32,frequencies:[783.99]},{at:1.60,duration:.48,frequencies:[1046.5]}]},
];
const SETTINGS_KEY='signal.call-notifications.v1',SEEN_KEY='signal.call-notifications.seen.v1';
const PREFERENCES_EVENT='signal-call-notification-preferences',PREVIEW_EVENT='signal-call-sound-preview';
const ID=/^[A-Za-z0-9_-]{1,80}$/,USERNAME=/^[A-Za-z0-9_-]{3,32}$/;
const active=new Map<string,PendingCall>(),browserNotifications=new Map<string,Notification>();
const seen=new Map<string,number>(),deadlines=new Map<string,number>(),completed=new Map<string,number>(),buffers=new Map<string,AudioBuffer>();
let audio:AudioContext|undefined,resuming:Promise<AudioContext|null>|undefined,lifecycle=0,currentUserId:string|null=null,localCallConnected=false;
let timer:ReturnType<typeof setInterval>|undefined;
type Playback={source:AudioBufferSourceNode;gain:GainNode;kind:'ring'|'preview';key:string;direction:CallDirection;melody:CallMelodyId;deadline:number};
let playback:Playback|null=null,previewToken=0;
let previewIntent:{owner?:string;direction:CallDirection;melody:CallMelodyId;token:number}|null=null;
let previewState:CallSoundPreviewState={playing:false,pending:false,direction:null,melody:null};
export type CustomCallSoundState={available:boolean;duration:number|null;loading:boolean;busy:boolean;blocked:boolean;supported:boolean;error:string};
type CustomSlot={data:CustomCallAudio|null;loading:boolean;busy:boolean;error:string;version:number};
const CUSTOM_EVENT='signal-custom-call-audio';
const customSlots:Record<CallDirection,CustomSlot>={incoming:{data:null,loading:false,busy:false,error:'',version:0},outgoing:{data:null,loading:false,busy:false,error:'',version:0}};
const customOperations=new Map<CallDirection,{controller:AbortController;owner?:string;version:number}>();
let customInitialized=false,lastCustomCallBusy=false;
let customBroadcast:BroadcastChannel|undefined;
try{if(!window.signalAndroidBridge&&typeof BroadcastChannel==='function')customBroadcast=new BroadcastChannel('signal-custom-call-audio-v1');}catch{/* Local storage still works without cross-window messages. */}
function customCallBusy(){return active.size>0||localCallConnected;}
function publishCustom(){window.dispatchEvent(new CustomEvent(CUSTOM_EVENT));}
function broadcastCustom(direction:CallDirection){try{customBroadcast?.postMessage({direction});}catch{/* Cross-window refresh is optional. */}}
export function getCustomCallSoundState(direction:CallDirection):CustomCallSoundState{const slot=customSlots[direction];return {available:Boolean(slot.data),duration:slot.data?.duration??null,loading:slot.loading,busy:slot.busy,blocked:customCallBusy(),supported:supportsCustomCallAudio(),error:slot.error};}
async function loadCustomSlot(direction:CallDirection){
  const slot=customSlots[direction];if(customOperations.has(direction)||!supportsCustomCallAudio())return;
  const version=++slot.version;slot.loading=true;publishCustom();
  try{const data=await getCustomCallAudio(direction);if(slot.version!==version)return;slot.data=data;slot.error='';}
  catch(cause){if(slot.version===version){slot.data=null;slot.error=cause instanceof Error?cause.message:'Не удалось открыть сохранённый звук.';}}
  finally{if(slot.version===version){slot.loading=false;publishCustom();}}
}
function initializeCustomSounds(){if(customInitialized||window.signalAndroidBridge)return;customInitialized=true;void loadCustomSlot('incoming');void loadCustomSlot('outgoing');}
if(customBroadcast)customBroadcast.onmessage=event=>{if(event.data?.direction==='incoming'||event.data?.direction==='outgoing')void loadCustomSlot(event.data.direction);};
export function cancelCustomCallSoundOperations(owner?:string){for(const operation of customOperations.values())if(owner===undefined||operation.owner===owner)operation.controller.abort();}
export async function importCustomCallSound(direction:CallDirection,file:File,options:{owner?:string;canCommit?:()=>boolean}={}):Promise<void>{
  refresh();if(customCallBusy())throw new Error('Загрузить звук можно после завершения вызова.');
  if(!supportsCustomCallAudio())throw new Error('Этот браузер не поддерживает сохранение своих звуков. Используйте встроенные мелодии.');
  customOperations.get(direction)?.controller.abort();stopCallSoundPreview();
  const slot=customSlots[direction],operation={controller:new AbortController(),owner:options.owner,version:++slot.version};customOperations.set(direction,operation);slot.loading=false;slot.busy=true;slot.error='';publishCustom();
  const canCommit=()=>customOperations.get(direction)===operation&&!operation.controller.signal.aborted&&!customCallBusy()&&(options.canCommit?.()??true);
  let failed=false;
  try{const data=await importCustomCallAudio(direction,file,{signal:operation.controller.signal,canCommit});if(customOperations.get(direction)!==operation)return;slot.data=data;slot.error='';broadcastCustom(direction);
    if(canCommit())setCallNotificationPreferences(direction==='incoming'?{incomingMelody:'custom'}:{outgoingMelody:'custom'});
  }catch(cause){failed=true;if(customOperations.get(direction)===operation){slot.error=operation.controller.signal.aborted?(customCallBusy()?'Начался вызов. Загрузка звука отменена.':'Загрузка звука отменена.'):cause instanceof Error?cause.message:'Не удалось загрузить звук.';}throw cause;}
  finally{if(customOperations.get(direction)===operation){customOperations.delete(direction);slot.busy=false;publishCustom();if(failed)void loadCustomSlot(direction);}}
}
export async function removeCustomCallSound(direction:CallDirection,options:{owner?:string;canCommit?:()=>boolean}={}):Promise<void>{
  refresh();if(customCallBusy())throw new Error('Удалить звук можно после завершения вызова.');
  customOperations.get(direction)?.controller.abort();stopCallSoundPreview();
  const slot=customSlots[direction],operation={controller:new AbortController(),owner:options.owner,version:++slot.version};customOperations.set(direction,operation);slot.loading=false;slot.busy=true;slot.error='';publishCustom();
  const canCommit=()=>customOperations.get(direction)===operation&&!operation.controller.signal.aborted&&!customCallBusy()&&(options.canCommit?.()??true);
  try{await deleteCustomCallAudio(direction,{signal:operation.controller.signal,canCommit});if(customOperations.get(direction)!==operation)return;slot.data=null;slot.error='';broadcastCustom(direction);
    if(selectedMelody(direction)==='custom'&&canCommit())setCallNotificationPreferences(direction==='incoming'?{incomingMelody:'signal'}:{outgoingMelody:'line'});
  }catch(cause){if(customOperations.get(direction)===operation)slot.error=operation.controller.signal.aborted?'Удаление отменено.':cause instanceof Error?cause.message:'Не удалось удалить звук.';throw cause;}
  finally{if(customOperations.get(direction)===operation){customOperations.delete(direction);slot.busy=false;publishCustom();}}
}
function melodyId(value:unknown,fallback:CallMelodyId):CallMelodyId{return value==='custom'||CALL_MELODIES.some(melody=>melody.id===value)?value as CallMelodyId:fallback;}
function volumeValue(value:unknown):number{return typeof value==='number'&&Number.isFinite(value)?Math.round(Math.min(100,Math.max(0,value))):65;}
function defaults():CallNotificationPreferences{return {sound:true,incomingSound:true,outgoingSound:true,incomingMelody:'signal',outgoingMelody:'line',volume:65,notifications:Boolean(window.signalDesktop?.notifyIncomingCall)};}
try{const rows:unknown=JSON.parse(sessionStorage.getItem(SEEN_KEY)||'[]');if(Array.isArray(rows))for(const row of rows.slice(-200)){if(Array.isArray(row)&&typeof row[0]==='string'&&row[0].length<=164&&typeof row[1]==='number'&&row[1]>Date.now()&&row[1]<Date.now()+120_000)seen.set(row[0],row[1]);}}catch{/* In-memory deduplication remains available. */}
export function getCallNotificationPreferences():CallNotificationPreferences{
  const fallback=defaults();
  try{const stored=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}');if(!stored||typeof stored!=='object'||Array.isArray(stored))return fallback;
    const incomingSound=typeof stored.incomingSound==='boolean'?stored.incomingSound:stored.sound!==false;
    return {sound:incomingSound,incomingSound,outgoingSound:typeof stored.outgoingSound==='boolean'?stored.outgoingSound:stored.sound!==false,incomingMelody:melodyId(stored.incomingMelody,'signal'),outgoingMelody:melodyId(stored.outgoingMelody,'line'),volume:volumeValue(stored.volume),notifications:typeof stored.notifications==='boolean'?stored.notifications:fallback.notifications};
  }catch{return fallback;}
}
let preferences=getCallNotificationPreferences();
export function setCallNotificationPreferences(patch:Partial<CallNotificationPreferences>):CallNotificationPreferences{
  const incomingSound=typeof patch.incomingSound==='boolean'?patch.incomingSound:typeof patch.sound==='boolean'?patch.sound:preferences.incomingSound,previous=preferences;
  preferences={...preferences,sound:incomingSound,incomingSound,...(typeof patch.outgoingSound==='boolean'?{outgoingSound:patch.outgoingSound}:{}),...(patch.incomingMelody!==undefined?{incomingMelody:melodyId(patch.incomingMelody,preferences.incomingMelody)}:{}),...(patch.outgoingMelody!==undefined?{outgoingMelody:melodyId(patch.outgoingMelody,preferences.outgoingMelody)}:{}),...(typeof patch.volume==='number'?{volume:volumeValue(patch.volume)}:{}),...(typeof patch.notifications==='boolean'?{notifications:patch.notifications}:{})};
  try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(preferences));}catch{/* Effective for this session. */}
  if(!preferences.notifications)dismissNotifications();
  if(previewIntent&&(!preferences.volume||(previewIntent.direction==='incoming'?(patch.incomingSound===false||patch.sound===false||previous.incomingMelody!==preferences.incomingMelody):(patch.outgoingSound===false||previous.outgoingMelody!==preferences.outgoingMelody))))stopCallSoundPreview();
  if(playback?.kind==='preview'&&audio)playback.gain.gain.setTargetAtTime(preferences.volume/100,audio.currentTime,.012);
  window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT));refresh();return {...preferences};
}
export function callNotificationSupport():{desktop:boolean;permission:Permission}{
  if(window.signalDesktop?.notifyIncomingCall)return {desktop:true,permission:'granted'};
  if(!('Notification'in window)||!window.isSecureContext)return {desktop:false,permission:'unsupported'};
  return {desktop:false,permission:Notification.permission};
}
// Permission is requested only by the deliberate settings button.
export async function enableCallNotifications():Promise<{enabled:boolean;permission:Permission}>{
  const support=callNotificationSupport();let permission=support.permission;
  if(support.desktop){if(!await window.signalDesktop!.callNotificationsSupported().catch(()=>false))permission='unsupported';}
  else if(permission==='default'){try{permission=await Notification.requestPermission();}catch{permission='denied';}}
  const enabled=permission==='granted';setCallNotificationPreferences({notifications:enabled});return {enabled,permission};
}
function persistSeen(){const now=Date.now();for(const [key,expiry]of seen)if(expiry<=now)seen.delete(key);while(seen.size>200)seen.delete(seen.keys().next().value!);try{sessionStorage.setItem(SEEN_KEY,JSON.stringify([...seen]));}catch{/* Optional persistence. */}}
function soundEnabled(direction:CallDirection){return direction==='incoming'?preferences.incomingSound:preferences.outgoingSound;}
function selectedMelody(direction:CallDirection){return direction==='incoming'?preferences.incomingMelody:preferences.outgoingMelody;}
function publishPreview(next:CallSoundPreviewState){previewState=next;window.dispatchEvent(new CustomEvent(PREVIEW_EVENT,{detail:{...next}}));}
export function getCallSoundPreviewState():CallSoundPreviewState{return {...previewState};}
function stopPlayback(){const previous=playback;playback=null;if(!previous)return;previous.source.onended=null;try{previous.gain.gain.cancelScheduledValues(0);previous.gain.gain.value=0;previous.source.stop();}catch{/* Already stopped by its deadline. */}previous.source.disconnect();previous.gain.disconnect();}
function melodyBuffer(context:AudioContext,id:CallMelodyId,direction:CallDirection):AudioBuffer{
  if(id==='custom'){
    const data=customSlots[direction].data;
    if(data){const key=`custom:${direction}:${data.revision}`,cached=buffers.get(key);if(cached)return cached;
      try{const bytes=data.wav,view=new DataView(bytes),tag=(at:number)=>String.fromCharCode(...new Uint8Array(bytes,at,4));
        if(bytes.byteLength<46||tag(0)!=='RIFF'||tag(8)!=='WAVE'||tag(12)!=='fmt '||tag(36)!=='data'||view.getUint32(4,true)!==bytes.byteLength-8||view.getUint32(16,true)!==16||view.getUint16(20,true)!==1||view.getUint16(22,true)!==1||view.getUint32(24,true)!==24000||view.getUint32(28,true)!==48000||view.getUint16(32,true)!==2||view.getUint16(34,true)!==16||view.getUint32(40,true)!==bytes.byteLength-44||(bytes.byteLength-44)%2!==0)throw new Error('format');
        const frames=(bytes.byteLength-44)/2;if(frames>360000)throw new Error('duration');const buffer=context.createBuffer(1,frames,24000),samples=buffer.getChannelData(0);let peak=0;
        for(let index=0;index<frames;index++)peak=Math.max(peak,Math.abs(view.getInt16(44+index*2,true)/32768));
        const scale=Math.min(1,.22/Math.max(peak,.0001));
        for(let index=0;index<frames;index++)samples[index]=view.getInt16(44+index*2,true)/32768*scale*Math.min(1,index/360,(frames-1-index)/960);
        while(buffers.size>=16)buffers.delete(buffers.keys().next().value!);buffers.set(key,buffer);return buffer;
      }catch{customSlots[direction].data=null;customSlots[direction].error='Сохранённый звук недоступен. Загрузите его снова.';publishCustom();}
    }
    id=direction==='incoming'?'signal':'line';
  }
  const key=`${context.sampleRate}:${id}`,cached=buffers.get(key);if(cached)return cached;
  const melody=CALL_MELODIES.find(item=>item.id===id)!,buffer=context.createBuffer(1,Math.ceil(melody.duration*context.sampleRate),context.sampleRate),samples=buffer.getChannelData(0);
  for(const note of melody.notes){const start=Math.floor(note.at*context.sampleRate),length=Math.floor(note.duration*context.sampleRate);
    for(let index=0;index<length&&start+index<samples.length;index++){const time=index/context.sampleRate,attack=melody.timbre==='chip'?.006:.018,envelope=Math.min(1,time/attack)*Math.min(1,(note.duration-time)/.075)*(melody.timbre==='bell'?Math.exp(-2.6*time/note.duration):1);let value=0;
      for(const frequency of note.frequencies){const phase=2*Math.PI*frequency*time;value+=melody.timbre==='chip'?Math.sin(phase)+.11*Math.sin(3*phase)+.04*Math.sin(5*phase):melody.timbre==='bell'?Math.sin(phase)+.26*Math.sin(2*phase)+.09*Math.sin(3*phase):Math.sin(phase)+.055*Math.sin(2*phase);}
      samples[start+index]+=value/note.frequencies.length*envelope*.22;
    }
  }
  while(buffers.size>=16)buffers.delete(buffers.keys().next().value!);buffers.set(key,buffer);return buffer;
}
function beginPlayback(direction:CallDirection,melody:CallMelodyId,kind:'ring'|'preview',key:string,deadline:number){
  const context=audio;if(!context||context.state!=='running'||deadline<=Date.now()||!preferences.volume)return false;
  stopPlayback();const source=context.createBufferSource(),gain=context.createGain();source.buffer=melodyBuffer(context,melody,direction);source.loop=kind==='ring';gain.gain.value=preferences.volume/100;source.connect(gain);gain.connect(context.destination);
  const next:Playback={source,gain,kind,key,direction,melody,deadline};playback=next;
  source.onended=()=>{source.disconnect();gain.disconnect();if(playback!==next)return;playback=null;if(kind==='preview'){previewIntent=null;publishPreview({playing:false,pending:false,direction:null,melody:null});}refresh();};
  source.start();
  // The audio engine owns repetition and the stop deadline, independently of
  // background JavaScript timer throttling. Wall-clock checks also run on resume.
  source.stop(context.currentTime+Math.max(.001,(deadline-Date.now())/1000));return true;
}
function prepareAudio(fromGesture=false):Promise<AudioContext|null>{
  if(audio?.state==='running')return Promise.resolve(audio);if(resuming)return resuming;
  if(!audio&&!fromGesture&&!window.signalDesktop)return Promise.resolve(null);
  try{if(!audio||audio.state==='closed'){audio=new AudioContext();audio.onstatechange=()=>refresh();}const context=audio,version=lifecycle;
    const request=context.resume().then(()=>version===lifecycle&&audio===context&&context.state==='running'?context:null).catch(()=>null);
    resuming=request;void request.then(context=>{if(resuming===request)resuming=undefined;if(context)refresh();});return request;
  }catch{return Promise.resolve(null);}
}
function unlockAudio(){refresh();if(currentUserId&&preferences.volume&&(preferences.incomingSound||preferences.outgoingSound))void prepareAudio(true);}
window.addEventListener('pointerdown',unlockAudio,{passive:true});window.addEventListener('keydown',unlockAudio);
export function stopCallSoundPreview(owner?:string){
  if(owner!==undefined&&previewIntent?.owner!==owner)return;
  previewToken++;previewIntent=null;if(playback?.kind==='preview')stopPlayback();if(previewState.playing||previewState.pending)publishPreview({playing:false,pending:false,direction:null,melody:null});refresh();
}
// Preview never masks a real pending call, including a muted call.
export async function previewCallMelody(direction:CallDirection,id:CallMelodyId=selectedMelody(direction),owner?:string):Promise<boolean>{
  if(active.size||!preferences.volume)return false;stopCallSoundPreview();const token=++previewToken,melody=melodyId(id,selectedMelody(direction));previewIntent={owner,direction,melody,token};publishPreview({playing:false,pending:true,direction,melody});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const preparation=Promise.all([prepareAudio(true),melody==='custom'&&!customSlots[direction].data?loadCustomSlot(direction):Promise.resolve()]).then(([context])=>context);
  const context=await Promise.race([preparation,new Promise<null>(resolve=>{timeout=setTimeout(()=>resolve(null),2000);})]);if(timeout)clearTimeout(timeout);
  if(token!==previewToken||previewIntent?.token!==token||active.size)return false;if(!context){stopCallSoundPreview(owner);return false;}
  if(melody==='custom'&&!customSlots[direction].data){stopCallSoundPreview(owner);return false;}
  const duration=melody==='custom'?customSlots[direction].data!.duration:CALL_MELODIES.find(item=>item.id===melody)!.duration,played=beginPlayback(direction,melody,'preview',`preview:${token}`,Date.now()+duration*1000);
  if(played)publishPreview({playing:true,pending:false,direction,melody});else stopCallSoundPreview(owner);return played;
}
function dismissOne(id:string){browserNotifications.get(id)?.close();browserNotifications.delete(id);void window.signalDesktop?.dismissCallNotification?.(id).catch(()=>{});}
function dismissNotifications(){for(const notification of browserNotifications.values())notification.close();browserNotifications.clear();void window.signalDesktop?.dismissCallNotification?.().catch(()=>{});}
function notify(call:PendingCall){
  if(call.direction!=='incoming'||!preferences.notifications)return;const key=`${call.userId}:${call.id}`;if(seen.has(key)||callNotificationSupport().permission!=='granted')return;
  seen.set(key,call.expiresAt+60_000);persistSeen();
  if(window.signalDesktop?.notifyIncomingCall){void window.signalDesktop.notifyIncomingCall({id:call.id,username:call.username,expiresAt:new Date(call.expiresAt).toISOString()}).catch(()=>{});return;}
  try{const notification=new Notification('Входящий звонок в Сигнал',{body:`@${call.username} звонит вам`,tag:`signal-call-${call.id}`,silent:true});notification.onclick=()=>{window.focus();notification.close();};notification.onclose=()=>{if(browserNotifications.get(call.id)===notification)browserNotifications.delete(call.id);};browserNotifications.set(call.id,notification);}catch{/* OS policy can change while the app is open. */}
}
function prune(){const now=Date.now();for(const [key,expiry]of completed)if(expiry<=now)completed.delete(key);while(completed.size>200)completed.delete(completed.keys().next().value!);}
function markCompleted(call:PendingCall){completed.set(`${call.userId}:${call.id}`,Math.max(Date.now(),call.expiresAt)+60_000);}
function refresh(){
  const now=Date.now();prune();for(const [id,call]of active){if(call.expiresAt<=now){active.delete(id);markCompleted(call);if(call.direction==='incoming')dismissOne(id);}else notify(call);}
  const customBlocked=customCallBusy();if(customBlocked)cancelCustomCallSoundOperations();if(lastCustomCallBusy!==customBlocked){lastCustomCallBusy=customBlocked;publishCustom();}
  if(!active.size){if(timer)clearInterval(timer);timer=undefined;if(playback?.kind==='ring')stopPlayback();return;}
  if(previewIntent){previewToken++;previewIntent=null;if(playback?.kind==='preview')stopPlayback();publishPreview({playing:false,pending:false,direction:null,melody:null});}
  const candidates=[...active.values()].filter(call=>soundEnabled(call.direction)&&preferences.volume>0&&(call.direction!=='outgoing'||!localCallConnected)).sort((left,right)=>Number(left.direction==='outgoing')-Number(right.direction==='outgoing')||left.expiresAt-right.expiresAt||left.id.localeCompare(right.id)),target=candidates[0];
  if(!target){if(playback?.kind==='ring')stopPlayback();}
  else if(audio?.state==='running'){const melody=selectedMelody(target.direction),key=`${target.userId}:${target.id}`;if(playback?.kind==='ring'&&playback.key===key&&playback.melody===melody)playback.gain.gain.setTargetAtTime(preferences.volume/100,audio.currentTime,.012);else beginPlayback(target.direction,melody,'ring',key,target.expiresAt);}
  else void prepareAudio();timer ||=setInterval(refresh,1000);
}
export function syncCallNotifications(calls:readonly NotificationCall[],userId:string|null){
  initializeCustomSounds();
  if(!userId||!ID.test(userId)){clearCallNotifications();return;}if(currentUserId!==userId){clearCallNotifications();currentUserId=userId;window.dispatchEvent(new CustomEvent('signal-call-state-request'));}else currentUserId=userId;
  const now=Date.now(),next=new Map<string,PendingCall>();
  for(const call of calls){
    if(!call||typeof call.id!=='string'||!ID.test(call.id)||!call.caller||!call.recipient||typeof call.caller.id!=='string'||!ID.test(call.caller.id)||typeof call.recipient.id!=='string'||!ID.test(call.recipient.id))continue;
    const direction:CallDirection|undefined=call.recipient.id===userId&&call.caller.id!==userId?'incoming':call.caller.id===userId&&call.recipient.id!==userId?'outgoing':undefined;if(!direction)continue;const key=`${userId}:${call.id}`;
    if(call.status!=='pending'){completed.set(key,now+120_000);continue;}
    if(completed.has(key)||typeof call.expiresAt!=='string'||call.expiresAt.length>40)continue;
    const expiresAt=Date.parse(call.expiresAt),username=direction==='incoming'?call.caller.username:call.recipient.username||'';
    if(!Number.isFinite(expiresAt)||expiresAt<=now||direction==='incoming'&&(typeof username!=='string'||!USERNAME.test(username)))continue;
    if(!deadlines.has(key)){while(deadlines.size>=200)deadlines.delete(deadlines.keys().next().value!);deadlines.set(key,Math.min(expiresAt,now+45_000));}
    const deadline=deadlines.get(key)!;if(deadline<=now)continue;next.set(call.id,{id:call.id,username,expiresAt:deadline,userId,direction});
  }
  for(const [id,call]of active)if(!next.has(id)){markCompleted(call);if(call.direction==='incoming')dismissOne(id);}active.clear();for(const [id,call]of next)active.set(id,call);refresh();
}
export const syncIncomingCallNotifications=syncCallNotifications;
export function clearCallNotifications(){
  cancelCustomCallSoundOperations();
  lifecycle++;previewToken++;previewIntent=null;active.clear();currentUserId=null;localCallConnected=false;if(timer)clearInterval(timer);timer=undefined;stopPlayback();dismissNotifications();if(previewState.playing||previewState.pending)publishPreview({playing:false,pending:false,direction:null,melody:null});
  const previous=audio;audio=undefined;resuming=undefined;if(previous){previous.onstatechange=null;if(previous.state!=='closed')void previous.close().catch(()=>{});}
  if(lastCustomCallBusy){lastCustomCallBusy=false;publishCustom();}
}
window.addEventListener('pagehide',clearCallNotifications);
window.addEventListener('storage',event=>{if(event.key===SETTINGS_KEY){preferences=getCallNotificationPreferences();if(!preferences.notifications)dismissNotifications();stopCallSoundPreview();window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT));refresh();}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();});
window.addEventListener('signal-call-state',event=>{const detail:unknown=(event as CustomEvent).detail;const connected=Boolean(currentUserId&&detail&&typeof detail==='object'&&(detail as {connected?:unknown}).connected===true);if(localCallConnected!==connected){localCallConnected=connected;refresh();}});

export function CallNotificationSettings({compact=false}:{compact?:boolean}={}){
  const [value,setValue]=useState(preferences),[preview,setPreview]=useState(previewState),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [custom,setCustom]=useState(()=>({incoming:getCustomCallSoundState('incoming'),outgoing:getCustomCallSoundState('outgoing')}));
  const owner=useId(),mounted=useRef(true),attempt=useRef(0),fileAttempt=useRef({incoming:0,outgoing:0}),fileInputs=useRef<Partial<Record<CallDirection,HTMLInputElement|null>>>({});
  useEffect(()=>{mounted.current=true;const changed=()=>{setValue({...preferences});setPreview({...previewState});setCustom({incoming:getCustomCallSoundState('incoming'),outgoing:getCustomCallSoundState('outgoing')});};
    window.addEventListener(PREFERENCES_EVENT,changed);window.addEventListener(PREVIEW_EVENT,changed);window.addEventListener(CUSTOM_EVENT,changed);window.addEventListener('focus',changed);initializeCustomSounds();changed();
    return()=>{mounted.current=false;fileAttempt.current.incoming++;fileAttempt.current.outgoing++;cancelCustomCallSoundOperations(owner);window.removeEventListener(PREFERENCES_EVENT,changed);window.removeEventListener(PREVIEW_EVENT,changed);window.removeEventListener(CUSTOM_EVENT,changed);window.removeEventListener('focus',changed);stopCallSoundPreview(owner);};
  },[owner]);
  const support=callNotificationSupport(),notificationsEnabled=value.notifications&&support.permission==='granted',importing=custom.incoming.busy||custom.outgoing.busy;
  const change=(patch:Partial<CallNotificationPreferences>)=>{attempt.current++;setMessage('');setCallNotificationPreferences(patch);};
  const enable=async()=>{setBusy(true);setMessage('');try{const result=await enableCallNotifications();if(mounted.current)setMessage(result.enabled?'Системные уведомления о звонках включены.':result.permission==='denied'?'Уведомления заблокированы. Разрешите их в настройках этого сайта.':'Системные уведомления недоступны на этом устройстве.');}finally{if(mounted.current)setBusy(false);}};
  const listen=async(direction:CallDirection)=>{const version=++attempt.current;if((preview.playing||preview.pending)&&preview.direction===direction){stopCallSoundPreview();return;}setMessage('');const played=await previewCallMelody(direction,selectedMelody(direction),owner);if(mounted.current&&version===attempt.current&&!played)setMessage(active.size?'Предпрослушивание доступно, когда нет ожидающего звонка.':selectedMelody(direction)==='custom'&&!customSlots[direction].data?'Свой звук недоступен. Загрузите файл снова.':'Не удалось включить звук. Разрешите звук для Сигнала и проверьте громкость.');};
  const importFile=async(direction:CallDirection,file:File)=>{const version=++fileAttempt.current[direction];attempt.current++;setMessage('');
    try{await importCustomCallSound(direction,file,{owner,canCommit:()=>mounted.current&&fileAttempt.current[direction]===version});if(mounted.current&&fileAttempt.current[direction]===version)setMessage(selectedMelody(direction)==='custom'?'Свой звук сохранён на этом устройстве и выбран для звонка.':'Звук сохранён. Его можно выбрать в списке мелодий.');}
    catch(cause){if(mounted.current&&fileAttempt.current[direction]===version)setMessage(cause instanceof Error&&cause.name!=='AbortError'?cause.message:'Загрузка отменена. Сохранённый звук не изменён.');}
  };
  const removeFile=async(direction:CallDirection)=>{const version=++fileAttempt.current[direction];attempt.current++;setMessage('');
    try{await removeCustomCallSound(direction,{owner,canCommit:()=>mounted.current&&fileAttempt.current[direction]===version});if(mounted.current&&fileAttempt.current[direction]===version)setMessage('Свой звук удалён с этого устройства.');}
    catch(cause){if(mounted.current&&fileAttempt.current[direction]===version)setMessage(cause instanceof Error&&cause.name!=='AbortError'?cause.message:'Удаление отменено.');}
  };
  const directionSettings=(direction:CallDirection)=>{const incoming=direction==='incoming',sound=incoming?value.incomingSound:value.outgoingSound,melody=incoming?value.incomingMelody:value.outgoingMelody,playing=(preview.playing||preview.pending)&&preview.direction===direction,slot=custom[direction],fileId=`${owner}-${direction}-file`;
    return h('div',{className:'call-sound-direction',key:direction},
      h('label',{className:'checkbox-label'},h('input',{type:'checkbox',checked:sound,onChange:(event:{target:{checked:boolean}})=>{change(incoming?{incomingSound:event.target.checked}:{outgoingSound:event.target.checked});if(event.target.checked)void prepareAudio(true);}}),incoming?'Входящий звонок':'Ожидание ответа при исходящем звонке'),
      h('div',{className:'call-melody-controls'},h('label',null,h('span',null,incoming?'Мелодия входящего':'Мелодия ожидания'),h('select',{value:melody,disabled:importing,'aria-label':incoming?'Мелодия входящего звонка':'Мелодия исходящего звонка',onChange:(event:{target:{value:string}})=>change(incoming?{incomingMelody:melodyId(event.target.value,'signal')}:{outgoingMelody:melodyId(event.target.value,'line')})},...CALL_MELODIES.map(option=>h('option',{key:option.id,value:option.id},option.label)),h('option',{value:'custom',disabled:!slot.available},'Свой звук'))),h('button',{type:'button',className:`button secondary call-preview-button${playing?' active':''}`,disabled:!value.volume||importing||(melody==='custom'&&!slot.available&&!playing),onClick:()=>void listen(direction),'aria-label':playing?'Остановить прослушивание':incoming?'Прослушать входящий звонок':'Прослушать ожидание ответа'},playing?'Остановить':'Прослушать')),
      h('div',{className:'custom-call-audio'},h('input',{id:fileId,type:'file',hidden:true,accept:'.wav,.mp3,.ogg,.opus,audio/wav,audio/x-wav,audio/mpeg,audio/ogg,audio/opus',ref:(node:HTMLInputElement|null)=>{fileInputs.current[direction]=node;},onChange:(event:{currentTarget:HTMLInputElement})=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void importFile(direction,file);}}),
        h('div',{className:'custom-call-audio-actions'},h('button',{type:'button',className:'button secondary',disabled:!slot.supported||importing||slot.blocked,'aria-controls':fileId,onClick:()=>fileInputs.current[direction]?.click()},slot.busy?'Обрабатываем…':slot.available?'Заменить свой звук':'Загрузить свой звук'),h('button',{type:'button',className:'button custom-audio-delete',disabled:!slot.supported||(!slot.available&&!slot.error&&melody!=='custom')||importing||slot.blocked,'aria-label':incoming?'Удалить свой звук входящего звонка':'Удалить свой звук исходящего звонка',onClick:()=>void removeFile(direction)},'Удалить')),
        h('p',{className:'settings-help custom-audio-status'},slot.loading?'Открываем сохранённый звук…':slot.busy?'Проверяем и сохраняем звук…':slot.available?`Свой звук · ${slot.duration!.toFixed(1)} с`:melody==='custom'?'Свой звук не найден. Пока используется стандартная мелодия.':'Свой звук не выбран.'),slot.error&&h('p',{className:'custom-audio-error',role:'alert'},slot.error)));
  };
  return h('section',{className:`call-notification-settings${compact?' compact':''}`,'aria-label':'Звуки и уведомления звонков'},
    !compact&&h('h3',null,'Звуки и уведомления'),directionSettings('incoming'),directionSettings('outgoing'),
    h('p',{className:'settings-help'},'Свой файл: WAV, MP3 или Ogg Opus, до 8 МБ и 15 секунд. Звук хранится только на этом устройстве; оригинальный файл не сохраняется и не отправляется на сервер.'),
    (custom.incoming.blocked||custom.outgoing.blocked)&&h('p',{className:'settings-help'},'Загрузка и удаление своих звуков доступны после завершения вызова.'),
    !custom.incoming.supported&&h('p',{className:'settings-help'},'Этот браузер не поддерживает локальное сохранение своих звуков. Встроенные мелодии доступны.'),
    h('label',{className:'call-ring-volume'},h('span',null,'Громкость звонка',h('strong',null,`${value.volume}%`)),h('input',{type:'range',min:0,max:100,step:1,value:value.volume,'aria-label':'Громкость звонка','aria-valuetext':`${value.volume}%`,onChange:(event:{target:{value:string}})=>change({volume:Number(event.target.value)})})),
    h('p',{className:'settings-help'},'Мелодия звучит до ответа, отказа или завершения ожидания. Входящий звонок имеет приоритет. Предпрослушивание не перекрывает настоящий вызов.'),
    h('div',{className:'call-system-notifications'},h('h4',null,'Системные уведомления'),notificationsEnabled?h('label',{className:'checkbox-label'},h('input',{type:'checkbox',checked:true,onChange:()=>change({notifications:false})}),'Показывать входящие звонки'):h('button',{type:'button',className:'button secondary',disabled:busy||support.permission==='unsupported',onClick:()=>void enable()},busy?'Включаем…':'Включить уведомления о звонках')),
    h('p',{className:'settings-help'},support.desktop?'Windows: можно свернуть Сигнал в трей. Нажатие на уведомление откроет окно; ответить на звонок нужно отдельно.':'Браузер: оставьте вкладку открытой, её можно убрать в фон. Для звука сначала нажмите на странице Сигнала.'),
    support.desktop&&h('p',{className:'settings-help'},'Если уведомления не появляются, разрешите Сигнал в настройках уведомлений Windows и проверьте режим «Не беспокоить». Для Windows рекомендуется установленная версия приложения.'),
    support.permission==='unsupported'&&h('p',{className:'settings-help'},'Системные уведомления не поддерживаются этим браузером.'),support.permission==='denied'&&h('p',{className:'settings-help'},'Разрешите уведомления в настройках этого сайта, затем включите их здесь.'),message&&h('p',{className:'call-sound-feedback',role:'status'},message));
}
