import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Pin, RefreshCw } from 'lucide-react';
import { api } from './api';
import { MessageContent, type MessageData } from './MessageContent';
import './pinned-messages.css';

type PinnedMessagesProps = {
  channelId: string;
  currentUserId: string;
  canModerate: boolean;
  onUpdated: (message: MessageData) => void;
  onDeleted: (id: number) => void;
  onError: (message: string) => void;
  /** Increment for each message-updated or message-deleted event in this channel. */
  liveRevision?: number;
  deletedMessageIds?: ReadonlySet<number>;
};

export function PinnedMessages({ channelId, currentUserId, canModerate, onUpdated, onDeleted, onError, liveRevision = 0, deletedMessageIds: externalDeletedIds }: PinnedMessagesProps) {
  const [messages, setMessages] = useState<MessageData[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const requestGeneration = useRef(0), previousChannel = useRef(channelId), onErrorRef = useRef(onError), externalDeletedRef = useRef(externalDeletedIds);
  const latestMessages = useRef(new Map<number, MessageData>()), deletedIds = useRef(new Set<number>());
  onErrorRef.current = onError;
  externalDeletedRef.current = externalDeletedIds;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    let active = true;
    if (previousChannel.current !== channelId) {
      previousChannel.current = channelId;
      latestMessages.current.clear();
      deletedIds.current.clear();
      setMessages([]);
    }
    setLoading(true);
    setError('');
    api<{ messages: MessageData[] }>(`/channels/${encodeURIComponent(channelId)}/pins`).then(data => {
      if (!active || requestGeneration.current !== generation) return;
      const next = data.messages.filter(message => !deletedIds.current.has(message.id) && !externalDeletedRef.current?.has(message.id)).map(message => {
        const latest = latestMessages.current.get(message.id);
        const chosen = latest && (latest.revision || 0) > (message.revision || 0) ? latest : message;
        latestMessages.current.set(message.id, chosen);
        return chosen;
      }).filter(message => message.pinned);
      setMessages(next);
    }).catch(reason => {
      if (!active || requestGeneration.current !== generation) return;
      const text = reason instanceof Error ? reason.message : 'Не удалось загрузить закреплённые сообщения.';
      setError(text);
      onErrorRef.current(text);
    }).finally(() => {
      if (active && requestGeneration.current === generation) setLoading(false);
    });
    return () => { active = false; };
  }, [channelId, liveRevision, retry]);

  function updateMessage(message: MessageData) {
    if (message.channelId !== channelId) return;
    if (deletedIds.current.has(message.id) || externalDeletedRef.current?.has(message.id)) return;
    const latest = latestMessages.current.get(message.id);
    if (latest && (latest.revision || 0) > (message.revision || 0)) return;
    latestMessages.current.set(message.id, message);
    ++requestGeneration.current;
    setLoading(false);
    setError('');
    setMessages(old => {
      if (!message.pinned) return old.filter(item => item.id !== message.id);
      const exists = old.some(item => item.id === message.id);
      return (exists ? old.map(item => item.id === message.id ? message : item) : [...old, message]).sort((a, b) => b.id - a.id);
    });
    onUpdated(message);
  }

  function deleteMessage(id: number) {
    deletedIds.current.add(id);
    latestMessages.current.delete(id);
    ++requestGeneration.current;
    setLoading(false);
    setError('');
    setMessages(old => old.filter(message => message.id !== id));
    onDeleted(id);
  }

  return <section className="pinned-messages" aria-label="Закреплённые сообщения" aria-busy={loading}>
    <div className="pinned-messages-summary"><span><Pin size={16} aria-hidden="true" /><strong>Закреплённые сообщения</strong>{!loading && !error && <b>{messages.length}</b>}</span><button type="button" title="Обновить список" aria-label="Обновить закреплённые сообщения" onClick={() => setRetry(value => value + 1)} disabled={loading}>{loading ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}</button></div>
    {error && <div className="pinned-messages-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)} disabled={loading}>Повторить</button></div>}
    {loading && messages.length === 0 && <div className="pinned-messages-loading" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true" /><span>Загружаем сообщения…</span></div>}
    {!loading && !error && messages.length === 0 && <div className="pinned-messages-empty"><span><Pin size={25} aria-hidden="true" /></span><strong>Здесь будут важные сообщения</strong><p>{canModerate ? 'Нажмите на значок булавки рядом с сообщением, чтобы закрепить его для всех участников канала.' : 'Администраторы канала могут закреплять здесь важные сообщения.'}</p></div>}
    <div className="pinned-messages-list">{messages.map(message => <article key={`${message.channelId}:${message.id}`} className="message pinned-message">
      <div className="pinned-message-avatar" aria-hidden="true">{message.user.username.slice(0, 2).toUpperCase()}</div>
      <div className="message-body"><div className="message-author"><strong>{message.user.username}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div><MessageContent message={message} currentUserId={currentUserId} canModerate={canModerate} onUpdated={updateMessage} onDeleted={deleteMessage} onError={onError} /></div>
    </article>)}</div>
  </section>;
}
