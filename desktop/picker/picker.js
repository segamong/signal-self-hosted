'use strict';

let sources = [];
let selected = null;
let category = 'screen';
let busy = false;
let audioChoiceInitialized = false;
const list = document.getElementById('sources');
const share = document.getElementById('share');
const audio = document.getElementById('audio');

function render() {
  list.replaceChildren();
  const visible = sources.filter((source) => source.id.startsWith(`${category}:`));
  if (!visible.length) {
    const message = document.createElement('p');
    message.textContent = category === 'screen' ? 'Экраны не найдены.' : 'Нет доступных окон. Откройте нужное окно и нажмите «Обновить».';
    list.append(message);
  }
  for (const source of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `source${source.id === selected ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(source.id === selected));
    const img = document.createElement('img');
    img.src = source.thumbnail;
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = source.name;
    button.append(img, name);
    button.addEventListener('click', () => { selected = source.id; render(); });
    list.append(button);
  }
  share.disabled = busy || !sources.some((source) => source.id === selected);
}

async function refresh() {
  try {
    const result = await window.signalPicker.getSources();
    sources = result.sources;
    document.getElementById('audio-label').hidden = !result.audioAvailable;
    audio.disabled = !result.audioAvailable;
    // The main renderer requests audio only after the user enabled sharing it.
    // Reflect that explicit choice in the picker instead of silently resetting
    // every capture to video-only. Refreshing sources preserves later changes.
    if (!audioChoiceInitialized) {
      audio.checked = result.audioAvailable === true;
      audioChoiceInitialized = true;
    }
    if (!result.audioAvailable) audio.checked = false;
    const unfilteredAudio = result.audioAvailable && !result.screenAudioExcludesOwnAudio;
    const audioDescription = document.getElementById('audio-description');
    audioDescription.classList.toggle('audio-warning', unfilteredAudio);
    audioDescription.textContent = unfilteredAudio
      ? 'Совместимый режим передаёт весь звук компьютера, включая голоса звонка Сигнала. Участники могут услышать себя повторно. При появлении эха отключите звук трансляции.'
      : 'В режиме исключения голосов передаётся звук других программ. В совместимом режиме передаётся весь звук компьютера, включая голоса звонка. Режим выбирается в настройках трансляции.';
    if (!sources.some((source) => source.id === selected)) selected = null;
    render();
  } catch {
    list.textContent = 'Не удалось получить список. Закройте выбор и попробуйте снова.';
  }
}
for (const [id, value] of [['screens', 'screen'], ['windows', 'window']]) document.getElementById(id).addEventListener('click', () => {
  category = value;
  selected = null;
  document.getElementById('screens').classList.toggle('active', value === 'screen');
  document.getElementById('windows').classList.toggle('active', value === 'window');
  render();
});
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('cancel').addEventListener('click', () => window.signalPicker.cancel());
share.addEventListener('click', async () => {
  if (!selected || busy) return;
  busy = true; render();
  try { await window.signalPicker.select(selected, audio.checked); }
  catch { busy = false; selected = null; await refresh(); }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.signalPicker.cancel(); });
void refresh();
