import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Ban, Check, Crown, LoaderCircle, LogOut, MicOff, Settings, Shield, ShieldOff, Trash2, UserRoundMinus, Users } from 'lucide-react';
import { api } from './api';
import './channel-settings.css';

type ChannelRole = 'owner' | 'admin' | 'member';
export type ManagedChannel = {
    id: string;
    name: string;
    description: string;
    ownerId: string;
    role: ChannelRole;
};
type Member = { id: string; username: string; role: ChannelRole; muted: boolean };
type BannedMember = { id: string; username: string };
type MemberAction = 'promote' | 'demote' | 'kick' | 'ban' | 'unban' | 'mute' | 'unmute';
type Confirmation = { action: 'kick' | 'ban'; member: Member } | { action: 'delete' } | { action: 'leave' };
type RequestScope = { id: string; active: boolean; revision: number };
type Props = {
    channel: ManagedChannel;
    userId: string;
    onChanged: (channel?: ManagedChannel) => void;
    onLeft: () => void;
    onError: (message: string) => void;
};

const roleNames: Record<ChannelRole, string> = { owner: 'Владелец', admin: 'Администратор', member: 'Участник' };
const roleOrder: Record<ChannelRole, number> = { owner: 0, admin: 1, member: 2 };

export function ChannelSettings({ channel, userId, onChanged, onLeft, onError }: Props) {
    const canManage = channel.role === 'owner' || channel.role === 'admin';
    const isOwner = channel.role === 'owner';
    const [tab, setTab] = useState<'settings' | 'members' | 'bans'>('settings');
    const [name, setName] = useState(channel.name), [description, setDescription] = useState(channel.description);
    const [members, setMembers] = useState<Member[]>([]), [bans, setBans] = useState<BannedMember[]>([]);
    const [loading, setLoading] = useState(true), [working, setWorking] = useState<string | null>(null);
    const [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const scopeRef = useRef<RequestScope | null>(null), visibleChannelId = useRef(channel.id);
    const cancelRef = useRef<HTMLButtonElement>(null);
    visibleChannelId.current = channel.id;
    const isCurrent = (scope: RequestScope) => scope.active && scopeRef.current === scope && visibleChannelId.current === scope.id;

    async function loadMembers(scope: RequestScope, includeBans: boolean) {
        const revision = ++scope.revision;
        if (isCurrent(scope)) setLoading(true);
        try {
            const [memberData, banData] = await Promise.all([
                api<{ members: Member[] }>(`/channels/${encodeURIComponent(scope.id)}/members`),
                includeBans ? api<{ bans: BannedMember[] }>(`/channels/${encodeURIComponent(scope.id)}/bans`) : Promise.resolve({ bans: [] }),
            ]);
            if (!isCurrent(scope) || revision !== scope.revision) return;
            setMembers(memberData.members.slice().sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.username.localeCompare(b.username)));
            setBans(banData.bans.slice().sort((a, b) => a.username.localeCompare(b.username)));
        } catch (cause) {
            if (isCurrent(scope) && revision === scope.revision) setError((cause as Error).message);
        } finally {
            if (isCurrent(scope) && revision === scope.revision) setLoading(false);
        }
    }

    useEffect(() => {
        const scope = { id: channel.id, active: true, revision: 0 };
        scopeRef.current = scope;
        setTab('settings');
        setName(channel.name);
        setDescription(channel.description);
        setMembers([]);
        setBans([]);
        setWorking(null);
        setConfirmation(null);
        setError('');
        setNotice('');
        void loadMembers(scope, canManage);
        return () => { scope.active = false; };
    }, [channel.id, channel.role]);

    useEffect(() => { if (confirmation) cancelRef.current?.focus(); }, [confirmation]);

    async function mutate(key: string, path: string, body: unknown, success: string, exit = false) {
        const scope = scopeRef.current;
        if (!scope || !isCurrent(scope) || working) return;
        setWorking(key);
        setError('');
        setNotice('');
        try {
            const result = await api<{ channel?: ManagedChannel } | undefined>(`/channels/${encodeURIComponent(scope.id)}${path}`, body);
            if (!isCurrent(scope)) return;
            setConfirmation(null);
            if (exit) {
                onLeft();
                return;
            }
            if (result?.channel) {
                setName(result.channel.name);
                setDescription(result.channel.description);
            }
            setNotice(success);
            onChanged(result?.channel);
            await loadMembers(scope, canManage);
        } catch (cause) {
            if (!isCurrent(scope)) return;
            const message = (cause as Error).message;
            setError(message);
            onError(message);
        } finally {
            if (isCurrent(scope)) setWorking(null);
        }
    }

    async function saveSettings(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!canManage) return;
        await mutate('settings', '/settings', { name: name.trim(), description: description.trim() }, 'Настройки канала сохранены.');
    }

    function memberAction(member: Member | BannedMember, action: MemberAction) {
        const messages: Record<MemberAction, string> = {
            promote: `${member.username} теперь администратор канала.`,
            demote: `${member.username} теперь участник канала.`,
            kick: `${member.username} исключён из канала.`,
            ban: `${member.username} заблокирован в канале.`,
            unban: `Блокировка ${member.username} снята. Для возвращения понадобится приглашение.`,
            mute: `Передача звука, видео и экрана для ${member.username} отключена.`,
            unmute: `${member.username} снова может передавать звук, видео и экран.`,
        };
        void mutate(`${action}:${member.id}`, `/members/${encodeURIComponent(member.id)}`, { action }, messages[action]);
    }

    function confirmAction() {
        if (!confirmation) return;
        if (confirmation.action === 'delete') void mutate('delete', '/delete', {}, '', true);
        else if (confirmation.action === 'leave') void mutate('leave', '/leave', {}, '', true);
        else memberAction(confirmation.member, confirmation.action);
    }

    const confirmationTitle = confirmation?.action === 'delete' ? `Удалить канал «${channel.name}»?`
        : confirmation?.action === 'leave' ? `Покинуть канал «${channel.name}»?`
        : confirmation?.action === 'ban' ? `Заблокировать ${confirmation.member.username}?`
        : confirmation ? `Исключить ${confirmation.member.username}?` : '';
    const confirmationDescription = confirmation?.action === 'delete' ? 'Канал, его история сообщений, приглашения и список участников будут удалены для всех. Отменить удаление нельзя.'
        : confirmation?.action === 'leave' ? 'Канал исчезнет из вашего списка. Для возвращения понадобится новое приглашение.'
        : confirmation?.action === 'ban' ? 'Пользователь потеряет доступ к каналу и звонку. Принять приглашение снова он сможет после снятия блокировки.'
        : 'Пользователь потеряет доступ к каналу и звонку. Позже он сможет вернуться по приглашению.';
    const confirmationLabel = confirmation?.action === 'delete' ? 'Удалить канал' : confirmation?.action === 'leave' ? 'Покинуть канал' : confirmation?.action === 'ban' ? 'Заблокировать' : 'Исключить';

    return <section className="channel-settings" aria-label={`Управление каналом ${channel.name}`}>
        <div className="channel-settings-heading"><span className="channel-settings-icon"><Settings size={21}/></span><div><h2>Настройки канала</h2><p>#{channel.name}</p></div><span className={`channel-role role-${channel.role}`}>{isOwner ? <Crown size={12}/> : canManage ? <Shield size={12}/> : null}{roleNames[channel.role]}</span></div>
        <nav className="channel-settings-tabs" aria-label="Разделы настроек канала">
            <button type="button" className={tab === 'settings' ? 'active' : ''} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => { setTab('settings'); setConfirmation(null); }}><Settings size={15}/>Основное</button>
            <button type="button" className={tab === 'members' ? 'active' : ''} aria-current={tab === 'members' ? 'page' : undefined} onClick={() => { setTab('members'); setConfirmation(null); }}><Users size={15}/>Участники<span>{members.length}</span></button>
            {canManage && <button type="button" className={tab === 'bans' ? 'active' : ''} aria-current={tab === 'bans' ? 'page' : undefined} onClick={() => { setTab('bans'); setConfirmation(null); }}><Ban size={15}/>Блокировки{bans.length > 0 && <span>{bans.length}</span>}</button>}
        </nav>

        {error && <div className="channel-settings-error" role="alert">{error}</div>}
        {notice && <div className="channel-settings-notice" role="status"><Check size={15}/>{notice}</div>}

        {confirmation && <div className="channel-confirm" role="alertdialog" aria-labelledby="channel-confirm-title" aria-describedby="channel-confirm-description" aria-busy={!!working}>
            <strong id="channel-confirm-title">{confirmationTitle}</strong><p id="channel-confirm-description">{confirmationDescription}</p><div><button type="button" className="channel-action" ref={cancelRef} disabled={!!working} onClick={() => setConfirmation(null)}>Отмена</button><button type="button" className="channel-action destructive" disabled={!!working} onClick={confirmAction}>{working && <LoaderCircle size={14} className="spin"/>}{confirmationLabel}</button></div>
        </div>}

        {tab === 'settings' && <div className="channel-settings-panel">
            <form onSubmit={saveSettings}>
                <label htmlFor="channel-settings-name">Название канала<input id="channel-settings-name" value={name} onChange={event => setName(event.target.value)} maxLength={40} minLength={1} required disabled={!canManage || !!working}/></label>
                <label htmlFor="channel-settings-description">Описание<textarea id="channel-settings-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={180} rows={3} disabled={!canManage || !!working} placeholder="О чём общаемся в этом канале"/></label>
                {canManage ? <button type="submit" className="primary channel-settings-save" disabled={!!working || !name.trim() || (name.trim() === channel.name && description.trim() === channel.description)}>{working === 'settings' ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}Сохранить изменения</button> : <p className="channel-settings-help">Название и описание меняют владелец и администраторы канала.</p>}
            </form>
            {canManage && <div className="channel-permissions"><Shield size={17}/><div><strong>Ваши права в канале</strong><p>{isOwner ? 'Вы можете менять настройки, назначать администраторов, исключать и блокировать участников, управлять передачей в звонке и удалить канал.' : 'Вы можете менять настройки, приглашать участников, исключать и блокировать обычных участников, управлять их передачей в звонке. Администраторов назначает владелец.'}</p></div></div>}
            <div className="channel-danger-zone"><div><strong>{isOwner ? 'Удаление канала' : 'Выход из канала'}</strong><p>{isOwner ? 'Канал и его история будут удалены для всех участников.' : 'Для возвращения потребуется приглашение в канал.'}</p></div><button type="button" className="channel-action destructive" disabled={!!working} onClick={() => setConfirmation({ action: isOwner ? 'delete' : 'leave' })}>{isOwner ? <Trash2 size={15}/> : <LogOut size={15}/>} {isOwner ? 'Удалить канал' : 'Покинуть канал'}</button></div>
        </div>}

        {tab === 'members' && <div className="channel-settings-panel">
            <div className="channel-list-heading"><p>Участники канала</p><button className="channel-action" type="button" disabled={loading || !!working} onClick={() => { const scope = scopeRef.current; if (scope) { setError(''); void loadMembers(scope, canManage); } }}>{loading ? <LoaderCircle size={13} className="spin"/> : null}Обновить</button></div>
            {canManage && <p className="channel-settings-help channel-moderation-help"><MicOff size={14}/>«Отключить передачу» запрещает отправлять звук, видео камеры и экран в звонок. Слушать и писать в чат можно.</p>}
            {loading && members.length === 0 ? <div className="channel-list-empty" role="status"><LoaderCircle size={20} className="spin"/>Загружаем участников…</div> : members.length === 0 ? <div className="channel-list-empty">Участников пока нет.</div> : <ul className="channel-member-list">{members.map(member => {
                const isSelf = member.id === userId;
                const canModerate = !isSelf && member.role !== 'owner' && (isOwner || (channel.role === 'admin' && member.role === 'member'));
                return <li key={member.id} className="channel-member">
                    <div className="channel-member-identity"><span className="channel-member-avatar" aria-hidden="true">{member.username.slice(0, 2).toUpperCase()}</span><div><strong>{member.username}{isSelf && <small>это вы</small>}</strong><div className="channel-member-badges"><span className={`channel-role role-${member.role}`}>{member.role === 'owner' ? <Crown size={11}/> : member.role === 'admin' ? <Shield size={11}/> : null}{roleNames[member.role]}</span>{member.muted && <span className="channel-muted-badge"><MicOff size={11}/>Передача отключена</span>}</div></div></div>
                    {(canModerate || (isOwner && !isSelf && member.role !== 'owner')) && <div className="channel-member-actions">
                        {isOwner && !isSelf && member.role !== 'owner' && <button type="button" className="channel-action" disabled={!!working || !!confirmation} onClick={() => memberAction(member, member.role === 'admin' ? 'demote' : 'promote')} title={member.role === 'admin' ? `Снять права администратора у ${member.username}` : `Назначить ${member.username} администратором`}>{member.role === 'admin' ? <ShieldOff size={14}/> : <Shield size={14}/>}<span>{member.role === 'admin' ? 'Снять права' : 'Назначить администратором'}</span></button>}
                        {canModerate && <><button type="button" className="channel-action" disabled={!!working || !!confirmation} onClick={() => memberAction(member, member.muted ? 'unmute' : 'mute')} title={member.muted ? `Разрешить передачу звука, видео и экрана для ${member.username}` : `Запретить передачу звука, видео и экрана для ${member.username}`}><MicOff size={14}/><span>{member.muted ? 'Разрешить передачу' : 'Отключить передачу'}</span></button><button type="button" className="channel-action destructive" disabled={!!working || !!confirmation} onClick={() => setConfirmation({ action: 'kick', member })}><UserRoundMinus size={14}/>Исключить</button><button type="button" className="channel-action destructive" disabled={!!working || !!confirmation} onClick={() => setConfirmation({ action: 'ban', member })}><Ban size={14}/>Блокировать</button></>}
                    </div>}
                </li>;
            })}</ul>}
        </div>}

        {tab === 'bans' && canManage && <div className="channel-settings-panel"><div className="channel-list-heading"><p>Заблокированы в этом канале</p><button type="button" className="channel-action" disabled={loading || !!working} onClick={() => { const scope = scopeRef.current; if (scope) { setError(''); void loadMembers(scope, true); } }}>{loading && <LoaderCircle size={13} className="spin"/>}Обновить</button></div><p className="channel-settings-help">После снятия блокировки пользователь сможет снова принять приглашение. Само снятие блокировки не добавляет его в канал.</p>{loading && bans.length === 0 ? <div className="channel-list-empty" role="status"><LoaderCircle size={20} className="spin"/>Загружаем блокировки…</div> : bans.length === 0 ? <div className="channel-list-empty"><Shield size={24}/>В этом канале нет заблокированных пользователей.</div> : <ul className="channel-member-list">{bans.map(member => <li key={member.id} className="channel-member"><div className="channel-member-identity"><span className="channel-member-avatar" aria-hidden="true">{member.username.slice(0, 2).toUpperCase()}</span><strong>{member.username}</strong></div><button type="button" className="channel-action" disabled={!!working || !!confirmation} onClick={() => memberAction(member, 'unban')}><ShieldOff size={14}/>Снять блокировку</button></li>)}</ul>}</div>}
    </section>;
}
