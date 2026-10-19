import { useEffect, useRef, useState } from 'react';
import { PhoneCall, PhoneOff, Radio } from 'lucide-react';
import './api';

export type AndroidCallState = {type:'callState';channelId?:string;state:'idle'|'connecting'|'connected'|'reconnecting'|'disconnected'|'error';error?:string;requestId?:string};
const listeners = new Set<(state:AndroidCallState)=>void>();
let listeningBridge: typeof window.signalAndroidBridge;

/** One native listener also reaches the workspace when no call stage is mounted. */
export function subscribeAndroidCallState(listener:(state:AndroidCallState)=>void) {
  const bridge=window.signalAndroidBridge;
  if(bridge&&bridge!==listeningBridge) {
    listeningBridge=bridge;
    bridge.onmessage=event=>{
      try {
        const data=JSON.parse(event.data) as AndroidCallState;
        if(data.type!=='callState'||!['idle','connecting','connected','reconnecting','disconnected','error'].includes(data.state))return;
        if(data.channelId!==undefined&&(typeof data.channelId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(data.channelId)))return;
        if(data.error!==undefined&&typeof data.error!=='string')return;
        for(const receive of listeners)receive(data);
      }catch{/* Ignore unsupported native events. */}
    };
  }
  listeners.add(listener);
  return()=>{listeners.delete(listener);};
}
export function androidCommand(message:Record<string,unknown>) {
  window.signalAndroidBridge?.postMessage(JSON.stringify(message));
}

export default function AndroidCallStage({channel,onLeave}:{channel:{id:string;name:string};onLeave:()=>void}) {
  const [state,setState] = useState<AndroidCallState['state']>('idle');
  const [error,setError] = useState('');
  const wasActive = useRef(false);
  const leave = useRef(onLeave);
  leave.current = onLeave;
  useEffect(()=>{
    if(!window.signalAndroidBridge)return;
    wasActive.current=false;
    const unsubscribe=subscribeAndroidCallState(data=>{
        if(data.channelId&&data.channelId!==channel.id)return;
        setState(data.state);
        setError(data.error||'');
        if(['connected','connecting','reconnecting'].includes(data.state))wasActive.current=true;
        if(data.state==='disconnected'&&wasActive.current)leave.current();
    });
    androidCommand({type:'getCallState'});
    const poll=setInterval(()=>androidCommand({type:'getCallState'}),5000);
    return()=>{clearInterval(poll);unsubscribe();};
  },[channel.id]);
  const active=['connected','connecting','reconnecting'].includes(state);
  const label=state==='connected'?'Звонок продолжается':state==='connecting'?'Подключаемся…':state==='reconnecting'?'Восстанавливаем связь…':'Голосовая комната';
  return <section className="call-stage call-status android-call" aria-label={`Голосовой канал ${channel.name}`}>
    <Radio size={24}/><h3>{label} · {channel.name}</h3>
    <p>{error||'Микрофон, камера и трансляция экрана доступны в окне звонка приложения.'}</p>
    <div className="android-call-actions"><button className="primary" onClick={()=>androidCommand({type:'openCall',channelId:channel.id,channelName:channel.name})}><PhoneCall size={17}/>{active?'Вернуться в звонок':'Открыть звонок'}</button><button className="call-control leave-call" onClick={onLeave}><PhoneOff size={17}/>Выйти</button></div>
  </section>;
}
