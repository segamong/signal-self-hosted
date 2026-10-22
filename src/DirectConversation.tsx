import {useEffect,useRef,useState,type FormEvent} from 'react';
import {AtSign,LoaderCircle,MessageSquare,UserPlus} from 'lucide-react';
import {api} from './api';
import type {Channel} from './channelTypes';
import type {Invitation} from './Invitations';

export function DirectConversation({initialUsername='',onCreated,onIncoming}:{
  initialUsername?:string;
  onCreated:(channel:Channel,pending:boolean)=>void;
  onIncoming:(invitation:Invitation)=>void;
}) {
  const [username,setUsername]=useState(initialUsername),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const active=useRef(true),pending=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(pending.current)return;
    const target=username.trim().replace(/^@/,'').toLowerCase();
    if(!/^[a-z0-9_-]{3,32}$/.test(target)){setError('Введите никнейм: от 3 до 32 латинских букв, цифр, _ или -.');return;}
    pending.current=true;setBusy(true);setError('');
    try {
      const result=await api<{channel:Channel|null;invitation:Invitation|null;requiresAcceptance?:boolean}>('/direct-channels',{username:target});
      if(!active.current)return;
      if(result.requiresAcceptance&&result.invitation)onIncoming(result.invitation);
      else if(result.channel)onCreated(result.channel,Boolean(result.invitation));
      else setError('Не удалось открыть разговор. Повторите попытку.');
    }catch(cause){if(active.current)setError((cause as Error).message);}
    finally{pending.current=false;if(active.current)setBusy(false);}
  }
  return <div className="direct-start">
    <h2>Личный разговор</h2>
    <p>Переписка, голос, видео и экран — только для вас двоих.</p>
    <form onSubmit={submit} aria-busy={busy}>
      <label>Никнейм друга<div className="direct-username-field"><AtSign size={18}/><input value={username} onChange={event=>{setUsername(event.target.value);setError('');}} maxLength={33} required autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="username" autoFocus/></div></label>
      <p className="direct-help"><UserPlus size={17}/>Друг получит приглашение и сможет принять или отклонить его. Если разговор уже есть, он откроется сразу.</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy||!username.trim()}>{busy?<LoaderCircle className="spin" size={17}/>:<MessageSquare size={17}/>} {busy?'Открываем…':'Открыть разговор'}</button>
    </form>
  </div>;
}
