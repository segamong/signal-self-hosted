import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioLines, ArrowRight, Bell, Check, Copy, Download, Hash, Headphones, Link2, LogOut, Menu, MessageSquare, Minus, Pin, Plus, Radio, Send, Settings, ShieldCheck, Square, Users, Volume2, X } from 'lucide-react';
import { api, invitationCode, SERVER_ORIGIN } from './api';
import './styles.css';
import { ChannelInvitationForm, Inbox, type Invitation, type InvitationAction } from './Invitations';
import { DesktopUpdates, UpdateDialog } from './DesktopUpdates';
import { ChannelSettings } from './ChannelSettings';
import { UserProfile } from './UserProfile';
import { MessageContent, type MessageData } from './MessageContent';
import { PinnedMessages } from './PinnedMessages';
import AndroidCallStage, { androidCommand } from './AndroidCallStage';
import { clearCallSession, readCallSession, saveCallSession, DEFAULT_CALL_PREFERENCES, type CallPreferences } from './callSession';
const CallStage = lazy(() => import('./CallStage'));
type User = {
    id: string;
    username: string;
    role: string;
};
type Channel = {
    id: string;
    name: string;
    description: string;
    ownerId: string;
    role: 'owner' | 'admin' | 'member';
};
type Message = MessageData;
type Config = {
    name: string;
    maxParticipants: number;
    mediaConfigured: boolean;
};
type RoomInfo = {
    id: string;
    participants: {
        id: string;
        displayName: string;
    }[];
};
type InviteInfo = {
    channel: {
        id: string;
        name: string;
    };
    expiresAt: string;
    valid: boolean;
};
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
function Avatar({ user, small = false }: {
    user: Pick<User, 'id' | 'username'>;
    small?: boolean;
}) { return <span className={`avatar avatar-${[...user.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 5}${small ? ' small' : ''}`}>{initials(user.username)}</span>; }
function Brand({ compact = false }: {
    compact?: boolean;
}) { return <span className={`brand${compact ? ' compact' : ''}`}><span className="brand-mark"><AudioLines size={24}/></span>{!compact && <span>сигнал<span className="brand-dot">.</span></span>}</span>; }
function DesktopFrame({ children }: {
    children: ReactNode;
}) {
    const desktop = window.signalDesktop;
    const [updatesOpen, setUpdatesOpen] = useState(false);
    return <div className={desktop ? 'desktop-frame' : 'web-frame'}>{desktop && <header className="desktop-titlebar"><div><AudioLines size={15}/><strong>Сигнал</strong><span>свой круг общения</span></div><nav aria-label="Управление окном"><button className="titlebar-update" onClick={() => setUpdatesOpen(true)} title="Обновить приложение" aria-label="Обновить приложение"><Download size={15}/><span>Обновление</span></button><button onClick={() => desktop.windowAction('minimize')} aria-label="Свернуть"><Minus size={15}/></button><button onClick={() => desktop.windowAction('maximize')} aria-label="Развернуть"><Square size={12}/></button><button className="window-close" onClick={() => desktop.windowAction('close')} aria-label="Закрыть"><X size={16}/></button></nav></header>}<div className="frame-content">{children}</div>{updatesOpen && <UpdateDialog onClose={() => setUpdatesOpen(false)}/>}</div>;
}
function Auth({ onLogin, pendingInvite }: {
    onLogin: (user: User) => void;
    pendingInvite: boolean;
}) {
    const [register, setRegister] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError('');
        const values = Object.fromEntries(new FormData(event.currentTarget));
        try {
            const data = await api<{
                user: User;
            }>(register ? '/register' : '/login', values);
            onLogin(data.user);
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="auth-shell"><div className="auth-story"><Brand /><span className="eyebrow"><span className="green-dot"/> СВОЁ ПРОСТРАНСТВО ДЛЯ ОБЩЕНИЯ</span><h1>Ближе.<br />Даже на<br /><em>расстоянии.</em></h1><p>Голос, видео и ваш экран. На вашем сервере, без подписок.</p><div className="signal-art" aria-hidden="true">{Array.from({ length: 29 }, (_, i) => <i key={i} style={{ height: `${18 + Math.abs(Math.sin(i * .53)) * 110}px`, opacity: .25 + Math.abs(Math.cos(i * .4)) * .7 }}/>)}</div><div className="auth-footer"><ShieldCheck size={16}/> Ваш сервер. Ваш круг общения.</div></div><main className="auth-main"><div className="auth-card"><span className="auth-icon"><Radio size={28}/></span><h2>{register ? 'На одной частоте' : 'С возвращением'}</h2><p>{pendingInvite ? 'Войдите или создайте аккаунт, чтобы принять приглашение в канал.' : register ? 'Создайте личный аккаунт и соберите свой круг.' : 'Войдите в свой аккаунт, чтобы продолжить общение.'}</p><div className="auth-tabs"><button type="button" className={!register ? 'active' : ''} onClick={() => { setRegister(false); setError(''); }}>Войти</button><button type="button" className={register ? 'active' : ''} onClick={() => { setRegister(true); setError(''); }}>Создать аккаунт</button></div><form onSubmit={submit}><label>Никнейм<input name="username" autoComplete="username" placeholder="your_name" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_-]{3,32}"/></label><label>Пароль<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'Не меньше 12 символов' : 'Ваш пароль'} required minLength={register ? 12 : 1} maxLength={128}/></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary auth-submit" disabled={busy}>{busy ? 'Подключаемся…' : register ? 'Создать аккаунт' : 'Войти в Сигнал'}<ArrowRight size={17}/></button></form><p className="auth-hint">Для регистрации приглашение не нужно. Каналы добавляются отдельно.</p></div><span className="auth-bottom">Хорошие разговоры начинаются с простого «привет».</span></main></div>;
}
function App() {
    const [user, setUser] = useState<User | null>(null), [booting, setBooting] = useState(true), [bootError, setBootError] = useState('');
    const [config, setConfig] = useState<Config>({ name: 'Сигнал', maxParticipants: 10, mediaConfigured: false });
    const [channels, setChannels] = useState<Channel[]>([]), [selected, setSelected] = useState('');
    const [messages, setMessages] = useState<Message[]>([]), [hasMore, setHasMore] = useState(false), [loading, setLoading] = useState(false);
    const [online, setOnline] = useState<User[]>([]), [socketLive, setSocketLive] = useState(false), [rooms, setRooms] = useState<RoomInfo[]>([]);
    const [call, setCall] = useState<Channel | null>(null), [membersOpen, setMembersOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches), [sidebarOpen, setSidebarOpen] = useState(false);
    const [channelsLoaded, setChannelsLoaded] = useState(false), [initialCallPreferences, setInitialCallPreferences] = useState<CallPreferences>(DEFAULT_CALL_PREFERENCES);
    const restoredCallUser = useRef<string | null>(null), callPreferences = useRef<CallPreferences>(DEFAULT_CALL_PREFERENCES), callIdRef = useRef(call?.id);
    const channelsRevision = useRef(0);
    const messageOverrides = useRef(new Map<number, Message>()), deletedMessageIds = useRef(new Set<number>());
    const [messageRevision, setMessageRevision] = useState(0);
    function newestMessage(left: Message | undefined, right: Message) {
        return left && (left.revision || 0) > (right.revision || 0) ? left : right;
    }
    function mergeMessages(...groups: Message[][]) {
        const merged = new Map<number, Message>();
        for (const message of groups.flat()) {
            if (deletedMessageIds.current.has(message.id)) continue;
            const current = newestMessage(messageOverrides.current.get(message.id), message);
            merged.set(message.id, newestMessage(merged.get(message.id), current));
        }
        return [...merged.values()].sort((a, b) => a.id - b.id);
    }
    function updateMessage(message: Message) {
        if (deletedMessageIds.current.has(message.id)) return;
        const current = newestMessage(messageOverrides.current.get(message.id), message);
        messageOverrides.current.set(message.id, current);
        setMessageRevision(value => value + 1);
        if (current.channelId === selectedRef.current) setMessages(old => old.map(item => item.id === current.id ? newestMessage(item, current) : item));
    }
    function deleteMessage(id: number) {
        deletedMessageIds.current.add(id);
        messageOverrides.current.delete(id);
        setMessageRevision(value => value + 1);
        setMessages(old => old.filter(message => message.id !== id));
    }
    const [modal, setModal] = useState<'invite' | 'channel' | 'join' | 'settings' | 'inbox' | 'channel-settings' | 'profile' | 'pins' | null>(null), [invite, setInvite] = useState(''), [copied, setCopied] = useState(false), [modalBusy, setModalBusy] = useState(false);
    const [joinValue, setJoinValue] = useState(() => new URLSearchParams(location.search).get('invite') || ''), [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null), [joinError, setJoinError] = useState('');
    const [profileUser, setProfileUser] = useState<{
        id: string;
        username: string;
        role?: 'owner' | 'admin' | 'member';
    } | null>(null), [channelMembers, setChannelMembers] = useState<{
        id: string;
        username: string;
        role: 'owner' | 'admin' | 'member';
        muted: boolean;
    }[]>([]);
    const [invitations, setInvitations] = useState<Invitation[]>([]), [busyInvitation, setBusyInvitation] = useState<string | null>(null);
    const invitationRevision = useRef(0), respondingInvitation = useRef(false), authUserId = useRef(user?.id);
    authUserId.current = user?.id;
    const [desktopSettings, setDesktopSettings] = useState({ openAtLogin: false, closeToTray: true });
    const [error, setError] = useState(''), [sending, setSending] = useState(false), [draft, setDraft] = useState('');
    const selectedRef = useRef(selected), bottomRef = useRef<HTMLDivElement>(null), historyRef = useRef<HTMLDivElement>(null), modalRef = useRef<HTMLElement>(null), olderScroll = useRef<{
        height: number;
        top: number;
    } | null>(null), scrollNext = useRef(true), requestVersion = useRef(0);
    selectedRef.current = selected;
    const channel = channels.find(c => c.id === selected);
    const count = (id: string) => rooms.find(r => r.id === id)?.participants.length || 0;
    const updateChannels = (next: Channel[]) => { channelsRevision.current++; setChannelsLoaded(true); setChannels(next); setSelected(old => next.some(c => c.id === old) ? old : next[0]?.id || ''); };
    function mutateChannels(action: (old: Channel[]) => Channel[]) { channelsRevision.current++; setChannels(action); }
    const canManageChannel = channel?.role === 'owner' || channel?.role === 'admin';
    function stopCall() { androidCommand({type:'leaveCall'}); callIdRef.current = undefined; clearCallSession(); setCall(null); callPreferences.current = DEFAULT_CALL_PREFERENCES; setInitialCallPreferences(DEFAULT_CALL_PREFERENCES); }
    function startCall(next: Channel) {
        if (!user)
            return;
        if (call && call.id !== next.id) {
            setError('Сначала завершите текущий звонок.');
            return;
        }
        if (call?.id === next.id) {
            androidCommand({type:'openCall',channelId:next.id,channelName:next.name});
            return;
        }
        callIdRef.current = next.id;
        callPreferences.current = { ...DEFAULT_CALL_PREFERENCES };
        setInitialCallPreferences(callPreferences.current);
        saveCallSession(user.id, next.id, callPreferences.current);
        setCall(next);
        androidCommand({type:'openCall',channelId:next.id,channelName:next.name});
    }
    function persistCallPreferences(preferences: CallPreferences) { if (!user || !call || callIdRef.current !== call.id || authUserId.current !== user.id)
        return; callPreferences.current = preferences; saveCallSession(user.id, call.id, preferences); }
    useEffect(() => {
        if (booting || bootError)
            return;
        if (!user) {
            clearCallSession();
            return;
        }
        if (!channelsLoaded || restoredCallUser.current === user.id)
            return;
        restoredCallUser.current = user.id;
        const saved = readCallSession(user.id);
        if (!saved)
            return;
        const next = channels.find(item => item.id === saved.channelId);
        if (!next) {
            clearCallSession();
            return;
        }
        callIdRef.current = next.id;
        callPreferences.current = saved.preferences;
        setInitialCallPreferences(saved.preferences);
        setCall(next);
        setSelected(next.id);
    }, [user, booting, bootError, channelsLoaded, channels]);
    useEffect(() => {
        if (!call || !channelsLoaded)
            return;
        if (!channels.some(item => item.id === call.id))
            stopCall();
    }, [channels, channelsLoaded, call]);
    useEffect(() => {
        if (!call || !user)
            return;
        const save = () => { if (callIdRef.current === call.id && authUserId.current === user.id)
            saveCallSession(user.id, call.id, callPreferences.current); };
        const timer = setInterval(save, 30000);
        window.addEventListener('pagehide', save);
        return () => { clearInterval(timer); window.removeEventListener('pagehide', save); };
    }, [call, user]);
    useEffect(() => {
        Promise.all([api<{
                user: User | null;
            }>('/me'), api<Config>('/config')]).then(([me, cfg]) => { setUser(me.user); setConfig(cfg); }).catch(e => setBootError(e.message)).finally(() => setBooting(false));
    }, []);
    useEffect(() => {
        const desktop = window.signalDesktop;
        if (!desktop)
            return;
        void desktop.getSettings().then(setDesktopSettings).catch(() => { });
        return desktop.subscribeEvents(event => {
            if (event.type === 'invite' && typeof event.code === 'string') {
                setJoinValue(event.code);
                setInviteInfo(null);
                setJoinError('');
                setModal('join');
            }
        });
    }, []);
    useEffect(() => {
        if (user && joinValue)
            setModal('join');
    }, [user]);
    useEffect(() => {
        if (!user) {
            setChannelsLoaded(false);
            restoredCallUser.current = null;
            setChannels([]);
            setSelected('');
            setMessages([]);
            messageOverrides.current.clear();
            deletedMessageIds.current.clear();
            setOnline([]);
            setChannelMembers([]);
            setProfileUser(null);
            setRooms([]);
            setInvitations([]);
            setBusyInvitation(null);
            invitationRevision.current++;
            setSocketLive(false);
        }
    }, [user]);
    useEffect(() => {
        if (!error)
            return;
        const timer = setTimeout(() => setError(''), 9000);
        return () => clearTimeout(timer);
    }, [error]);
    useEffect(() => {
        if (!modal)
            return;
        const previous = document.activeElement as HTMLElement | null;
        const focusable = () => Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea,select,[tabindex="0"]') || []);
        focusable()[0]?.focus();
        const handle = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setModal(null);
                return;
            }
            if (event.key !== 'Tab')
                return;
            const nodes = focusable(), first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        };
        document.addEventListener('keydown', handle);
        return () => {
            document.removeEventListener('keydown', handle);
            if (previous?.isConnected)
                previous.focus();
        };
    }, [modal]);
    useEffect(() => {
        if (!user)
            return;
        let stopped = false;
        const channelRevision = channelsRevision.current;
        api<{
            channels: Channel[];
        }>('/channels').then(data => {
            if (!stopped && channelRevision === channelsRevision.current)
                updateChannels(data.channels);
        }).catch(e => setError(e.message));
        const refresh = () => {
            void api<{
                rooms: RoomInfo[];
                mediaConfigured: boolean;
            }>('/status').then(data => {
                if (!stopped) {
                    setRooms(data.rooms);
                    setConfig(c => ({ ...c, mediaConfigured: data.mediaConfigured }));
                }
            }).catch(() => { });
            const revision = ++invitationRevision.current;
            void api<{
                invitations: Invitation[];
            }>('/invitations').then(data => {
                if (!stopped && revision === invitationRevision.current)
                    setInvitations(data.invitations);
            }).catch(() => { });
        };
        void refresh();
        const timer = setInterval(refresh, 20000);
        return () => { stopped = true; clearInterval(timer); };
    }, [user]);
    useEffect(() => {
        if (!user)
            return;
        let stopped = false, socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, attempts = 0;
        const syncMessages = () => {
            const id = selectedRef.current;
            messageOverrides.current.clear();
            if (!id)
                return;
            api<{
                messages: Message[];
                hasMore: boolean;
            }>(`/channels/${encodeURIComponent(id)}/messages`).then(data => {
                if (!stopped && selectedRef.current === id) {
                    setMessages(mergeMessages(data.messages, [...messageOverrides.current.values()].filter(message => message.channelId === id)));
                    setHasMore(data.hasMore);
                    setMessageRevision(value => value + 1);
                }
            }).catch(() => { });
        };
        const receive = (data: any) => {
            if (!stopped && data.type === 'moderation' && data.userId === user.id && data.channelId === callIdRef.current) {
                if (['kick', 'ban', 'delete', 'leave'].includes(data.action))
                    stopCall();
                if (data.action === 'mute')
                    setError('Администратор отключил вашу передачу звука и видео в канале.');
            }
            if (stopped)
                return;
            if (data.type === 'invitations') {
                invitationRevision.current++;
                setInvitations(data.invitations);
            }
            if (data.type === 'presence')
                setOnline(data.online);
            if (data.type === 'channels')
                updateChannels(data.channels);
            if (data.type === 'message-updated') updateMessage(data.message);
            if (data.type === 'message-deleted') deleteMessage(data.messageId);
            if (data.type === 'message' && data.message.channelId === selectedRef.current) {
                messageOverrides.current.set(data.message.id, newestMessage(messageOverrides.current.get(data.message.id), data.message));
                const pane = historyRef.current;
                scrollNext.current = !pane || pane.scrollHeight - pane.scrollTop - pane.clientHeight < 130;
                setMessages(old => mergeMessages(old, [data.message]));
            }
            if (data.type === 'desktop-connection') {
                setSocketLive(Boolean(data.connected));
                if (data.connected)
                    syncMessages();
                if (data.code === 4001) {
                    setUser(null);
                    stopCall();
                }
            }
        };
        if (window.signalDesktop) {
            const unsubscribe = window.signalDesktop.subscribeEvents(receive);
            void api('/me').catch(() => { });
            return () => { stopped = true; unsubscribe(); setSocketLive(false); };
        }
        const connect = () => {
            socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws`);
            socket.onopen = () => {
                if (stopped)
                    return;
                setSocketLive(true);
                attempts = 0;
                syncMessages();
            };
            socket.onmessage = event => {
                try {
                    receive(JSON.parse(event.data));
                }
                catch { /* Unsupported event. */ }
            };
            socket.onclose = event => {
                if (stopped)
                    return;
                setSocketLive(false);
                if (event.code === 4001) {
                    setUser(null);
                    stopCall();
                    return;
                }
                retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** attempts++));
            };
            socket.onerror = () => socket?.close();
        };
        connect();
        return () => { stopped = true; clearTimeout(retry); socket?.close(); setSocketLive(false); };
    }, [user]);
    useEffect(() => {
        setMessages([]);
        setHasMore(false);
        setDraft('');
        if (!user || !selected) {
            setLoading(false);
            return;
        }
        setLoading(true);
        const version = ++requestVersion.current;
        scrollNext.current = true;
        api<{
            messages: Message[];
            hasMore: boolean;
        }>(`/channels/${encodeURIComponent(selected)}/messages`).then(data => {
            if (version !== requestVersion.current)
                return;
            setMessages(old => mergeMessages(data.messages, old));
            setHasMore(data.hasMore);
        }).catch(e => {
            if (version === requestVersion.current)
                setError(e.message);
        }).finally(() => {
            if (version === requestVersion.current)
                setLoading(false);
        });
        return () => { requestVersion.current++; };
    }, [selected, user]);
    useEffect(() => { setChannelMembers([]); if (!user || !selected)
        return; let stopped = false; const refresh = () => api<{
        members: {
            id: string;
            username: string;
            role: 'owner' | 'admin' | 'member';
            muted: boolean;
        }[];
    }>(`/channels/${encodeURIComponent(selected)}/members`).then(data => { if (!stopped)
        setChannelMembers(data.members); }).catch(() => { }); void refresh(); const timer = setInterval(refresh, 20000); return () => { stopped = true; clearInterval(timer); }; }, [user, selected, channels]);
    useLayoutEffect(() => {
        if (olderScroll.current && historyRef.current) {
            historyRef.current.scrollTop = olderScroll.current.top + historyRef.current.scrollHeight - olderScroll.current.height;
            olderScroll.current = null;
        }
    }, [messages]);
    useEffect(() => {
        if (scrollNext.current) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            scrollNext.current = false;
        }
    }, [messages]);
    async function send(event: FormEvent) {
        event.preventDefault();
        const originalDraft = draft, content = draft.trim(), id = selected;
        if (!content || sending || !id)
            return;
        setSending(true);
        try {
            const { message } = await api<{
                message: Message;
            }>(`/channels/${encodeURIComponent(id)}/messages`, { content });
            if (selectedRef.current === id) {
                messageOverrides.current.set(message.id, newestMessage(messageOverrides.current.get(message.id), message));
                setDraft(current => current === originalDraft ? '' : current);
                scrollNext.current = true;
                setMessages(old => mergeMessages(old, [message]));
            }
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setSending(false);
        }
    }
    async function earlier() {
        if (!messages.length)
            return;
        const id = selected;
        setLoading(true);
        try {
            const data = await api<{
                messages: Message[];
                hasMore: boolean;
            }>(`/channels/${encodeURIComponent(id)}/messages?before=${messages[0].id}`);
            if (selectedRef.current === id) {
                scrollNext.current = false;
                if (historyRef.current)
                    olderScroll.current = { height: historyRef.current.scrollHeight, top: historyRef.current.scrollTop };
                setMessages(old => mergeMessages(data.messages, old));
                setHasMore(data.hasMore);
            }
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setLoading(false);
        }
    }
    function createInvite() {
        if (!channel || !canManageChannel)
            return;
        setModal('invite');
        setInvite('');
        setCopied(false);
    }
    async function generateInvite() {
        if (!channel || !canManageChannel)
            return;
        setModalBusy(true);
        try {
            const data = await api<{
                code: string;
            }>(`/channels/${encodeURIComponent(channel.id)}/invites`, { maxUses: 10, expiresInHours: 168 });
            setInvite(window.signalDesktop ? `signal://invite/${data.code}` : `${SERVER_ORIGIN}/?invite=${data.code}`);
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setModalBusy(false);
        }
    }
    async function copyInvite() {
        try {
            await navigator.clipboard.writeText(invite);
            setCopied(true);
        }
        catch {
            setError('Выделите ссылку и скопируйте вручную.');
        }
    }
    async function createChannel(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget));
        setModalBusy(true);
        try {
            const result = await api<{
                channel: Channel;
            }>('/channels', data);
            mutateChannels(old => [...new Map([...old, result.channel].map(c => [c.id, c])).values()]);
            setSelected(result.channel.id);
            setModal(null);
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setModalBusy(false);
        }
    }
    function openJoin() { setJoinValue(''); setInviteInfo(null); setJoinError(''); setModal('join'); }
    async function previewInvite(event?: FormEvent) {
        event?.preventDefault();
        setJoinError('');
        setInviteInfo(null);
        const code = invitationCode(joinValue);
        if (!code) {
            setJoinError('Вставьте ссылку signal://invite/… или код из 32 символов.');
            return;
        }
        setModalBusy(true);
        try {
            setInviteInfo(await api<InviteInfo>(`/invites/${code}`));
        }
        catch (e) {
            setJoinError((e as Error).message);
        }
        finally {
            setModalBusy(false);
        }
    }
    async function joinChannel() {
        const code = invitationCode(joinValue);
        if (!code)
            return;
        setModalBusy(true);
        setJoinError('');
        try {
            const result = await api<{
                channel: Channel;
            }>(`/invites/${code}/join`, {});
            mutateChannels(old => [...new Map([...old, result.channel].map(c => [c.id, c])).values()]);
            setSelected(result.channel.id);
            setModal(null);
            setJoinValue('');
            setInviteInfo(null);
            if (location.search)
                history.replaceState({}, '', location.pathname);
        }
        catch (e) {
            setJoinError((e as Error).message);
        }
        finally {
            setModalBusy(false);
        }
    }
    async function respondInvitation(id: string, action: InvitationAction) {
        if (respondingInvitation.current || !user)
            return;
        const accountId = user.id;
        respondingInvitation.current = true;
        setBusyInvitation(id);
        invitationRevision.current++;
        try {
            const result = await api<{
                invitation: Invitation;
                channel?: Channel;
            }>(`/invitations/${encodeURIComponent(id)}/respond`, { action });
            if (authUserId.current !== accountId)
                return;
            invitationRevision.current++;
            setInvitations(old => old.filter(item => item.id !== id));
            if (action === 'accept' && result.channel) {
                const joined = result.channel;
                mutateChannels(old => [...new Map([...old, joined].map(c => [c.id, c])).values()]);
                setSelected(joined.id);
                setModal(null);
            }
        }
        catch (e) {
            if (authUserId.current === accountId) {
                setError((e as Error).message);
                try {
                    const data = await api<{
                        invitations: Invitation[];
                    }>('/invitations');
                    if (authUserId.current === accountId)
                        setInvitations(data.invitations);
                }
                catch { }
            }
        }
        finally {
            respondingInvitation.current = false;
            if (authUserId.current === accountId)
                setBusyInvitation(null);
        }
    }
    async function logout() {
        try {
            await api('/logout', {});
            stopCall();
            setUser(null);
            setChannels([]);
            setSelected('');
            setMessages([]);
            setOnline([]);
            setModal(null);
        }
        catch (e) {
            setError((e as Error).message);
        }
    }
    async function saveDesktopSetting(key: 'openAtLogin' | 'closeToTray', value: boolean) {
        try {
            const next = await window.signalDesktop?.setSettings({ [key]: value });
            if (next)
                setDesktopSettings(next);
        }
        catch (e) {
            setError((e as Error).message || 'Не удалось сохранить настройку приложения.');
        }
    }
    if (booting)
        return <div className="boot"><Brand /><p>Настраиваем частоту…</p></div>;
    if (bootError)
        return <div className="boot"><Brand /><h2>Сервер пока не отвечает</h2><p>{bootError}</p><button className="primary" onClick={() => location.reload()}>Повторить</button></div>;
    if (!user)
        return <Auth onLogin={setUser} pendingInvite={Boolean(joinValue)}/>;
    return <div className="app-shell"><nav className="server-rail" aria-label="Сервер"><Brand compact/><span className="rail-divider"/><button className="server-icon selected" title="Ваш сервер" aria-label="Ваш сервер"><Radio size={25}/></button><button className="rail-add" title="Вступить в канал" aria-label="Вступить в канал" onClick={openJoin}><Plus size={23}/></button><span className="rail-caption">ДОМА</span><div className="rail-bottom"><button className="icon-btn" title="Настройки приложения" aria-label="Настройки приложения" onClick={() => setModal('settings')}><Settings size={21}/></button></div></nav>
    {sidebarOpen && <button className="mobile-shade" aria-label="Закрыть меню" onClick={() => setSidebarOpen(false)}/>}
    <aside className={`channel-sidebar ${sidebarOpen ? 'mobile-open' : ''}`}><div className="workspace-heading"><div><strong>Свой круг</strong><span>Каналы вашего аккаунта</span></div><button className="icon-btn mobile-close" aria-label="Закрыть меню" onClick={() => setSidebarOpen(false)}><X size={20}/></button></div><div className="sidebar-scroll"><div className="workspace-note"><span className="green-dot"/><span>На одной частоте</span><AudioLines size={14}/></div><div className="section-label">МОИ КАНАЛЫ<button className="icon-btn" aria-label="Создать канал" title="Создать канал" onClick={() => setModal('channel')}><Plus size={16}/></button></div><div className="channels">{channels.map(c => <button key={c.id} className={`channel-button ${selected === c.id ? 'active' : ''}`} onClick={() => { setSelected(c.id); setSidebarOpen(false); }}><Hash size={18}/><span>{c.name}</span>{count(c.id) > 0 && <span className="channel-count">{count(c.id)}</span>}</button>)}</div>{!channels.length && <p className="sidebar-empty">Пока нет каналов. Создайте свой или примите приглашение.</p>}<button className="sidebar-join" onClick={openJoin}><Link2 size={16}/>Вступить по приглашению</button>{channels.length > 0 && <><div className="section-label voice-label">ГОЛОСОВЫЕ КОМНАТЫ<span>10 МЕСТ</span></div><div className="voice-rooms">{channels.map(c => <button key={c.id} className={`voice-channel ${call?.id === c.id ? 'connected' : ''}`} onClick={() => {
                    if (call && call.id !== c.id) {
                        setError('Сначала завершите текущий звонок.');
                        return;
                    }
                    setSelected(c.id);
                    startCall(c);
                    setSidebarOpen(false);
                }}><Volume2 size={18}/><span>{c.name}</span>{call?.id === c.id ? <span className="live-dot"/> : <small>{count(c.id)}/10</small>}</button>)}</div></>}<div className="sidebar-card"><span className="mini-orbit"><AudioLines size={23}/></span><h3>Собраться вместе?</h3><p>{canManageChannel ? `Пригласите друзей в #${channel.name}.` : 'Создайте свой канал и пригласите друзей.'}</p><button onClick={canManageChannel ? createInvite : () => setModal('channel')}><Plus size={15}/>{canManageChannel ? 'Пригласить в канал' : 'Создать канал'}</button></div></div>{call && <div className="sidebar-call"><span className="green-dot"/><div><strong>Голосовая комната</strong><span>{call.name}</span></div><button className="icon-btn" title="Завершить звонок" aria-label="Завершить звонок" onClick={stopCall}><X size={17}/></button></div>}<div className="user-panel"><Avatar user={user} small/><div><strong>{user.username}</strong><span><i className="green-dot"/>{socketLive ? 'В сети' : 'Переподключение…'}</span></div><button className="icon-btn" onClick={logout} title="Выйти из аккаунта" aria-label="Выйти из аккаунта"><LogOut size={18}/></button></div></aside>
    <main className="main-panel"><header className="channel-header"><button className="icon-btn mobile-menu" aria-label="Открыть меню" onClick={() => setSidebarOpen(true)}><Menu size={22}/></button><Hash size={23}/><strong>{channel?.name || 'Мои каналы'}</strong><span className="header-divider"/><span className="channel-description">{channel?.description || 'Ваше личное пространство'}</span><div className="header-actions">{channel && <button className="icon-btn" title="Закреплённые сообщения" aria-label="Закреплённые сообщения" onClick={() => setModal('pins')}><Pin size={19}/></button>}{channel && <button className="icon-btn" title="Управление каналом" aria-label="Управление каналом" onClick={() => setModal('channel-settings')}><Settings size={20}/></button>}<button className="icon-btn invitations-trigger" title="Входящие приглашения" aria-label={`Приглашения: ${invitations.length}`} onClick={() => setModal('inbox')}><Bell size={20}/>{invitations.length > 0 && <span className="invitation-count">{invitations.length}</span>}</button><span className={`connection-chip ${socketLive ? '' : 'offline'}`}><i className="green-dot"/>{socketLive ? 'Подключено' : 'Соединяемся'}</span>{canManageChannel && <button className="icon-btn" title="Пригласить в этот канал" aria-label="Пригласить в этот канал" onClick={createInvite}><Link2 size={20}/></button>}<button className={`icon-btn ${membersOpen ? 'on' : ''}`} aria-label="Показать участников" title="Участники" onClick={() => setMembersOpen(!membersOpen)}><Users size={20}/></button></div></header>
      <div className="workspace-body"><div className="conversation-column">{call && (window.signalAndroidBridge ? <AndroidCallStage key={call.id} channel={call} onLeave={stopCall}/> : <Suspense fallback={<div className="call-stage call-status">Готовим голосовую комнату…</div>}><CallStage key={call.id} channel={call} user={user} initialPreferences={initialCallPreferences} onPreferencesChange={persistCallPreferences} onServerRemoved={stopCall} onLeave={stopCall} onError={setError}/></Suspense>)}
      {!channel ? <div className="account-welcome"><span className="account-orbit"><AudioLines size={58}/></span><span className="eyebrow">ПРИВЕТ, {user.username.toLocaleUpperCase('ru-RU')}</span><h1>Ваш круг начинается здесь<span>.</span></h1><p>Аккаунт уже готов. Создайте канал для друзей или вступите в существующий по приглашению.</p><div><button className="primary" onClick={() => setModal('channel')}><Plus size={18}/>Создать канал</button><button className="secondary" onClick={openJoin}><Link2 size={18}/>У меня есть приглашение</button></div><span className="account-note"><ShieldCheck size={16}/>Все ваши каналы сохраняются в аккаунте</span></div> : <><div className="message-history" ref={historyRef} role="log" aria-label={`Сообщения канала ${channel.name}`} aria-live="polite"><div className="welcome"><span className="welcome-symbol"><Hash size={34}/></span><span className="eyebrow">ВАШЕ МЕСТО ДЛЯ ХОРОШИХ РАЗГОВОРОВ</span><h1>Это #{channel.name}<span>.</span></h1><p>{channel.description || 'Здесь начинается общение.'}</p>{!call && <div className="welcome-actions"><button className="primary" onClick={() => startCall(channel)}><Headphones size={17}/>Войти в комнату<ArrowRight size={16}/></button><span>До 10 участников · голос, видео и экран</span></div>}</div>{!config.mediaConfigured && <div className="setup-banner"><ShieldCheck size={18}/><span>Текстовый чат готов. Медиасервер пока недоступен.</span></div>}<div className="date-divider"><span>НАЧАЛО РАЗГОВОРА</span></div>{hasMore && <button className="load-more" disabled={loading} onClick={earlier}>Предыдущие сообщения</button>}{loading && messages.length === 0 && <p className="history-state">Загружаем сообщения…</p>}{!loading && messages.length === 0 && <div className="empty-chat"><MessageSquare size={22}/><div><strong>Пока тихо. Начните разговор.</strong><span>Напишите что-нибудь — остальные увидят это сразу.</span></div></div>}{messages.map((message, index) => { const previous = messages[index - 1], grouped = previous && previous.user.id === message.user.id && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 300000; return <article className={`message ${grouped ? 'grouped' : ''}`} key={message.id}>{!grouped ? <Avatar user={message.user}/> : <span className="message-short-time">{new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>}<div className="message-body">{!grouped && <div className="message-author"><strong>{message.user.username}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div>}<MessageContent message={message} currentUserId={user.id} canModerate={canManageChannel} onUpdated={updateMessage} onDeleted={deleteMessage} onError={setError}/></div></article>; })}<div ref={bottomRef}/></div><div className="composer-wrap"><form className="composer" onSubmit={send}><span className="composer-hash"><Hash size={20}/></span><textarea aria-label="Сообщение" placeholder={`Написать в #${channel.name}`} value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000} rows={1} onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                }
            }}/><button type="submit" className="send-button" title="Отправить" aria-label="Отправить сообщение" disabled={!draft.trim() || sending}><Send size={18}/></button></form><span className="composer-hint"><span><b>Enter</b> — отправить <span className="hint-dot">·</span><b>Shift + Enter</b> — новая строка</span><span>{draft.length > 3500 ? `${draft.length}/4000` : 'Будьте на своей волне'}</span></span></div></>}
      </div>{membersOpen && <aside className="members-panel"><div className="members-title">УЧАСТНИКИ<span>{channelMembers.length}</span></div>{channelMembers.map(person => <div className="member-row" key={person.id}><span className="member-avatar"><Avatar user={person} small/><i className={`green-dot ${online.some(item => item.id === person.id) ? '' : 'offline'}`}/></span><div><button className="member-profile-name" onClick={() => { setProfileUser(person); setModal('profile'); }}>{person.username}{person.id === user.id && <small>вы</small>}</button><span>{person.role === 'owner' ? 'Владелец' : person.role === 'admin' ? 'Администратор' : online.some(item => item.id === person.id) ? 'В сети' : 'Не в сети'}</span></div></div>)}{!socketLive && <p className="muted small-text">Список обновится после подключения.</p>}<div className="members-footer"><ShieldCheck size={18}/><strong>Свой сервер.<br />Свои правила.</strong><p>Ваше пространство для разговоров без лишнего шума.</p><span>СИГНАЛ / 02</span></div></aside>}</div>
    </main>{error && <div className="toast" role="alert"><span>{error}</span><button className="icon-btn" aria-label="Закрыть уведомление" onClick={() => setError('')}><X size={18}/></button></div>}
    {modal && <div className="modal-overlay" onClick={() => setModal(null)}><section ref={modalRef} className="modal-card" role="dialog" aria-modal="true" aria-label={modal === 'invite' ? 'Приглашение в канал' : modal === 'channel' ? 'Создать канал' : modal === 'join' ? 'Вступить в канал' : modal === 'inbox' ? 'Входящие приглашения' : modal === 'channel-settings' ? 'Управление каналом' : modal === 'profile' ? 'Профиль участника' : modal === 'pins' ? 'Закреплённые сообщения' : 'Настройки приложения'} onClick={e => e.stopPropagation()}><button className="icon-btn modal-close" onClick={() => setModal(null)} aria-label="Закрыть"><X size={20}/></button><span className="modal-icon">{modal === 'settings' || modal === 'channel-settings' ? <Settings size={26}/> : modal === 'channel' ? <Hash size={26}/> : modal === 'inbox' ? <Bell size={26}/> : <Link2 size={26}/>}</span>
      {modal === 'invite' && channel && <><h2>Пригласить в #{channel.name}</h2><ChannelInvitationForm key={channel.id} channelId={channel.id} channelName={channel.name} onError={setError}/><div className="invitation-link-section"><h3>Или пригласите по ссылке</h3><p>Ссылка действует 7 дней и допускает 10 новых вступлений. Получатель сам подтверждает добавление канала.</p>{!invite ? <button className="secondary full" disabled={modalBusy} onClick={generateInvite}>{modalBusy ? 'Создаём ссылку…' : 'Создать ссылку'}<Link2 size={17}/></button> : <><label className="invite-label">ССЫЛКА В КАНАЛ<input readOnly value={invite} onFocus={e => e.target.select()}/></label><button className="secondary full" onClick={copyInvite}>{copied ? <Check size={17}/> : <Copy size={17}/>} {copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}</button></>}</div></>}
      {modal === 'channel-settings' && channel && <ChannelSettings channel={channel} userId={user.id} onError={setError} onChanged={next => {
                    if (next)
                        mutateChannels(old => old.map(item => item.id === next.id ? { ...item, ...next } : item));
                    else {
                        const revision = channelsRevision.current;
                        void api<{ channels: Channel[] }>('/channels').then(data => { if (revision === channelsRevision.current) updateChannels(data.channels); }).catch(e => setError(e.message));
                    }
                }} onLeft={() => {
                    const id = channel.id;
                    if (call?.id === id)
                        stopCall();
                    mutateChannels(old => old.filter(item => item.id !== id));
                    setSelected(old => old === id ? '' : old);
                    setModal(null);
                }}/>}
      {modal === 'profile' && profileUser && <UserProfile user={profileUser} role={profileUser.role} online={online.some(item => item.id === profileUser.id)} onError={setError}/>}
      {modal === 'pins' && channel && <><h2>Закреплённые сообщения</h2><PinnedMessages key={channel.id} channelId={channel.id} currentUserId={user.id} canModerate={canManageChannel} liveRevision={messageRevision} deletedMessageIds={deletedMessageIds.current} onUpdated={updateMessage} onDeleted={deleteMessage} onError={setError}/></>}
      {modal === 'inbox' && <><h2>Входящие приглашения</h2><Inbox invitations={invitations} onRespond={respondInvitation} busyId={busyInvitation}/></>}
      {modal === 'channel' && <><h2>Ещё одно место для общения</h2><form onSubmit={createChannel}><p>Вы станете владельцем канала и сможете приглашать участников. Внутри — чат, голос, видео и показ экрана.</p><label>Название<input name="name" required maxLength={40} placeholder="Например, Кино на вечер"/></label><label>Описание<input name="description" maxLength={180} placeholder="О чём будем говорить?"/></label><button className="primary full" disabled={modalBusy}>{modalBusy ? 'Создаём…' : 'Создать канал'}<Plus size={17}/></button></form></>}
      {modal === 'join' && <><h2>Вступить в канал</h2><p>Приглашение добавит канал в ваш аккаунт. Ваши остальные каналы останутся с вами.</p><form onSubmit={previewInvite}><label>Ссылка или код приглашения<input value={joinValue} onChange={e => { setJoinValue(e.target.value); setInviteInfo(null); setJoinError(''); }} placeholder="signal://invite/…" autoComplete="off" maxLength={256} required/></label><button className="secondary full" disabled={modalBusy || !joinValue.trim()}>{modalBusy ? 'Подождите…' : 'Посмотреть канал'}<ArrowRight size={17}/></button></form>{inviteInfo && <div className="invite-preview"><Hash size={24}/><div><strong>{inviteInfo.channel.name}</strong><span>{channels.some(c => c.id === inviteInfo.channel.id) ? 'Вы уже участник' : inviteInfo.valid ? 'Приглашение действительно' : 'Срок или число вступлений исчерпаны'}</span></div></div>}{inviteInfo && (inviteInfo.valid || channels.some(c => c.id === inviteInfo.channel.id)) && <button className="primary full" disabled={modalBusy} onClick={joinChannel}>{channels.some(c => c.id === inviteInfo.channel.id) ? 'Открыть канал' : 'Принять приглашение'}<Check size={17}/></button>}{joinError && <p className="form-error" role="alert">{joinError}</p>}</>}
      {modal === 'settings' && <><h2>Ваш Сигнал</h2><p>Вы вошли как <strong>@{user.username}</strong>. Каналы и переписка хранятся на вашем сервере.</p>{window.signalDesktop && <div className="desktop-settings"><label><input type="checkbox" checked={desktopSettings.openAtLogin} onChange={e => void saveDesktopSetting('openAtLogin', e.target.checked)}/><span>Запускать вместе с Windows</span></label><label><input type="checkbox" checked={desktopSettings.closeToTray} onChange={e => void saveDesktopSetting('closeToTray', e.target.checked)}/><span>При закрытии оставаться в трее</span></label><p>Для полного выхода используйте меню Сигнала в трее.</p></div>}<DesktopUpdates />{window.signalAndroidBridge && <button className="secondary full" onClick={()=>androidCommand({type:'checkUpdate'})}><Download size={17}/>Проверить обновления Android</button>}<div className="server-address"><ShieldCheck size={17}/><span>Сервер: {SERVER_ORIGIN}</span></div><p className="modal-footnote">Камера, микрофон, устройства и качество трансляции настраиваются в голосовой комнате.</p></>}
    </section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<DesktopFrame><App /></DesktopFrame>);
