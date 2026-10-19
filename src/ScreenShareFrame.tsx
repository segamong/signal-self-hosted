import type { ReactNode } from 'react';
import { Maximize2, Minimize2, MonitorUp } from 'lucide-react';
import { useElementFullscreen } from './useElementFullscreen';
import './screen-share.css';

export default function ScreenShareFrame({ username, children, onError }: {
  username: string;
  children: ReactNode;
  onError: (message: string) => void;
}) {
  const { elementRef, fullscreen, toggle } = useElementFullscreen<HTMLDivElement>(onError);
  return <div ref={elementRef} className="share-stage" onDoubleClick={event => { if (event.target instanceof HTMLVideoElement) toggle(); }}>
    <div className="share-title"><span><MonitorUp size={16} />{username} <small>демонстрирует экран</small></span>
      <button className="icon-button" type="button" title={fullscreen ? 'Выйти из полного экрана · Esc' : 'На весь экран'} aria-label={fullscreen ? 'Свернуть демонстрацию' : 'Открыть демонстрацию на весь экран'} aria-pressed={fullscreen} onClick={toggle}>
        {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
    </div>
    {children}
  </div>;
}
