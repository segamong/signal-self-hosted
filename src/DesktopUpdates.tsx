import {useEffect,useRef,useState} from 'react';
import {Check,Download,LoaderCircle,RefreshCw,X} from 'lucide-react';
import type {UpdateState} from './api';
import './desktop-updates.css';

export function DesktopUpdates({autoCheck=false}:{autoCheck?:boolean}){
  const desktop=window.signalDesktop;
  const [state,setState]=useState<UpdateState>({status:'idle',currentVersion:''});
  useEffect(()=>{
    if(!desktop)return;let stopped=false;
    const unsubscribe=desktop.subscribeEvents(event=>{
      if(!stopped&&event.type==='desktop-update')setState(event as unknown as UpdateState);
    });
    void (async()=>{
      try{
        const current=await desktop.getUpdateState();if(!stopped)setState(current);
        if(autoCheck&&!stopped){const next=await desktop.checkUpdate();if(!stopped)setState(next);}
      }catch{if(!stopped)setState({status:'error',currentVersion:'',error:'Не удалось проверить обновления. Повторите попытку.'});}
    })();
    return()=>{stopped=true;unsubscribe();};
  },[desktop,autoCheck]);
  if(!desktop)return null;
  const pending=state.status==='checking'||state.status==='downloading';
  const progress=Math.max(0,Math.min(100,Number.isFinite(state.progress)?state.progress!:0));
  const text=state.status==='checking'?'Проверяем обновления…':state.status==='downloading'?`Загружаем обновление… ${Math.round(progress)}%`:state.status==='available'?`Доступна версия ${state.version}`:state.status==='ready'?`Версия ${state.version} готова к установке`:state.status==='current'?'У вас последняя версия':state.status==='error'?state.error||'Не удалось обновить приложение.':'Проверьте, появилась ли новая версия.';
  async function action(){
    try{
      const next=state.status==='available'?await desktop!.downloadUpdate():state.status==='ready'?await desktop!.installUpdate():await desktop!.checkUpdate();
      setState(next);
    }catch{setState(previous=>({...previous,status:'error',error:'Не удалось выполнить обновление. Повторите проверку.'}));}
  }
  return <section className="desktop-update-card" aria-label="Обновление приложения">
    <div className="update-heading"><RefreshCw size={19}/><div><strong>Обновление приложения</strong><span>{state.currentVersion?`Текущая версия: ${state.currentVersion}`:'Сигнал для Windows'}</span></div></div>
    <p className={state.status==='error'?'update-message update-error':'update-message'} role={state.status==='error'?'alert':'status'}>{text}</p>
    {state.status==='downloading'&&<progress className="update-progress" value={progress} max={100} aria-label="Загрузка обновления"/>}
    <button className={state.status==='ready'?'primary full':'secondary full'} onClick={()=>void action()} disabled={pending}>
      {pending?<LoaderCircle size={17} className="spin"/>:state.status==='current'?<Check size={17}/>:state.status==='available'||state.status==='ready'?<Download size={17}/>:<RefreshCw size={17}/>}
      {state.status==='available'?'Скачать обновление':state.status==='ready'?'Установить обновление':state.status==='checking'?'Проверяем…':state.status==='downloading'?'Загружаем…':state.status==='error'?'Повторить проверку':'Проверить обновления'}
    </button>
    {state.status==='ready'&&<p className="update-footnote">При установке приложение закроется. Аккаунт и настройки сохранятся.</p>}
  </section>;
}

export function UpdateDialog({onClose}:{onClose:()=>void}){
  const dialog=useRef<HTMLElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const focusable=()=>Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]')||[]);
    focusable()[0]?.focus();
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){onClose();return;}
      if(event.key!=='Tab')return;
      const nodes=focusable(),first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',keydown);
    return()=>{document.removeEventListener('keydown',keydown);if(previous?.isConnected)previous.focus();};
  },[onClose]);
  return <div className="modal-overlay update-dialog-overlay" onClick={onClose}><section ref={dialog} className="modal-card" role="dialog" aria-modal="true" aria-label="Обновление Сигнала" onClick={event=>event.stopPropagation()}><button className="icon-btn modal-close" onClick={onClose} aria-label="Закрыть"><X size={20}/></button><h2>Новый Сигнал</h2><DesktopUpdates autoCheck/></section></div>;
}
