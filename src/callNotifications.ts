import {createElement as h,useEffect,useId,useRef,useState} from 'react';
import './call-notifications.css';

export type CallDirection='incoming'|'outgoing';
export type CallMelodyId='signal'|'chime'|'bloom'|'pulse'|'line';
export type NotificationCall={id:string;status:string;caller:{id:string;username:string};recipient:{id:string;username?:string};expiresAt:string};
export type CallNotificationPreferences={sound:boolean;incomingSound:boolean;outgoingSound:boolean;incomingMelody:CallMelodyId;outgoingMelody:CallMelodyId;volume:number;notifications:boolean};
export type CallSoundPreviewState={playing:boolean;pending:boolean;direction:CallDirection|null;melody:CallMelodyId|null};
type Permission=NotificationPermission|'unsupported';
type PendingCall={id:string;username:string;expiresAt:number;userId:string;direction:CallDirection};
type Note={at:number;duration:number;frequencies:readonly number[]};
type Melody={id:CallMelodyId;label:string;description:string;duration:number;notes:readonly Note[]};
export const CALL_MELODIES:readonly Melody[]=[
  {id:'signal',label:'Сигнал',description:'Короткий двойной звонок',duration:2.5,notes:[{at:0,duration:.22,frequencies:[440,660]},{at:.34,duration:.22,frequencies:[440,660]}]},
  {id:'chime',label:'Перезвон',description:'Три лёгкие ноты',duration:3.2,notes:[{at:0,duration:.24,frequencies:[659.25]},{at:.24,duration:.25,frequencies:[783.99]},{at:.50,duration:.36,frequencies:[987.77]}]},
  {id:'bloom',label:'Мягкий',description:'Плавная восходящая мелодия',duration:3.5,notes:[{at:0,duration:.30,frequencies:[523.25,659.25]},{at:.34,duration:.30,frequencies:[659.25,783.99]},{at:.68,duration:.42,frequencies:[783.99,1046.5]}]},
  {id:'pulse',label:'Пульс',description:'Три спокойных коротких сигнала',duration:2.9,notes:[{at:0,duration:.19,frequencies:[480,620]},{at:.30,duration:.19,frequencies:[480,620]},{at:.60,duration:.19,frequencies:[480,620]}]},
  {id:'line',label:'Линия',description:'Классическое ожидание ответа',duration:3.6,notes:[{at:0,duration:.85,frequencies:[440,480]},{at:1.05,duration:.85,frequencies:[440,480]}]},
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
function melodyId(value:unknown,fallback:CallMelodyId):CallMelodyId{return CALL_MELODIES.some(melody=>melody.id===value)?value as CallMelodyId:fallback;}
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
function melodyBuffer(context:AudioContext,id:CallMelodyId):AudioBuffer{
  const key=`${context.sampleRate}:${id}`,cached=buffers.get(key);if(cached)return cached;
  const melody=CALL_MELODIES.find(item=>item.id===id)!,buffer=context.createBuffer(1,Math.ceil(melody.duration*context.sampleRate),context.sampleRate),samples=buffer.getChannelData(0);
  for(const note of melody.notes){const start=Math.floor(note.at*context.sampleRate),length=Math.floor(note.duration*context.sampleRate);
    for(let index=0;index<length&&start+index<samples.length;index++){const time=index/context.sampleRate,envelope=Math.min(1,time/.018)*Math.min(1,(note.duration-time)/.075);let value=0;
      for(const frequency of note.frequencies)value+=Math.sin(2*Math.PI*frequency*time)+.055*Math.sin(4*Math.PI*frequency*time);
      samples[start+index]+=value/note.frequencies.length*envelope*.22;
    }
  }
  while(buffers.size>=10)buffers.delete(buffers.keys().next().value!);buffers.set(key,buffer);return buffer;
}
function beginPlayback(direction:CallDirection,melody:CallMelodyId,kind:'ring'|'preview',key:string,deadline:number){
  const context=audio;if(!context||context.state!=='running'||deadline<=Date.now()||!preferences.volume)return false;
  stopPlayback();const source=context.createBufferSource(),gain=context.createGain();source.buffer=melodyBuffer(context,melody);source.loop=kind==='ring';gain.gain.value=preferences.volume/100;source.connect(gain);gain.connect(context.destination);
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
  const context=await Promise.race([prepareAudio(true),new Promise<null>(resolve=>{timeout=setTimeout(()=>resolve(null),2000);})]);if(timeout)clearTimeout(timeout);
  if(token!==previewToken||previewIntent?.token!==token||active.size)return false;if(!context){stopCallSoundPreview(owner);return false;}
  const duration=CALL_MELODIES.find(item=>item.id===melody)!.duration,played=beginPlayback(direction,melody,'preview',`preview:${token}`,Date.now()+duration*1000);
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
  if(!active.size){if(timer)clearInterval(timer);timer=undefined;if(playback?.kind==='ring')stopPlayback();return;}
  if(previewIntent){previewToken++;previewIntent=null;if(playback?.kind==='preview')stopPlayback();publishPreview({playing:false,pending:false,direction:null,melody:null});}
  const candidates=[...active.values()].filter(call=>soundEnabled(call.direction)&&preferences.volume>0&&(call.direction!=='outgoing'||!localCallConnected)).sort((left,right)=>Number(left.direction==='outgoing')-Number(right.direction==='outgoing')||left.expiresAt-right.expiresAt||left.id.localeCompare(right.id)),target=candidates[0];
  if(!target){if(playback?.kind==='ring')stopPlayback();}
  else if(audio?.state==='running'){const melody=selectedMelody(target.direction),key=`${target.userId}:${target.id}`;if(playback?.kind==='ring'&&playback.key===key&&playback.melody===melody)playback.gain.gain.setTargetAtTime(preferences.volume/100,audio.currentTime,.012);else beginPlayback(target.direction,melody,'ring',key,target.expiresAt);}
  else void prepareAudio();timer ||=setInterval(refresh,1000);
}
export function syncCallNotifications(calls:readonly NotificationCall[],userId:string|null){
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
  lifecycle++;previewToken++;previewIntent=null;active.clear();currentUserId=null;localCallConnected=false;if(timer)clearInterval(timer);timer=undefined;stopPlayback();dismissNotifications();if(previewState.playing||previewState.pending)publishPreview({playing:false,pending:false,direction:null,melody:null});
  const previous=audio;audio=undefined;resuming=undefined;if(previous){previous.onstatechange=null;if(previous.state!=='closed')void previous.close().catch(()=>{});}
}
window.addEventListener('pagehide',clearCallNotifications);
window.addEventListener('storage',event=>{if(event.key===SETTINGS_KEY){preferences=getCallNotificationPreferences();if(!preferences.notifications)dismissNotifications();stopCallSoundPreview();window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT));refresh();}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();});
window.addEventListener('signal-call-state',event=>{const detail:unknown=(event as CustomEvent).detail;const connected=Boolean(currentUserId&&detail&&typeof detail==='object'&&(detail as {connected?:unknown}).connected===true);if(localCallConnected!==connected){localCallConnected=connected;refresh();}});

