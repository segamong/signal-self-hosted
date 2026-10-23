import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {Check,KeyRound,LoaderCircle} from 'lucide-react';
import {api} from './api';
import './search-account.css';

export function PasswordChangeForm({username}:{username:string}){
  const [open,setOpen]=useState(false),[current,setCurrent]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[field,setField]=useState(''),[success,setSuccess]=useState(false);
  const mounted=useRef(true),pending=useRef(false),form=useRef<HTMLFormElement>(null),id=useId();
  function clear(){setCurrent('');setPassword('');setConfirm('');setError('');setField('');form.current?.reset();}
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;form.current?.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input=>{input.value='';});};},[]);
  function invalid(name:string,message:string){setField(name);setError(message);form.current?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.focus();}
  async function submit(event:FormEvent){
    event.preventDefault();if(pending.current)return;setSuccess(false);setError('');setField('');
    if(!current){invalid('currentPassword','Введите текущий пароль.');return;}
    if([...password].length<8||password.length>128||new TextEncoder().encode(password).length>512){invalid('newPassword','Новый пароль должен содержать от 8 до 128 символов.');return;}
    if(password===current){invalid('newPassword','Новый пароль должен отличаться от текущего.');return;}
    if(password!==confirm){invalid('confirmPassword','Новые пароли не совпадают.');return;}
    pending.current=true;setBusy(true);
    try{await api<{ok:true;otherSessionsRevoked:true}>('/account/password',{currentPassword:current,newPassword:password});if(!mounted.current)return;clear();setOpen(false);setSuccess(true);}
    catch(cause){if(mounted.current)setError((cause as Error).message||'Не удалось изменить пароль.');}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  }
  return <section className="password-change" aria-label="Пароль аккаунта">
    <h3><KeyRound size={18}/>Пароль аккаунта</h3><p>После смены пароля другие устройства выйдут из аккаунта. Текущий сеанс останется открытым.</p>
    {!open?<button className="secondary" onClick={()=>{clear();setSuccess(false);setOpen(true);}}>Изменить пароль</button>:<form ref={form} onSubmit={submit} aria-busy={busy}>
      <input className="password-username" name="username" autoComplete="username" value={username} readOnly tabIndex={-1} aria-hidden="true"/>
      <label htmlFor={`${id}-current`}>Текущий пароль<input id={`${id}-current`} name="currentPassword" type="password" autoComplete="current-password" value={current} onChange={event=>setCurrent(event.target.value)} required maxLength={128} autoFocus disabled={busy} aria-invalid={field==='currentPassword'} aria-describedby={error?`${id}-error`:undefined}/></label>
      <label htmlFor={`${id}-new`}>Новый пароль<input id={`${id}-new`} name="newPassword" type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)} required minLength={8} maxLength={128} disabled={busy} aria-invalid={field==='newPassword'} aria-describedby={`${id}-hint${error?` ${id}-error`:''}`}/></label>
      <label htmlFor={`${id}-confirm`}>Повторите новый пароль<input id={`${id}-confirm`} name="confirmPassword" type="password" autoComplete="new-password" value={confirm} onChange={event=>setConfirm(event.target.value)} required minLength={8} maxLength={128} disabled={busy} aria-invalid={field==='confirmPassword'} aria-describedby={error?`${id}-error`:undefined}/></label>
      <p id={`${id}-hint`} className="password-hint">От 8 до 128 символов. Используйте отдельный пароль для Сигнала.</p>
      {error&&<p className="form-error" id={`${id}-error`} role="alert">{error}</p>}
      <div className="password-actions"><button className="secondary" type="button" disabled={busy} onClick={()=>{clear();setOpen(false);}}>Отмена</button><button className="primary" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} {busy?'Сохраняем…':'Сохранить пароль'}</button></div>
    </form>}
    {success&&<p className="password-success" role="status"><Check size={18}/>Пароль изменён. На других устройствах потребуется войти снова.</p>}
  </section>;
}
