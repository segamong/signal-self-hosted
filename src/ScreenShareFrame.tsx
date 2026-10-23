import { useRef, type ReactNode } from 'react';
import { Maximize2, Minimize2, MonitorUp, Volume2, VolumeX } from 'lucide-react';
import { useElementFullscreen } from './useElementFullscreen';
import './screen-share.css';

export default function ScreenShareFrame({ username, children, onError, audio }: {
  username: string;
  children: ReactNode;
  onError: (message: string) => void;
  audio?: { available: boolean; volume: number; onVolume: (volume: number) => void };
}) {
  const { elementRef, fullscreen, toggle } = useElementFullscreen<HTMLDivElement>(onError);
  const previousVolume = useRef(100);
  if (audio && audio.volume > 0) previousVolume.current = audio.volume;
  return <div ref={elementRef} className="share-stage" onDoubleClick={event => { if (event.target instanceof HTMLVideoElement) toggle(); }}>
    <div className="share-title"><span><MonitorUp size={16} />{username} <small>демонстрирует экран</small></span>
      <div className="share-actions">
      {audio && <div className="share-audio-control" role="group" aria-label="Звук трансляции" title={audio.available ? 'Громкость трансляции, отдельно от голоса' : 'Автор не передаёт звук трансляции'}>
        <button type="button" className="share-audio-toggle" disabled={!audio.available} aria-label={audio.volume === 0 ? 'Включить звук трансляции' : 'Отключить звук трансляции'} aria-pressed={audio.volume > 0} onClick={() => audio.onVolume(audio.volume === 0 ? previousVolume.current : 0)}>{audio.volume === 0 ? <VolumeX size={17}/> : <Volume2 size={17}/>}</button>
        <input type="range" min="0" max="100" step="1" value={audio.volume} disabled={!audio.available} aria-label="Громкость трансляции" onChange={event => audio.onVolume(Number(event.target.value))}/>
        <output aria-hidden="true">{audio.volume}%</output>
      </div>}
      <button className="icon-button" type="button" title={fullscreen ? 'Выйти из полного экрана · Esc' : 'На весь экран'} aria-label={fullscreen ? 'Свернуть демонстрацию' : 'Открыть демонстрацию на весь экран'} aria-pressed={fullscreen} onClick={toggle}>
        {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      </div>
    </div>
    {children}
  </div>;
}
