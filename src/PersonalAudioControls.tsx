import { useEffect, useState } from 'react';
import { Headphones, HeadphoneOff, Mic, MicOff } from 'lucide-react';
import './themes.css';

type CallState = { connected: boolean; microphone: boolean; deafened: boolean; busy: boolean };
const DISCONNECTED: CallState = { connected: false, microphone: false, deafened: false, busy: false };

export function PersonalAudioControls() {
  const [state, setState] = useState<CallState>(DISCONNECTED);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (!detail || typeof detail !== 'object') return;
      const next = detail as Partial<CallState>;
      if (next.connected !== true) { setState(DISCONNECTED); return; }
      setState({ connected: true, microphone: next.microphone === true, deafened: next.deafened === true, busy: next.busy === true });
    };
    window.addEventListener('signal-call-state', receive);
    window.dispatchEvent(new CustomEvent('signal-call-state-request'));
    return () => window.removeEventListener('signal-call-state', receive);
  }, []);
  const unavailable = !state.connected || state.busy;
  const microphoneLabel = !state.connected ? 'Микрофон доступен во время звонка' : state.microphone ? 'Выключить микрофон' : 'Включить микрофон';
  const headphonesLabel = !state.connected ? 'Наушники доступны во время звонка' : state.deafened ? 'Включить входящий звук' : 'Отключить входящий звук';
  const command = (action: 'microphone' | 'deafen') => {
    if (!unavailable) window.dispatchEvent(new CustomEvent('signal-call-command', { detail: { action } }));
  };
  return <div className={`personal-audio-controls${state.connected ? ' connected' : ''}`} role="group" aria-label="Звук звонка">
    <button className={`personal-audio-button${state.connected ? state.microphone ? ' enabled' : ' muted' : ''}`} title={microphoneLabel} aria-label={microphoneLabel} aria-pressed={state.connected && state.microphone} disabled={unavailable} onClick={() => command('microphone')}>{state.microphone ? <Mic size={18} /> : <MicOff size={18} />}</button>
    <button className={`personal-audio-button${state.connected ? state.deafened ? ' muted' : ' enabled' : ''}`} title={headphonesLabel} aria-label={headphonesLabel} aria-pressed={state.connected && !state.deafened} disabled={unavailable} onClick={() => command('deafen')}>{state.deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}</button>
  </div>;
}
