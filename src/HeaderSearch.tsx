import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {AtSign,Hash,LoaderCircle,MessageSquare,Search,Users,Volume2,X} from 'lucide-react';
import {api} from './api';
import type {Channel} from './channelTypes';
import type {Friend} from './FriendsHome';
import './search-account.css';

export type SearchMessage={id:number;channelId:string;channelName:string;content:string;createdAt:string;user:{id:string;username:string}};
type SearchResponse={messages:SearchMessage[];hasMore:boolean;nextBefore:number|null};
type SearchItem={kind:'channel';channel:Channel}|{kind:'friend';friend:Friend}|{kind:'message';message:SearchMessage};
const channelName=(channel:Channel)=>channel.kind==='direct'?channel.peer?.username||channel.name:channel.name;

async function requestSearch(path:string,signal:AbortSignal):Promise<SearchResponse>{
  // Desktop requests use its restricted connection; sequence guards below also
  // discard replies from requests that cannot be cancelled through that bridge.
  if(window.signalDesktop||window.signalAndroidBridge)return api<SearchResponse>(path);
  const response=await fetch(`/api${path}`,{credentials:'same-origin',signal});
  const data=await response.json().catch(()=>({error:'Не удалось прочитать результаты поиска.'}));
  if(!response.ok)throw new Error(data.error||'Поиск временно недоступен.');
  return data;
}

