// Manual browser regression fixture: synthetic video only, no devices or account.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ScreenShareFrame from '../src/ScreenShareFrame';
import '../src/styles.css';

function Fixture() {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const sync = () => setActive(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useEffect(() => {
    if (!visible || !video.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#15291f'; context.fillRect(0, 0, 1280, 720);
    context.fillStyle = '#c0f3a0'; context.font = '48px sans-serif';
    context.fillText('Проверка трансляции', 80, 320);
    const stream = canvas.captureStream(1);
    video.current.srcObject = stream;
    return () => stream.getTracks().forEach(track => track.stop());
  }, [visible]);
  return <main style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
    <h1>Проверка полного экрана</h1><p role="status">{active ? 'Полный экран включён' : 'Обычный режим'}</p>
    <button onClick={() => setVisible(value => !value)}>{visible ? 'Убрать трансляцию' : 'Показать трансляцию'}</button>
    {error && <p role="alert">{error}</p>}
    {visible && <ScreenShareFrame username="test-user" onError={setError}>
      <div className="share-video-wrap"><video ref={video} className="screen-video" autoPlay muted playsInline /></div>
    </ScreenShareFrame>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
