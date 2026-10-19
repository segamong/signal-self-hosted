import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AtSign, Check, CheckCircle2, Hash, Inbox as InboxIcon, LoaderCircle, Send, X } from 'lucide-react';
import { api } from './api';
import './invitations.css';

export type Invitation = {
  id: string;
  channel: { id: string; name: string; description: string };
  inviter: { id: string; username: string };
  createdAt: string;
  expiresAt: string;
  status: string;
};

export type InvitationAction = 'accept' | 'decline';

type ChannelInvitationFormProps = {
  channelId: string;
  channelName: string;
  onError: (message: string) => void;
};

export function ChannelInvitationForm({ channelId, channelName, onError }: ChannelInvitationFormProps) {
  const fieldId = useId();
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const generationRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    generationRef.current += 1;
    pendingRef.current = null;
    setUsername('');
    setSentTo('');
    setBusy(false);
    return () => { generationRef.current += 1; };
  }, [channelId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current !== null) return;
    const target = username.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(target)) {
      onError('Укажите никнейм: от 3 до 32 латинских букв, цифр, знаков _ или -.');
      inputRef.current?.focus();
      return;
    }
    const generation = generationRef.current;
    pendingRef.current = generation;
    setBusy(true);
    setSentTo('');
    try {
      await api<unknown>(`/channels/${encodeURIComponent(channelId)}/invitations`, { username: target });
      if (generationRef.current !== generation) return;
      setSentTo(target);
      setUsername('');
      inputRef.current?.focus();
    } catch (error) {
      if (generationRef.current !== generation) return;
      onError(error instanceof Error ? error.message : 'Не удалось отправить приглашение.');
    } finally {
      if (generationRef.current === generation) {
        pendingRef.current = null;
        setBusy(false);
      }
    }
  }

  return <form className="channel-invitation-form" onSubmit={submit} aria-busy={busy}>
    <div className="channel-invitation-heading">
      <span className="channel-invitation-symbol" aria-hidden="true"><AtSign size={18} /></span>
      <div><h3>Пригласить по никнейму</h3><p>В канал <strong>#{channelName}</strong></p></div>
    </div>
    <label className="channel-invitation-label" htmlFor={fieldId}>Никнейм</label>
    <div className="channel-invitation-input-row">
      <div className="channel-invitation-input-wrap">
        <span aria-hidden="true">@</span>
        <input
          ref={inputRef}
          id={fieldId}
          name="invitationUsername"
          value={username}
          onChange={event => { setUsername(event.target.value); setSentTo(''); }}
          placeholder="username"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={33}
          disabled={busy}
          required
          aria-describedby={`${fieldId}-help`}
        />
      </div>
      <button type="submit" className="primary channel-invitation-submit" disabled={busy || !username.trim()}>
        {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        {busy ? 'Отправляем…' : 'Пригласить'}
      </button>
    </div>
    <p id={`${fieldId}-help`} className="channel-invitation-help">Укажите никнейм, выбранный при регистрации. Получатель сам примет или отклонит приглашение.</p>
    {sentTo && <p className="channel-invitation-success" role="status">
      <CheckCircle2 size={17} aria-hidden="true" />
      <span>Приглашение для <strong>@{sentTo}</strong> отправлено.</span>
    </p>}
  </form>;
}

type InboxProps = {
  invitations: Invitation[];
  onRespond: (id: string, action: InvitationAction) => void | Promise<void>;
  onClose?: () => void;
  busyId: string | null;
};

const expirationFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function expirationLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Срок действия недоступен' : `Действует до ${expirationFormatter.format(date)}`;
}

function invitationState(invitation: Invitation) {
  if (invitation.status === 'accepted') return 'Принято';
  if (invitation.status === 'declined') return 'Отклонено';
  if (invitation.status === 'revoked') return 'Отозвано';
  if (invitation.status === 'expired' || Date.parse(invitation.expiresAt) <= Date.now()) return 'Срок истёк';
  return invitation.status === 'pending' ? '' : 'Недоступно';
}

export function Inbox({ invitations, onRespond, onClose, busyId }: InboxProps) {
  const [responseError, setResponseError] = useState('');
  const activeRequests = useRef(new Set<string>());

  async function respond(id: string, action: InvitationAction) {
    if (activeRequests.current.has(id)) return;
    activeRequests.current.add(id);
    setResponseError('');
    try {
      await onRespond(id, action);
    } catch (error) {
      setResponseError(error instanceof Error ? error.message : 'Не удалось ответить на приглашение.');
    } finally {
      activeRequests.current.delete(id);
    }
  }

  return <section className="invitation-inbox" aria-label="Приглашения в каналы">
    {responseError && <p className="form-error invitation-inbox-error" role="alert">{responseError}</p>}
    {invitations.length === 0 ? <div className="invitation-inbox-empty">
      <span className="invitation-inbox-empty-icon" aria-hidden="true"><InboxIcon size={28} /></span>
      <h3>Пока нет приглашений</h3>
      <p>Когда вас пригласят по имени аккаунта, приглашение появится здесь. Вы сможете решить, вступать ли в канал.</p>
    </div> : <>
      <p className="invitation-inbox-intro">Вступайте в каналы, в которых хотите общаться.</p>
      <ul className="invitation-inbox-list">
        {invitations.map(invitation => {
          const unavailable = invitationState(invitation);
          const busy = busyId === invitation.id;
          return <li className="invitation-inbox-card" key={invitation.id} aria-busy={busy}>
            <div className="invitation-inbox-card-heading">
              <span className="invitation-inbox-channel-icon" aria-hidden="true"><Hash size={20} /></span>
              <div className="invitation-inbox-channel-info">
                <h3>#{invitation.channel.name}</h3>
                <p>Приглашает <strong>@{invitation.inviter.username}</strong></p>
              </div>
            </div>
            {invitation.channel.description && <p className="invitation-inbox-description">{invitation.channel.description}</p>}
            <p className="invitation-inbox-expiry"><time dateTime={invitation.expiresAt}>{expirationLabel(invitation.expiresAt)}</time></p>
            {unavailable ? <span className="invitation-inbox-state">{unavailable}</span> : <div className="invitation-inbox-actions">
              <button type="button" className="primary" disabled={busy} onClick={() => { void respond(invitation.id, 'accept'); }}>
                {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                {busy ? 'Отвечаем…' : 'Принять'}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => { void respond(invitation.id, 'decline'); }}>
                <X size={16} aria-hidden="true" />Отклонить
              </button>
            </div>}
          </li>;
        })}
      </ul>
    </>}
    {onClose && <div className="invitation-inbox-footer"><button type="button" className="secondary" onClick={onClose}>Готово</button></div>}
  </section>;
}
