import { useEffect, useRef, useState } from 'react';
import { PhoneCall, PhoneOff, Radio } from 'lucide-react';
import './api';

type NativeState = {type:'callState';channelId?:string;state:'idle'|'connecting'|'connected'|'reconnecting'|'disconnected'|'error';error?:string};
export function androidCommand(message:Record<string,unknown>) {
  window.signalAndroidBridge?.postMessage(JSON.stringify(message));
}

export default function AndroidCallStage({channel,onLeave}:{channel:{id:string;name:string};onLeave:()=>void}) {
  const [state,setState] = useState<NativeState['state']>('idle');
  const [error,setError] = useState('');
  const wasActive = useRef(false);
  const leave = useRef(onLeave);
  leave.current = onLeave;
  useEffect(()=>{
    const bridge=window.signalAndroidBridge;
    if(!bridge)return;
    const receive=(event:{data:string})=>{
      try {
        const data=JSON.parse(event.data) as NativeState;
        if(data.type!=='callState')return;
        if(data.channelId&&data.channelId!==channel.id)return;
        setState(data.state);
        setError(data.error||'');
        if(['connected','connecting','reconnecting'].includes(data.state))wasActive.current=true;
        if(data.state==='disconnected'&&wasActive.current)leave.current();
      }catch{/* Ignore unsupported native events. */}
    };
    bridge.onmessage=receive;
    androidCommand({type:'getCallState'});
    const poll=setInterval(()=>androidCommand({type:'getCallState'}),5000);
    return()=>{clearInterval(poll);if(bridge.onmessage===receive)bridge.onmessage=null;};
  },[channel.id]);
  const active=['connected','connecting','reconnecting'].includes(state);
  const label=state==='connected'?'Звонок продолжается':state==='connecting'?'Подключаемся…':state==='reconnecting'?'Восстанавливаем связь…':'Голосовая комната';
  return <section className="call-stage call-status android-call" aria-label={`Голосовой канал ${channel.name}`}>
    <Radio size={24}/><h3>{label} · {channel.name}</h3>
    <p>{error||'Микрофон, камера и трансляция экрана доступны в окне звонка приложения.'}</p>
    <div className="android-call-actions"><button className="primary" onClick={()=>androidCommand({type:'openCall',channelId:channel.id,channelName:channel.name})}><PhoneCall size={17}/>{active?'Вернуться в звонок':'Открыть звонок'}</button><button className="call-control leave-call" onClick={onLeave}><PhoneOff size={17}/>Выйти</button></div>
  </section>;
}
