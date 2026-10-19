import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, LoaderCircle, Pencil, Pin, PinOff, SmilePlus, Trash2, X } from 'lucide-react';
import { api } from './api';
import './message-content.css';

export type MessageData = {
  id: number;
  channelId: string;
  content: string;
  createdAt: string;
  user: { id: string; username: string; role?: string };
  editedAt?: string | null;
  pinned?: boolean;
  revision?: number;
  reactions?: { emoji: string; count: number; userIds: string[] }[];
};

type MessageContentProps = {
  message: MessageData;
  currentUserId: string;
  canModerate: boolean;
  onUpdated: (message: MessageData) => void;
  onDeleted: (id: number) => void;
  onError: (message: string) => void;
};

const REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🔥', '👀'];
type MessageAction = 'edit' | 'delete' | 'pin' | 'unpin' | 'react';

export function MessageContent({ message, currentUserId, canModerate, onUpdated, onDeleted, onError }: MessageContentProps) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(message.content);
  const [confirmDelete, setConfirmDelete] = useState(false), [pickerOpen, setPickerOpen] = useState(false), [busy, setBusy] = useState(false);
  const busyRef = useRef(false), mounted = useRef(true), inputRef = useRef<HTMLTextAreaElement>(null), pickerRef = useRef<HTMLDivElement>(null);
  const editorId = useId(), pickerId = useId();
  const own = message.user.id === currentUserId;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
    }
  }, [editing]);
  useEffect(() => {
    if (!pickerOpen) return;
    function outside(event: PointerEvent) { if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false); }
    function escape(event: globalThis.KeyboardEvent) { if (event.key === 'Escape') setPickerOpen(false); }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [pickerOpen]);

  async function act(action: MessageAction, value?: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await api<{ message?: MessageData; deleted?: boolean; messageId?: number }>(`/channels/${encodeURIComponent(message.channelId)}/messages/${message.id}/action`, {
        action,
        ...(action === 'edit' ? { content: value } : {}),
        ...(action === 'react' ? { emoji: value } : {}),
      });
      if (!mounted.current) return;
      if (response.deleted) onDeleted(message.id);
      else if (response.message) onUpdated(response.message);
      setEditing(false);
      setConfirmDelete(false);
      setPickerOpen(false);
    } catch (error) {
      if (mounted.current) onError(error instanceof Error ? error.message : 'Не удалось изменить сообщение.');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function editorKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); setEditing(false); }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (draft.trim()) void act('edit', draft);
    }
  }

  return <div className={`message-content${editing ? ' is-editing' : ''}`} aria-busy={busy}>
    {message.pinned && <span className="message-pinned-label"><Pin size={11} aria-hidden="true" />Закреплено</span>}
    {editing ? <div className="message-editor">
      <label className="message-editor-label" htmlFor={editorId}>Редактирование сообщения</label>
      <textarea ref={inputRef} id={editorId} value={draft} onChange={event => setDraft(event.target.value)} maxLength={4000} rows={Math.min(8, Math.max(2, draft.split('\n').length))} onKeyDown={editorKey} disabled={busy} />
      <div className="message-editor-footer"><span>Enter — сохранить · Shift + Enter — новая строка</span><button type="button" onClick={() => setEditing(false)} disabled={busy}><X size={13} />Отмена</button><button type="button" className="message-save" onClick={() => void act('edit', draft)} disabled={busy || !draft.trim()}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}Сохранить</button></div>
    </div> : <p className="message-text">{message.content}{message.editedAt && <span className="message-edited" title={`Изменено ${new Date(message.editedAt).toLocaleString('ru-RU')}`}> (изменено)</span>}</p>}
    {!editing && <div className="message-tools" role="group" aria-label="Действия с сообщением">
      <div className="message-reaction-picker-wrap" ref={pickerRef}>
        <button type="button" className={pickerOpen ? 'active' : ''} title="Добавить реакцию" aria-label="Добавить реакцию" aria-expanded={pickerOpen} aria-controls={pickerId} onClick={() => { setConfirmDelete(false); setPickerOpen(value => !value); }} disabled={busy}><SmilePlus size={15} /></button>
        {pickerOpen && <div id={pickerId} className="message-reaction-picker" role="group" aria-label="Выберите реакцию">{REACTIONS.map(emoji => <button key={emoji} type="button" onClick={() => void act('react', emoji)} disabled={busy} aria-label={`Реакция ${emoji}`}>{emoji}</button>)}</div>}
      </div>
      {own && <button type="button" title="Редактировать" aria-label="Редактировать сообщение" onClick={() => { setDraft(message.content); setEditing(true); setConfirmDelete(false); setPickerOpen(false); }} disabled={busy}><Pencil size={14} /></button>}
      {canModerate && <button type="button" title={message.pinned ? 'Открепить' : 'Закрепить'} aria-label={message.pinned ? 'Открепить сообщение' : 'Закрепить сообщение'} onClick={() => void act(message.pinned ? 'unpin' : 'pin')} disabled={busy}>{message.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>}
      {(own || canModerate) && <button type="button" className="message-delete" title="Удалить" aria-label="Удалить сообщение" onClick={() => { setConfirmDelete(value => !value); setPickerOpen(false); }} disabled={busy}><Trash2 size={14} /></button>}
    </div>}
    {confirmDelete && !editing && <div className="message-delete-confirm" role="group" aria-label="Подтвердите удаление"><span>Удалить сообщение для всех?</span><button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}>Отмена</button><button type="button" className="message-delete-confirm-action" onClick={() => void act('delete')} disabled={busy}>{busy ? 'Удаляем…' : 'Удалить'}</button></div>}
    {Boolean(message.reactions?.length) && <div className="message-reactions" role="group" aria-label="Реакции на сообщение">{message.reactions?.map(reaction => {
      const mine = reaction.userIds.includes(currentUserId);
      return <button key={reaction.emoji} type="button" className={`message-reaction${mine ? ' mine' : ''}`} aria-label={`${reaction.emoji}: ${reaction.count}. ${mine ? 'Убрать свою реакцию' : 'Добавить реакцию'}`} aria-pressed={mine} title={mine ? 'Убрать свою реакцию' : 'Добавить реакцию'} disabled={busy} onClick={() => void act('react', reaction.emoji)}><span>{reaction.emoji}</span><b>{reaction.count}</b></button>;
    })}</div>}
  </div>;
}
