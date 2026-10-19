import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Crown, LoaderCircle, Shield, UserRound } from 'lucide-react';
import './user-profile.css';

type Props = {
    user: { id: string; username: string };
    role?: 'owner' | 'admin' | 'member';
    online?: boolean;
    onError: (message: string) => void;
};

const roles = { owner: 'Владелец канала', admin: 'Администратор канала', member: 'Участник канала' };

export function UserProfile({ user, role, online, onError }: Props) {
    const [copied, setCopied] = useState(false), [copying, setCopying] = useState(false);
    const active = useRef(true), identity = useRef(''), resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    identity.current = `${user.id}:${user.username}`;
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
            if (resetTimer.current) clearTimeout(resetTimer.current);
        };
    }, []);
    useEffect(() => {
        setCopied(false);
        setCopying(false);
        if (resetTimer.current) clearTimeout(resetTimer.current);
    }, [user.id, user.username]);

    async function copyUsername() {
        if (copying) return;
        const requestedIdentity = identity.current;
        setCopying(true);
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Копирование недоступно в этом окне.');
            await navigator.clipboard.writeText(user.username);
            if (!active.current || identity.current !== requestedIdentity) return;
            setCopied(true);
            if (resetTimer.current) clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(() => setCopied(false), 3000);
        } catch (cause) {
            if (active.current && identity.current === requestedIdentity) onError((cause as Error).message || 'Не удалось скопировать никнейм.');
        } finally {
            if (active.current && identity.current === requestedIdentity) setCopying(false);
        }
    }

    const color = [...user.id].reduce((value, character) => value + character.charCodeAt(0), 0) % 5;
    return <section className="user-profile" aria-label={`Профиль ${user.username}`}>
        <div className="user-profile-cover" aria-hidden="true"><i/><i/><i/></div>
        <div className={`user-profile-avatar profile-color-${color}`} aria-hidden="true">{user.username.slice(0, 2).toUpperCase()}{typeof online === 'boolean' && <span className={online ? 'online' : 'offline'}/>}</div>
        <div className="user-profile-heading"><span>Профиль пользователя</span><h2>@{user.username}</h2>{typeof online === 'boolean' && <p className={`user-profile-status ${online ? 'online' : 'offline'}`}><span/>{online ? 'В сети' : 'Не в сети'}</p>}</div>
        {role && <div className={`user-profile-role profile-role-${role}`}>{role === 'owner' ? <Crown size={15}/> : role === 'admin' ? <Shield size={15}/> : <UserRound size={15}/>}<span>{roles[role]}</span></div>}
        <button type="button" className={`secondary user-profile-copy${copied ? ' copied' : ''}`} disabled={copying} onClick={() => { void copyUsername(); }}>{copying ? <LoaderCircle size={16} className="spin"/> : copied ? <Check size={16}/> : <Copy size={16}/>}<span aria-live="polite">{copying ? 'Копируем…' : copied ? 'Никнейм скопирован' : 'Скопировать никнейм'}</span></button>
    </section>;
}