export function CallNotificationSettings({compact=false}:{compact?:boolean}={}){
  const [value,setValue]=useState(preferences),[preview,setPreview]=useState(previewState),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),owner=useId(),mounted=useRef(true),attempt=useRef(0);
  useEffect(()=>{mounted.current=true;const changed=()=>{setValue({...preferences});setPreview({...previewState});};window.addEventListener(PREFERENCES_EVENT,changed);window.addEventListener(PREVIEW_EVENT,changed);window.addEventListener('focus',changed);return()=>{mounted.current=false;window.removeEventListener(PREFERENCES_EVENT,changed);window.removeEventListener(PREVIEW_EVENT,changed);window.removeEventListener('focus',changed);stopCallSoundPreview(owner);};},[owner]);
  const support=callNotificationSupport(),notificationsEnabled=value.notifications&&support.permission==='granted';
  const enable=async()=>{setBusy(true);setMessage('');try{const result=await enableCallNotifications();if(mounted.current)setMessage(result.enabled?'Системные уведомления о звонках включены.':result.permission==='denied'?'Уведомления заблокированы. Разрешите их в настройках этого сайта.':'Системные уведомления недоступны на этом устройстве.');}finally{if(mounted.current)setBusy(false);}};
  const listen=async(direction:CallDirection)=>{const version=++attempt.current;if((preview.playing||preview.pending)&&preview.direction===direction){stopCallSoundPreview();return;}setMessage('');const played=await previewCallMelody(direction,selectedMelody(direction),owner);if(mounted.current&&version===attempt.current&&!played)setMessage(active.size?'Предпрослушивание доступно, когда нет ожидающего звонка.':'Не удалось включить звук. Разрешите звук для Сигнала и проверьте громкость.');};
  const directionSettings=(direction:CallDirection)=>{const incoming=direction==='incoming',sound=incoming?value.incomingSound:value.outgoingSound,melody=incoming?value.incomingMelody:value.outgoingMelody,playing=(preview.playing||preview.pending)&&preview.direction===direction;
    return h('div',{className:'call-sound-direction',key:direction},
      h('label',{className:'checkbox-label'},h('input',{type:'checkbox',checked:sound,onChange:(event:{target:{checked:boolean}})=>{setCallNotificationPreferences(incoming?{incomingSound:event.target.checked}:{outgoingSound:event.target.checked});if(event.target.checked)void prepareAudio(true);}}),incoming?'Входящий звонок':'Ожидание ответа при исходящем звонке'),
      h('div',{className:'call-melody-controls'},h('label',null,h('span',null,incoming?'Мелодия входящего':'Мелодия ожидания'),h('select',{value:melody,'aria-label':incoming?'Мелодия входящего звонка':'Мелодия исходящего звонка',onChange:(event:{target:{value:string}})=>setCallNotificationPreferences(incoming?{incomingMelody:melodyId(event.target.value,'signal')}:{outgoingMelody:melodyId(event.target.value,'line')})},...CALL_MELODIES.map(option=>h('option',{key:option.id,value:option.id},option.label)))),h('button',{type:'button',className:`button secondary call-preview-button${playing?' active':''}`,disabled:!value.volume,onClick:()=>void listen(direction),'aria-label':playing?'Остановить прослушивание':incoming?'Прослушать входящий звонок':'Прослушать ожидание ответа'},playing?'Остановить':'Прослушать')));
  };
  return h('section',{className:`call-notification-settings${compact?' compact':''}`,'aria-label':'Звуки и уведомления звонков'},
    !compact&&h('h3',null,'Звуки и уведомления'),directionSettings('incoming'),directionSettings('outgoing'),
    h('label',{className:'call-ring-volume'},h('span',null,'Громкость звонка',h('strong',null,`${value.volume}%`)),h('input',{type:'range',min:0,max:100,step:1,value:value.volume,'aria-label':'Громкость звонка','aria-valuetext':`${value.volume}%`,onChange:(event:{target:{value:string}})=>setCallNotificationPreferences({volume:Number(event.target.value)})})),
    h('p',{className:'settings-help'},'Мелодия звучит до ответа, отказа или завершения ожидания. Входящий звонок имеет приоритет. Предпрослушивание не перекрывает настоящий вызов.'),
    h('div',{className:'call-system-notifications'},h('h4',null,'Системные уведомления'),notificationsEnabled?h('label',{className:'checkbox-label'},h('input',{type:'checkbox',checked:true,onChange:()=>setCallNotificationPreferences({notifications:false})}),'Показывать входящие звонки'):h('button',{type:'button',className:'button secondary',disabled:busy||support.permission==='unsupported',onClick:()=>void enable()},busy?'Включаем…':'Включить уведомления о звонках')),
    h('p',{className:'settings-help'},support.desktop?'Windows: можно свернуть Сигнал в трей. Нажатие на уведомление откроет окно; ответить на звонок нужно отдельно.':'Браузер: оставьте вкладку открытой, её можно убрать в фон. Для звука сначала нажмите на странице Сигнала.'),
    support.desktop&&h('p',{className:'settings-help'},'Если уведомления не появляются, разрешите Сигнал в настройках уведомлений Windows и проверьте режим «Не беспокоить». Для Windows рекомендуется установленная версия приложения.'),
    support.permission==='unsupported'&&h('p',{className:'settings-help'},'Системные уведомления не поддерживаются этим браузером.'),support.permission==='denied'&&h('p',{className:'settings-help'},'Разрешите уведомления в настройках этого сайта, затем включите их здесь.'),message&&h('p',{className:'call-sound-feedback',role:'status'},message));
}
