import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url&no-inline';
import neuralWorklet from './neural-noise.worklet.js?url&no-inline';

/** GTCRN runs entirely on the caller's device. No microphone data is uploaded. */
export interface NeuralNoise {
  readonly input: AudioWorkletNode;
  readonly output: AudioWorkletNode;
  destroy(): void;
}

const PROCESSOR = 'signal-neural-gtcrn';
const INITIALIZATION_TIMEOUT = 15_000;
const modules = new WeakMap<AudioContext, Promise<void>>();
let binary: Promise<ArrayBuffer> | undefined;

function cancellationError(): DOMException {
  return new DOMException('Запуск обработки микрофона отменён.', 'AbortError');
}

function waitUnlessCancelled<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(cancellationError()); };
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(value => {
      signal.removeEventListener('abort', aborted);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', aborted);
      reject(error);
    });
  });
}

function loadBinary(): Promise<ArrayBuffer> {
  binary ??= (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INITIALIZATION_TIMEOUT);
    try {
      const response = await fetch(gtcrnWasm, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('Не удалось загрузить модель шумоподавления.');
      const bytes = await response.arrayBuffer();
      // Validate before entering the audio thread; this also detects missing SIMD
      // support and an HTML error page returned instead of the bundled wasm asset.
      if (!WebAssembly.validate(bytes)) throw new Error('Этот браузер не поддерживает нейросетевое шумоподавление. Выберите RNNoise или обработку браузера.');
      return bytes;
    } finally { clearTimeout(timeout); }
  })().catch(error => { binary = undefined; throw error; });
  return binary;
}

function loadModule(context: AudioContext): Promise<void> {
  let pending = modules.get(context);
  if (!pending) {
    pending = context.audioWorklet.addModule(neuralWorklet).catch(error => {
      modules.delete(context);
      throw error;
    });
    modules.set(context, pending);
  }
  return pending;
}

/**
 * Creates a mono, 48 kHz processor and waits for model initialization.
 * GTCRN uses 16 ms frames and internally processes speech at 16 kHz.
 * Failure disconnects the output: unprocessed microphone audio is never used
 * as an implicit fallback. The owner must surface the error or select another
 * engine explicitly, while preserving its own mute / push-to-talk controls.
 */
export async function createNeuralNoise(context: AudioContext, onError?: (error: Error) => void, signal?: AbortSignal): Promise<NeuralNoise> {
  if (signal?.aborted) throw cancellationError();
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined' || context.sampleRate !== 48_000) {
    throw new Error('Для нейросетевого шумоподавления нужен AudioWorklet и звук 48 кГц. Выберите RNNoise или обработку браузера.');
  }
  const deadline = performance.now() + INITIALIZATION_TIMEOUT;
  const timeoutError = () => new Error('Модель шумоподавления не запустилась вовремя. Повторите попытку или выберите RNNoise.');
  let loadingTimeout: ReturnType<typeof setTimeout> | undefined;
  const [wasmBinary] = await waitUnlessCancelled(Promise.race([
    Promise.all([loadBinary(), loadModule(context)]),
    new Promise<never>((_, reject) => { loadingTimeout = setTimeout(() => reject(timeoutError()), INITIALIZATION_TIMEOUT); }),
  ]), signal).finally(() => clearTimeout(loadingTimeout));
  if (signal?.aborted) throw cancellationError();
  const node = new AudioWorkletNode(context, PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    outputChannelCount: [1],
    processorOptions: { wasmBinary },
  });
  let destroyed = false;
  let ready = false;
  let failed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const initialized = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(timeout);
    node.removeEventListener('processorerror', processorError);
    node.port.removeEventListener('message', message);
    signal?.removeEventListener('abort', aborted);
    node.disconnect();
    try { node.port.postMessage({ type: 'destroy' }); } catch { /* Already terminated. */ }
    node.port.close();
  };
  const fault = (error: Error) => {
    if (failed || destroyed) return;
    failed = true;
    destroy();
    if (ready) onError?.(error);
    else rejectReady(error);
  };
  const processorError = () => fault(new Error('Нейросетевое шумоподавление остановилось. Переключите обработку микрофона.'));
  const aborted = () => {
    destroy();
    if (!ready) rejectReady(cancellationError());
  };
  const message = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (!value || typeof value !== 'object' || !('type' in value)) return;
    if (value.type === 'ready' && !ready && !destroyed) {
      ready = true;
      clearTimeout(timeout);
      resolveReady();
    } else if (value.type === 'error') {
      fault(new Error('Не удалось запустить нейросетевое шумоподавление. Выберите RNNoise или обработку браузера.'));
    }
  };
  node.addEventListener('processorerror', processorError);
  node.port.addEventListener('message', message);
  node.port.start();
  signal?.addEventListener('abort', aborted, { once: true });
  timeout = setTimeout(() => fault(timeoutError()), Math.max(1, deadline - performance.now()));
  try { await initialized; }
  catch (error) { destroy(); throw error; }
  return { input: node, output: node, destroy };
}
