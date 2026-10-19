import { useEffect, useRef, useState } from 'react';
import { toggleElementFullscreen } from './fullscreen';

export function useElementFullscreen<T extends HTMLElement>(onError: (message: string) => void) {
  const elementRef = useRef<T>(null);
  const changing = useRef(false);
  const errors = useRef(onError);
  errors.current = onError;
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(elementRef.current && document.fullscreenElement === elementRef.current));
    document.addEventListener('fullscreenchange', sync);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      if (elementRef.current && document.fullscreenElement === elementRef.current) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const toggle = () => {
    const element = elementRef.current;
    if (!element || changing.current) return;
    changing.current = true;
    void toggleElementFullscreen(element)
      .catch(() => errors.current('Не удалось изменить полноэкранный режим. Повторите нажатие.'))
      .finally(() => { changing.current = false; });
  };
  return { elementRef, fullscreen, toggle };
}
