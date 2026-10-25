import { useEffect, useState } from 'react';
import { Keyboard, Mic, Volume2 } from 'lucide-react';
import { isPushToTalkKey, preferencesForMode, pushToTalkKeyLabel, type AudioPreferences, type VoiceSettingsMode } from './audioPreferences';
import './voice-settings.css';

interface VoiceSettingsProps {
  value: AudioPreferences;
  onChange: (patch: Partial<AudioPreferences>) => void;
  disabled?: boolean;
  supportedAudio?: MediaTrackSupportedConstraints;
  microphoneOn?: boolean;
  sourceAudioSettings?: MediaTrackSettings;
}

export default function VoiceSettings({ value, onChange, disabled = false, supportedAudio = {}, microphoneOn, sourceAudioSettings }: VoiceSettingsProps) {
  const [binding, setBinding] = useState(false);
  const [bindingError, setBindingError] = useState('');
  const canWorklet = typeof AudioWorkletNode !== 'undefined';
  const canNeural = canWorklet && typeof WebAssembly !== 'undefined';
  const discord = value.settingsMode === 'discord';
  const ptt = value.inputMode === 'push-to-talk';
  const changeMode = (mode: VoiceSettingsMode) => {
    setBinding(false);
    onChange(preferencesForMode(mode));
  };
  useEffect(() => { if (disabled) setBinding(false); }, [disabled]);

  const noise = value.noiseEngine === 'rnnoise' || value.noiseEngine === 'neural' ? value.noiseEngine : value.noiseSuppression ? 'browser' : 'off';
  const noiseChoice = <label>Шумоподавление<select value={noise} disabled={disabled} onChange={event => onChange({ noiseEngine: event.target.value === 'neural' ? 'neural' : event.target.value === 'rnnoise' ? 'rnnoise' : 'browser', noiseSuppression: event.target.value === 'browser' })}>
    <option value="off">Отключено</option>
    <option value="browser" disabled={!supportedAudio.noiseSuppression}>Стандартное · браузер</option>
    <option value="neural" disabled={!canNeural}>Сигнал Clear · нейросеть</option>
    <option value="rnnoise" disabled={!canWorklet}>RNNoise · на устройстве</option>
  </select></label>;

  return <section className={`voice-settings voice-settings-modes${discord ? ' discord-voice-settings' : ''}`} aria-label="Обработка голоса">
    <div className="voice-section-heading"><h3>Голос и звук</h3><span>Opus · до 96 кбит/с · RED</span></div>
    <div className="voice-mode-switch" role="group" aria-label="Режим настроек звука">
      <button type="button" aria-pressed={!discord} disabled={disabled} onClick={() => changeMode('signal')}>Сигнал</button>
      <button type="button" aria-pressed={discord} disabled={disabled} onClick={() => changeMode('discord')}>Как в Discord</button>
    </div>
    <p className="settings-hint">{discord ? 'Активация по голосу или кнопке, чувствительность и обработка микрофона.' : 'Привычные настройки Сигнала с ручной обработкой голоса.'} Параметры каждого режима сохраняются отдельно.</p>

    <div className="voice-settings-grid voice-volume-controls">
      <label><span><Mic size={14} />Громкость микрофона <strong>{value.microphoneGain}%</strong></span><input aria-label="Громкость микрофона" type="range" min="0" max="200" step="5" value={value.microphoneGain} disabled={disabled} onChange={event => onChange({ microphoneGain: Number(event.target.value) })} /></label>
      <label><span><Volume2 size={14} />Громкость воспроизведения <strong>{value.outputVolume}%</strong></span><input aria-label="Громкость воспроизведения" type="range" min="0" max="200" step="5" value={value.outputVolume} disabled={disabled} onChange={event => onChange({ outputVolume: Number(event.target.value) })} /></label>
    </div>
    <p className="settings-hint">Выше 100% звук усиливается. Слишком большое усиление может вызвать искажения.</p>

    {discord ? <>
      <h4>Режим ввода</h4>
      <div className="voice-input-modes" role="radiogroup" aria-label="Режим ввода">
        <label><input type="radio" name="voice-input-mode" checked={!ptt} disabled={disabled} onChange={() => onChange({ inputMode: 'voice', gateEnabled: true })} /><span><strong>Активация по голосу</strong><small>Микрофон передаёт звук при обнаружении голоса.</small></span></label>
        <label><input type="radio" name="voice-input-mode" checked={ptt} disabled={disabled} onChange={() => onChange({ inputMode: 'push-to-talk' })} /><span><strong>Режим рации</strong><small>Передавайте голос, удерживая назначенную кнопку.</small></span></label>
      </div>
      {ptt ? <div className="voice-ptt-settings">
        <label>Кнопка для разговора</label>
        <button type="button" data-voice-keybind className={`voice-keybind${binding ? ' recording' : ''}`} disabled={disabled} onClick={() => { setBinding(true); setBindingError(''); }} onBlur={() => setBinding(false)} onKeyDown={event => {
          if (!binding) return;
          event.preventDefault(); event.stopPropagation();
          if (event.code === 'Escape') { setBinding(false); return; }
          if (!isPushToTalkKey(event.code)) { setBindingError('Выберите букву, цифру, пробел, Ctrl, Alt, Shift или F1–F12.'); return; }
          onChange({ pushToTalkKey: event.code }); setBinding(false); setBindingError('');
        }}><Keyboard size={15} />{binding ? 'Нажмите клавишу…' : pushToTalkKeyLabel(value.pushToTalkKey)}</button>
        {bindingError && <p className="settings-hint" role="status">{bindingError}</p>}
        <p className="settings-hint">Клавиша работает, когда окно Сигнала активно и курсор не находится в поле ввода. В звонке также доступна кнопка «Удерживайте для разговора».</p>
      </div> : <>
        <div className="voice-switches"><label><input type="checkbox" checked={value.automaticSensitivity} disabled={disabled || !canWorklet} onChange={event => onChange({ automaticSensitivity: event.target.checked, gateEnabled: true })} />Автоматически определять чувствительность микрофона</label></div>
        {!value.automaticSensitivity && <label className="voice-sensitivity">Чувствительность микрофона <strong>{value.gateThreshold} дБ</strong><input aria-label="Чувствительность микрофона" type="range" min="-70" max="-20" step="1" value={value.gateThreshold} disabled={disabled || !canWorklet} onChange={event => onChange({ gateThreshold: Number(event.target.value), gateEnabled: true })} /><small>Тихие звуки <span>Только громкий голос</span></small></label>}
        <p className="settings-hint">Автоматический порог подстраивается под фон помещения. Если тихие слова пропадают, выберите ручную чувствительность и уменьшите порог.</p>
      </>}
      <label className="voice-release-delay">{ptt ? 'Задержка отключения после отпускания кнопки' : 'Задержка отключения после речи'} <strong>{value.releaseDelay} мс</strong><input aria-label="Задержка отключения микрофона" type="range" min="20" max="2000" step="20" value={value.releaseDelay} disabled={disabled} onChange={event => onChange({ releaseDelay: Number(event.target.value) })} /></label>
    </> : <div className="voice-preset-buttons"><button type="button" disabled={disabled} onClick={() => onChange({ noiseEngine: 'browser', noiseSuppression: false, echoCancellation: true, autoGainControl: false, gateEnabled: true, gateThreshold: -60 })}>Естественный голос</button><button type="button" disabled={disabled || !supportedAudio.noiseSuppression} onClick={() => onChange({ noiseEngine: 'browser', noiseSuppression: true, echoCancellation: true, autoGainControl: false, gateEnabled: true, gateThreshold: -50 })}>Шумное место</button></div>}

    <h4>Обработка голоса</h4>
    <div className="voice-settings-grid">
      {noiseChoice}
      {value.noiseEngine === 'rnnoise' && <label>Профиль RNNoise<select value={value.rnnoisePreset} disabled={disabled} onChange={event => onChange({ rnnoisePreset: event.target.value as AudioPreferences['rnnoisePreset'] })}><option value="natural">Естественный</option><option value="balanced">Сбалансированный</option><option value="strong">Сильное подавление</option></select></label>}
      {value.noiseEngine === 'neural' && <label>Обработка фона<select value={value.neuralPreset} disabled={disabled} onChange={event => onChange({ neuralPreset: event.target.value as AudioPreferences['neuralPreset'] })}><option value="natural">Естественный · мягкая обработка</option><option value="balanced">Сбалансированный</option><option value="strong">Сильнее приглушать фон</option></select></label>}
      {!discord && <label>Порог фонового шума <strong>{value.gateThreshold} дБ</strong><input aria-label="Порог фонового шума" type="range" min="-70" max="-20" step="1" value={value.gateThreshold} disabled={disabled || !value.gateEnabled || !canWorklet} onChange={event => onChange({ gateThreshold: Number(event.target.value) })} /></label>}
    </div>
    {value.noiseEngine === 'neural' && <div className="voice-neural-info">
      <span className="voice-neural-badge">Локальная нейросеть</span>
      <p>Сигнал Clear обрабатывает микрофон на вашем устройстве с помощью нейросети GTCRN. Профиль меняет фильтрацию и приглушение фона между словами.</p>
      <p>Режим предназначен для речи: частоты выше 8 кГц не передаются. Сильное приглушение может обрезать тихие слова; эхоподавление и громкость настраиваются отдельно.</p>
    </div>}
    <div className="voice-switches">
      <label><input type="checkbox" checked={value.echoCancellation} disabled={disabled || !supportedAudio.echoCancellation} onChange={event => onChange({ echoCancellation: event.target.checked })} />Эхоподавление</label>
      <label><input type="checkbox" checked={value.autoGainControl} disabled={disabled || !supportedAudio.autoGainControl} onChange={event => onChange({ autoGainControl: event.target.checked })} />Автоматическая регулировка усиления</label>
      {!discord && <label><input type="checkbox" checked={value.gateEnabled} disabled={disabled || !canWorklet} onChange={event => onChange({ gateEnabled: event.target.checked })} />Приглушать фон между словами</label>}
    </div>
    <p className="settings-hint">{value.noiseEngine === 'neural' ? 'Нейросеть работает локально. Шумоподавление браузера отключается, параметры режимов Сигнал и «Как в Discord» сохраняются отдельно.' : value.noiseEngine === 'rnnoise' ? 'RNNoise работает на вашем устройстве. Шумоподавление браузера отключается, эхоподавление остаётся доступным.' : 'Стандартная обработка использует возможности вашего браузера. Для нейросетевого подавления фона выберите Сигнал Clear.'}</p>
    {microphoneOn && <p className="voice-processing-state">Устройство сообщает: эхо — {sourceAudioSettings?.echoCancellation === undefined ? 'неизвестно' : sourceAudioSettings.echoCancellation ? 'включено' : 'выключено'}, шумоподавление браузера — {sourceAudioSettings?.noiseSuppression === undefined ? 'неизвестно' : sourceAudioSettings.noiseSuppression ? 'включено' : 'выключено'}, автоматическая громкость — {sourceAudioSettings?.autoGainControl === undefined ? 'неизвестно' : sourceAudioSettings.autoGainControl ? 'включена' : 'выключена'}.</p>}
  </section>;
}
