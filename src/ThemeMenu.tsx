import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette, Settings, X } from 'lucide-react';
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

/** Browser and Windows appearance. Native Android retains its own theme. */
export function ThemeMenu() {
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, bottom: 64 });
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
    if (!open) return;
    const reposition = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 308)),
        bottom: Math.max(8, window.innerHeight - rect.top + 10),
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
    const focus = requestAnimationFrame(() => popup.current?.querySelector<HTMLInputElement>('input:checked')?.focus());
    window.addEventListener('resize', reposition);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      cancelAnimationFrame(focus);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  if (android) return null;
  return <div className="theme-menu">
    <button ref={anchor} className={`icon-btn theme-menu-toggle${open ? ' on' : ''}`} aria-label="Тема приложения" title="Тема приложения" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><Settings size={19} /></button>
    {open && createPortal(<div ref={popup} className="theme-menu-popup" id={id} role="dialog" aria-labelledby={`${id}-title`} style={position}>
      <header><h2 id={`${id}-title`}><Palette size={18} />Тема приложения</h2><button className="icon-btn" aria-label="Закрыть выбор темы" onClick={() => { setOpen(false); anchor.current?.focus(); }}><X size={18} /></button></header>
      <fieldset><legend>Цвет оформления</legend><div className="theme-choice-grid">{THEMES.map(option => <label className={`theme-choice${theme === option.id ? ' selected' : ''}`} key={option.id}>
        <input type="radio" name={`${id}-theme`} value={option.id} checked={theme === option.id} onChange={() => setTheme(option.id)} />
        <span className="theme-choice-preview" aria-hidden="true" style={{ background: `linear-gradient(145deg, ${option.colors[0]}, ${option.end})`, color: option.id === 'light' ? '#30343b' : '#dbdee1' }}><i style={{ background: option.colors[1] }} /><b style={{ background: option.colors[2] }} /><em />{theme === option.id && <Check size={15} />}</span>
        <span>{option.label}</span>
      </label>)}</div></fieldset>
      <p className="theme-selection-status" role="status">Выбрана: <strong>{THEMES.find(option => option.id === theme)?.label}</strong><br />Сохраняется на этом устройстве.</p>
    </div>, document.body)}
  </div>;
}