export function HeaderSearch({accountId,channels,friends,currentChannel,onChannel,onFriend,onMessage,deletedMessageIds}:{
  accountId:string;channels:Channel[];friends:Friend[];currentChannel?:Channel;
  deletedMessageIds?:ReadonlySet<number>;
  onChannel:(channel:Channel)=>void;onFriend:(friend:Friend)=>void;onMessage:(message:SearchMessage)=>void;
}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[scope,setScope]=useState<'all'|'current'>('all');
  const [messages,setMessages]=useState<SearchMessage[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[hasMore,setHasMore]=useState(false),[nextBefore,setNextBefore]=useState<number|null>(null),[active,setActive]=useState(0);
  const [position,setPosition]=useState({left:12,top:64,width:460});
  const root=useRef<HTMLDivElement>(null),popup=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),sequence=useRef(0),controller=useRef<AbortController|null>(null),mounted=useRef(true),morePending=useRef(false);
  const listId=useId(),trimmed=query.trim(),needle=trimmed.toLocaleLowerCase('ru-RU');
  const localChannels=useMemo(()=>needle?channels.filter(channel=>channelName(channel).toLocaleLowerCase('ru-RU').includes(needle)).slice(0,6):[],[channels,needle]);
  const localFriends=useMemo(()=>needle?friends.filter(friend=>friend.username.toLocaleLowerCase('ru-RU').includes(needle)).slice(0,6):[],[friends,needle]);
  const visibleMessages=messages.filter(message=>channels.some(channel=>channel.id===message.channelId)&&!deletedMessageIds?.has(message.id));
  const items:SearchItem[]=[...localChannels.map(channel=>({kind:'channel' as const,channel})),...localFriends.map(friend=>({kind:'friend' as const,friend})),...visibleMessages.map(message=>({kind:'message' as const,message}))];
  const scopeId=scope==='current'?currentChannel?.id:undefined;
  const searchPath=(before?:number)=>`/search?${new URLSearchParams({q:trimmed,...(scopeId?{channelId:scopeId}:{}),...(before?{before:String(before)}:{})})}`;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sequence.current++;controller.current?.abort();};},[accountId]);
  useEffect(()=>{if(!currentChannel&&scope==='current')setScope('all');},[currentChannel,scope]);
  useEffect(()=>{
    const revision=++sequence.current;controller.current?.abort();morePending.current=false;setMessages([]);setHasMore(false);setNextBefore(null);setError('');setActive(0);setBusy(false);
    if(!open||trimmed.length<2)return;
    const abort=new AbortController();controller.current=abort;setBusy(true);
    const timer=setTimeout(()=>{void requestSearch(searchPath(),abort.signal).then(result=>{if(mounted.current&&revision===sequence.current&&!abort.signal.aborted){setMessages(result.messages);setHasMore(result.hasMore);setNextBefore(result.nextBefore);}}).catch(cause=>{if(mounted.current&&revision===sequence.current&&!abort.signal.aborted)setError((cause as Error).message);}).finally(()=>{if(mounted.current&&revision===sequence.current)setBusy(false);});},280);
    return()=>{clearTimeout(timer);abort.abort();};
  },[accountId,trimmed,scopeId,open]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const rect=root.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(470,window.innerWidth-24);setPosition({left:Math.max(12,Math.min(rect.right-width,window.innerWidth-width-12)),top:rect.bottom+8,width});};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  useEffect(()=>{
    const shortcut=(event:globalThis.KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&!document.querySelector('[aria-modal="true"]')){event.preventDefault();setOpen(true);input.current?.focus();}if(event.key==='Escape'&&open){event.preventDefault();setOpen(false);input.current?.focus();}};
    const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!root.current?.contains(target)&&!popup.current?.contains(target))setOpen(false);};
    window.addEventListener('keydown',shortcut);document.addEventListener('pointerdown',outside);
    return()=>{window.removeEventListener('keydown',shortcut);document.removeEventListener('pointerdown',outside);};
  },[open]);
  useEffect(()=>{if(active>=items.length)setActive(Math.max(0,items.length-1));},[items.length,active]);
  useEffect(()=>{if(open)popup.current?.querySelector<HTMLElement>(`[data-search-index="${active}"]`)?.scrollIntoView({block:'nearest'});},[active,open]);
  function choose(item:SearchItem){setOpen(false);if(item.kind==='channel')onChannel(item.channel);else if(item.kind==='friend')onFriend(item.friend);else onMessage(item.message);}
  function keyboard(event:KeyboardEvent<HTMLInputElement>){if(event.nativeEvent.isComposing)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setOpen(true);setActive(old=>items.length?(old+(event.key==='ArrowDown'?1:-1)+items.length)%items.length:0);}else if(event.key==='Enter'&&open){event.preventDefault();if(items[active])choose(items[active]);}}
  async function more(){
    if(!hasMore||nextBefore===null||busy||morePending.current)return;
    morePending.current=true;setBusy(true);const revision=sequence.current,abort=new AbortController();controller.current=abort;
    try{const result=await requestSearch(searchPath(nextBefore),abort.signal);if(mounted.current&&revision===sequence.current&&!abort.signal.aborted){setMessages(old=>[...new Map([...old,...result.messages].map(message=>[message.id,message])).values()]);setHasMore(result.hasMore);setNextBefore(result.nextBefore);}}
    catch(cause){if(mounted.current&&revision===sequence.current&&!abort.signal.aborted)setError((cause as Error).message);}
    finally{morePending.current=false;if(mounted.current&&revision===sequence.current)setBusy(false);}
  }
  return <div className="header-search" ref={root}>
    <Search size={16}/><input ref={input} role="combobox" aria-label="Поиск каналов, друзей и сообщений" aria-expanded={open} aria-controls={listId} aria-activedescendant={open&&items[active]?`${listId}-${active}`:undefined} value={query} onFocus={()=>setOpen(true)} onChange={event=>setQuery(event.target.value)} onKeyDown={keyboard} placeholder="Поиск" maxLength={100} autoComplete="off"/>
    {query&&<button type="button" className="search-clear" onClick={()=>{setQuery('');input.current?.focus();}} aria-label="Очистить поиск"><X size={14}/></button>}
    {open&&createPortal(<div className="search-popover" ref={popup} style={{left:position.left,top:position.top,width:position.width,maxHeight:`calc(100dvh - ${position.top+16}px)`}}>
      <div className="search-scope"><strong>Поиск сообщений</strong><div><button className={scope==='all'?'active':''} onClick={()=>setScope('all')}>Все каналы</button><button className={scope==='current'?'active':''} disabled={!currentChannel} onClick={()=>setScope('current')}>Этот канал</button></div></div>
      <div className="search-results" role="listbox" id={listId} aria-label="Результаты поиска" aria-busy={busy}>
        {!trimmed&&<div className="search-tip"><Search size={25}/><p>Найдите канал, друга или сообщение.<br/>Для поиска в переписке введите от двух символов.</p><small>↑ ↓ — выбрать · Enter — открыть · Esc — закрыть</small></div>}
        {items.map((item,index)=><div key={item.kind==='channel'?`channel:${item.channel.id}`:item.kind==='friend'?`friend:${item.friend.id}`:`message:${item.message.id}`}>
          {(index===0||items[index-1].kind!==item.kind)&&<h3 role="presentation">{item.kind==='channel'?'Каналы и разговоры':item.kind==='friend'?'Друзья':'Сообщения'}</h3>}
          <button id={`${listId}-${index}`} role="option" aria-selected={index===active} data-search-index={index} className={`search-result ${index===active?'active':''} ${item.kind==='message'?'message-result':''}`} onPointerMove={()=>setActive(index)} onClick={()=>choose(item)}>
            {item.kind==='channel'?<>{item.channel.kind==='direct'?<AtSign size={19}/>:item.channel.channelType==='voice'?<Volume2 size={19}/>:<Hash size={19}/>}<span><strong>{channelName(item.channel)}</strong><small>{item.channel.kind==='direct'?'Личный разговор':item.channel.channelType==='voice'?'Голосовой канал':'Текстовый канал'}</small></span></>:item.kind==='friend'?<><Users size={19}/><span><strong>{item.friend.username}</strong><small>{item.friend.online?'Друг · в сети':'Друг · не в сети'}</small></span></>:<><MessageSquare size={18}/><span><strong>{item.message.user.username}<small> · {item.message.channelName}</small></strong><span className="search-message-snippet">{item.message.content}</span><small>{new Date(item.message.createdAt).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small></span></>}
          </button>
        </div>)}
        {trimmed&&!items.length&&!busy&&!error&&<p className="search-no-results">{trimmed.length<2?'Введите ещё один символ для поиска сообщений.':'Ничего не найдено в доступных вам каналах.'}</p>}
        {busy&&<p className="search-loading" role="status"><LoaderCircle size={16} className="spin"/>Ищем…</p>}
        {error&&<p className="search-error" role="alert">{error}</p>}
        {hasMore&&<button className="search-more" disabled={busy} onClick={()=>void more()}>Более ранние сообщения</button>}
      </div>
    </div>,document.body)}
  </div>;
}
