import {useState,type FormEvent} from 'react';
import {AtSign,Check,MessageSquare,Phone,Search,UserPlus,Users,X} from 'lucide-react';

export type Friend = {id:string;username:string;online:boolean};
export type FriendRequest = {id:string;user:{id:string;username:string};createdAt:string};
export type FriendsState = {friends:Friend[];incoming:FriendRequest[];outgoing:FriendRequest[]};
export const EMPTY_FRIENDS:FriendsState = {friends:[],incoming:[],outgoing:[]};
export type DirectCall = {
  id:string;channelId:string;caller:{id:string;username:string};recipient:{id:string;username:string};
  status:'pending'|'accepted'|'declined'|'cancelled'|'ended'|'expired';expiresAt:string;
};

export function FriendsHome({state,busy,onAdd,onRespond,onRemove,onChat,onCall}:{
  state:FriendsState;busy:string|null;
  onAdd:(username:string)=>Promise<boolean>;
  onRespond:(id:string,action:'accept'|'decline'|'cancel')=>void;
  onRemove:(userId:string)=>void;
  onChat:(friend:Friend)=>void;
  onCall:(friend:Friend)=>void;
}) {
  const [tab,setTab]=useState<'all'|'online'|'pending'|'add'>('all');
  const [username,setUsername]=useState(''),[search,setSearch]=useState(''),[sent,setSent]=useState(false);
  const [removeId,setRemoveId]=useState<string|null>(null);
  const pending=state.incoming.length+state.outgoing.length;
  const friends=state.friends.filter(friend=>(tab!=='online'||friend.online)&&friend.username.toLowerCase().includes(search.toLowerCase()));
  async function add(event:FormEvent){event.preventDefault();if(await onAdd(username)){setUsername('');setSent(true);}}
  return <section className="friends-home" aria-label="Друзья">
    <nav className="friends-tabs" aria-label="Список друзей">
      <span className="friends-tab-title"><Users size={21}/>Друзья</span><i/>
      <button className={tab==='online'?'active':''} onClick={()=>setTab('online')}>В сети</button>
      <button className={tab==='all'?'active':''} onClick={()=>setTab('all')}>Все</button>
      <button className={tab==='pending'?'active':''} onClick={()=>setTab('pending')}>Ожидание{pending>0&&<b>{pending}</b>}</button>
      <button className={`friends-add-tab ${tab==='add'?'active':''}`} onClick={()=>{setTab('add');setSent(false);}}>Добавить в друзья</button>
    </nav>
    <div className="friends-body">
      {tab==='add'?<div className="friends-add-form"><h2>Добавить в друзья</h2><p>Найдите друга по его точному никнейму. Он сможет принять или отклонить запрос.</p><form onSubmit={add}><label htmlFor="friend-username">Никнейм</label><div><AtSign size={20}/><input id="friend-username" value={username} onChange={event=>{setUsername(event.target.value);setSent(false);}} placeholder="username" minLength={3} maxLength={33} required autoComplete="off" autoCapitalize="none" spellCheck={false}/><button className="primary" disabled={Boolean(busy)||!username.trim()}><UserPlus size={17}/>{busy==='add'?'Отправляем…':'Отправить запрос'}</button></div></form>{sent&&<p className="friends-success" role="status"><Check size={17}/>Запрос отправлен. Ожидаем ответа друга.</p>}</div>
      :tab==='pending'?<><h2 className="friends-list-heading">Ожидают ответа — {pending}</h2>{state.incoming.length>0&&<h3 className="friends-group-title">Входящие</h3>}{state.incoming.map(request=><div className="friend-row" key={request.id}><span className="friend-avatar">{request.user.username.slice(0,1).toUpperCase()}</span><div className="friend-row-name"><strong>{request.user.username}</strong><small>Хочет добавить вас в друзья</small></div><button className="friend-action accept" disabled={Boolean(busy)} onClick={()=>onRespond(request.id,'accept')} aria-label={`Принять запрос ${request.user.username}`} title="Принять"><Check size={20}/></button><button className="friend-action danger" disabled={Boolean(busy)} onClick={()=>onRespond(request.id,'decline')} aria-label={`Отклонить запрос ${request.user.username}`} title="Отклонить"><X size={20}/></button></div>)}{state.outgoing.length>0&&<h3 className="friends-group-title">Исходящие</h3>}{state.outgoing.map(request=><div className="friend-row" key={request.id}><span className="friend-avatar">{request.user.username.slice(0,1).toUpperCase()}</span><div className="friend-row-name"><strong>{request.user.username}</strong><small>Запрос отправлен</small></div><button className="friend-action danger" disabled={Boolean(busy)} onClick={()=>onRespond(request.id,'cancel')} aria-label={`Отменить запрос ${request.user.username}`} title="Отменить запрос"><X size={20}/></button></div>)}{!pending&&<div className="friends-empty"><UserPlus size={48}/><h2>Все запросы разобраны</h2><p>Новые приглашения в друзья появятся здесь.</p></div>}</>
      :<><label className="friend-search"><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Поиск" aria-label="Поиск друзей"/><Search size={19}/></label><h2 className="friends-list-heading">{tab==='online'?'В сети':'Все друзья'} — {friends.length}</h2>{friends.map(friend=><div className="friend-row" key={friend.id}><span className={`friend-avatar ${friend.online?'online':''}`}>{friend.username.slice(0,1).toUpperCase()}<i/></span><button className="friend-row-name" onClick={()=>onChat(friend)}><strong>{friend.username}</strong><small>{friend.online?'В сети':'Не в сети'}</small></button><button className="friend-action" disabled={Boolean(busy)} onClick={()=>onChat(friend)} aria-label={`Написать ${friend.username}`} title="Сообщение"><MessageSquare size={19}/></button><button className="friend-action" disabled={Boolean(busy)} onClick={()=>onCall(friend)} aria-label={`Позвонить ${friend.username}`} title="Позвонить"><Phone size={19}/></button>{removeId===friend.id?<div className="friend-remove-confirm"><span>Удалить из друзей?</span><button disabled={Boolean(busy)} onClick={()=>{onRemove(friend.id);setRemoveId(null);}}>Удалить</button><button onClick={()=>setRemoveId(null)}>Отмена</button></div>:<button className="friend-action danger" disabled={Boolean(busy)} onClick={()=>setRemoveId(friend.id)} aria-label={`Удалить ${friend.username} из друзей`} title="Удалить из друзей"><X size={18}/></button>}</div>)}{!friends.length&&<div className="friends-empty"><Users size={52}/><h2>{search?'Никого не нашли':tab==='online'?'Сейчас тихо':'Ваши друзья будут здесь'}</h2><p>{search?'Попробуйте другой никнейм.':tab==='online'?'Позвонить другу можно из вкладки «Все».':'Добавьте друга по никнейму, чтобы общаться и звонить напрямую.'}</p>{!search&&tab==='all'&&<button className="primary" onClick={()=>setTab('add')}><UserPlus size={17}/>Добавить в друзья</button>}</div>}</>}
    </div>
  </section>;
}
