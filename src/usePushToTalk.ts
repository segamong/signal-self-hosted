import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { RoomEvent, type Room } from 'livekit-client';
import type { AudioPreferences } from './audioPreferences';
import { setMicrophonePushToTalk } from './microphoneProcessor';

function isEditing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input,textarea,select,[contenteditable],[role="textbox"],[data-voice-keybind]')));
}

/** Call this in CallStage even while its settings drawer is closed. */
export function usePushToTalk(room: Room | null, preferences: AudioPreferences, microphoneEnabled: boolean) {
  const active = preferences.inputMode === 'push-to-talk';
  const enabled = active && microphoneEnabled && Boolean(room);
  const [pressed, setPressed] = useState(false);
  const current = useRef({ room, enabled, pressed: false });
  current.current.room = room;
  current.current.enabled = enabled;

  const update = useCallback((next: boolean, immediate = false) => {
    const state = current.current;
    const value = next && state.enabled;
    if (state.pressed === value && !immediate) return;
    state.pressed = value;
    setPressed(value);
    if (state.room) setMicrophonePushToTalk(state.room, value, immediate);
  }, []);

  useEffect(() => {
    update(false, true);
    if (!room || !enabled) return;
    const down = (event: KeyboardEvent) => {
      const modifierKey = /^(?:Control|Alt|Shift)(?:Left|Right)$/.test(event.code);
      if (event.code !== preferences.pushToTalkKey || event.repeat || event.defaultPrevented || event.isComposing || isEditing(event.target)
        || event.metaKey || (!modifierKey && (event.ctrlKey || event.altKey))) return;
      event.preventDefault();
      update(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== preferences.pushToTalkKey) return;
      if (!isEditing(event.target)) event.preventDefault();
      update(false);
    };
    const release = () => update(false, true);
    const visibility = () => { if (document.hidden) release(); };
    const trackPublished = () => setMicrophonePushToTalk(room, current.current.pressed);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibility);
    room.on(RoomEvent.LocalTrackPublished, trackPublished);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibility);
      room.off(RoomEvent.LocalTrackPublished, trackPublished);
      setMicrophonePushToTalk(room, false, true);
      current.current.pressed = false;
    };
  }, [room, enabled, preferences.pushToTalkKey, update]);

  const press = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !enabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    update(true);
  };
  const release = () => update(false);

  return { active, pressed: pressed && enabled, enabled, press, release };
}
