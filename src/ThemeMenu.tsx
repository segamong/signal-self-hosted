import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette, Settings, Volume2, X } from 'lucide-react';
import { CallNotificationSettings } from './callNotifications';
import './themes.css';

const STORAGE_KEY = 'signal:appearance-theme:v1';
const THEMES = [
  { id: 'dark', label: 'Тёмная', colors: ['#34363c', '#1e1f22', '#5865f2'], end: '#2f3136' },
  { id: 'midnight', label: 'Полночь', colors: ['#192033', '#090d16', '#5269db'], end: '#141a28' },
  { id: 'light', label: 'Светлая', colors: ['#ffffff', '#e3e5e8', '#4752c4'], end: '#f6f7fa' },
  { id: 'violet', label: 'Фиолетовая', colors: ['#352c44', '#1c1727', '#7659d5'], end: '#2e263c' },
  { id: 'forest', label: 'Зелёная', colors: ['#263b34', '#101e1a', '#287858'], end: '#20322c' },
  { id: 'rose', label: 'Бордовая', colors: ['#3e2a32', '#21171d', '#b44158'], end: '#35252d' },
] as const;
type ThemeId = typeof THEMES[number]['id'];
type SettingsTab = 'appearance' | 'sounds';

function validTheme(value: unknown): value is ThemeId {
  return THEMES.some(theme => theme.id === value);
}

function savedTheme(): ThemeId {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return validTheme(value) ? value : 'dark';
  } catch { return 'dark'; }
}

// Restore before the account screen renders as well as after sign-in. The
// native Android application keeps its own appearance.
if (!window.signalAndroidBridge) document.documentElement.dataset.signalTheme = savedTheme();

/** Browser and Windows preferences. Native Android retains its own settings. */
export function ThemeMenu() {
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const [position, setPosition] = useState<{ left: number; bottom?: number; top?: number; maxHeight: number }>({ left: 8, bottom: 64, maxHeight: 640 });
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const android = Boolean(window.signalAndroidBridge);

  useEffect(() => {
    if (android) return;
    document.documentElement.dataset.signalTheme = theme;
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* The selection still works when storage is unavailable. */ }
  }, [theme, android]);

  useEffect(() => {
    if (android) return;
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setTheme(validTheme(event.newValue) ? event.newValue : 'dark');
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [android]);

  useEffect(() => {
    if (android) return;
    const reveal = (event: Event) => {
      const requested = event instanceof CustomEvent ? event.detail : undefined;
      setTab(requested === 'sounds' ? 'sounds' : 'appearance');
      setOpen(true);
    };
    window.addEventListener('signal-open-appearance', reveal);
    return () => window.removeEventListener('signal-open-appearance', reveal);
  }, [android]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(420, window.innerWidth - 16);
      const above = rect.top - 18;
      const below = window.innerHeight - rect.bottom - 18;
      const showAbove = above >= 300 || above >= below;
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        ...(showAbove ? { bottom: Math.max(8, window.innerHeight - rect.top + 10) } : { top: rect.bottom + 10 }),
        maxHeight: Math.max(100, Math.min(640, showAbove ? above : below)),
      });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !popup.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        anchor.current?.focus();
      }
    };
    reposition();
    const focus = requestAnimationFrame(() => popup.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus());
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      cancelAnimationFrame(focus);
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  const chooseTab = (next: SettingsTab, focus = false) => {
    setTab(next);
    if (focus) popup.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${id}-${next}-tab`)}`)?.focus();
  };

  if (android) return null;
  return <div className="theme-menu">
    <button ref={anchor} className={`icon-btn theme-menu-toggle${open ? ' on' : ''}`} aria-label="Тема приложения" title="Тема приложения" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><Settings size={19} /></button>
    {open && createPortal(<div ref={popup} className="theme-menu-popup" id={id} role="dialog" aria-labelledby={`${id}-title`} style={position}>
      <header><h2 id={`${id}-title`}><Settings size={18} />Настройки приложения</h2><button className="icon-btn" aria-label="Закрыть настройки" onClick={() => { setOpen(false); anchor.current?.focus(); }}><X size={18} /></button></header>
      <div className="appearance-tabs" role="tablist" aria-label="Разделы настроек" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        chooseTab(event.key === 'Home' ? 'appearance' : event.key === 'End' ? 'sounds' : tab === 'appearance' ? 'sounds' : 'appearance', true);
      }}>
        <button type="button" role="tab" id={`${id}-appearance-tab`} aria-controls={`${id}-appearance-panel`} aria-selected={tab === 'appearance'} tabIndex={tab === 'appearance' ? 0 : -1} onClick={() => chooseTab('appearance')}><Palette size={16} />Оформление</button>
        <button type="button" role="tab" id={`${id}-sounds-tab`} aria-controls={`${id}-sounds-panel`} aria-selected={tab === 'sounds'} tabIndex={tab === 'sounds' ? 0 : -1} onClick={() => chooseTab('sounds')}><Volume2 size={16} />Звуки</button>
      </div>
      <div className="appearance-pane" role="tabpanel" id={`${id}-appearance-panel`} aria-labelledby={`${id}-appearance-tab`} hidden={tab !== 'appearance'} tabIndex={0}>
      {tab === 'appearance' && <><fieldset><legend>Цвет оформления</legend><div className="theme-choice-grid">{THEMES.map(option => <label className={`theme-choice${theme === option.id ? ' selected' : ''}`} key={option.id}>
        <input type="radio" name={`${id}-theme`} value={option.id} checked={theme === option.id} onChange={() => setTheme(option.id)} />
        <span className="theme-choice-preview" aria-hidden="true" style={{ background: `linear-gradient(145deg, ${option.colors[0]}, ${option.end})`, color: option.id === 'light' ? '#30343b' : '#dbdee1' }}><i style={{ background: option.colors[1] }} /><b style={{ background: option.colors[2] }} /><em />{theme === option.id && <Check size={15} />}</span>
        <span>{option.label}</span>
      </label>)}</div></fieldset>
      <p className="theme-selection-status" role="status">Выбрана: <strong>{THEMES.find(option => option.id === theme)?.label}</strong><br />Сохраняется на этом устройстве.</p></>}
      </div>
      <div className="appearance-pane" role="tabpanel" id={`${id}-sounds-panel`} aria-labelledby={`${id}-sounds-tab`} hidden={tab !== 'sounds'} tabIndex={0}>
      {tab === 'sounds' && <CallNotificationSettings compact />}
      </div>
    </div>, document.body)}
  </div>;
}
