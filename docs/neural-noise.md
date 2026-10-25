# Neural microphone noise suppression

Signal's neural mode integrates the pretrained **GTCRN** speech enhancement
model through the WebAssembly runtime bundled in
`@sapphi-red/web-noise-suppressor` 0.4.1. It is not Krisp, is not affiliated with
Discord, and is not a newly trained Signal model.

## Processing

- Processing runs locally in an `AudioWorklet`, before microphone publication.
- The Wasm model and worklet are served by the same Signal installation and
  included in Windows builds. No vendor API, key, cloud inference or microphone
  upload is used for noise suppression.
- The input and output are mono at 48 kHz. The runtime resamples internally to
  the model's 16 kHz rate, so processed speech has an approximately 8 kHz upper
  frequency limit. This mode is intended for voice, not music or system audio.
- The model processes 768-sample input frames at 48 kHz (16 ms). Total latency
  also includes framing, STFT overlap, resampling, browser and network buffers;
  16 ms is the frame interval, not a promise of total added latency.
- The upstream model is fixed. Natural / balanced / strong presets adjust
  Signal's surrounding filter and noise gate, not learned model weights.
- Browser noise suppression must be disabled while a neural model is selected.
  Echo cancellation is separate and can remain enabled.

## Initialization and failure

`createNeuralNoise(context, onError, signal?)` requires a 48 kHz `AudioContext` and returns
`{ input, output, destroy }`. Connect the microphone chain to `input`, and connect
`output` to Signal's downstream gate, gain, limiter and transmission controls.

The adapter validates Wasm support, loads its worklet once per context, and waits
for an explicit model-ready message, with a 15-second bound. The worklet emits
silence until ready. Initialization failures reject the call. A runtime fault
disconnects the processor and calls `onError`; the owner must close its
transmission gain, mute the microphone and show an error. There is no automatic
fallback to an unprocessed microphone. Selecting another engine is explicit.
The processor does not modify the participant's mute or push-to-talk state.
An optional `AbortSignal` immediately cancels an in-flight initialization and
destroys its worklet. Microphone processor lifecycle generations prevent a late
initialization or old error callback from recreating or muting a newer graph.

The checked-in `src/neural-noise.worklet.js` retains the runtime and framing code
from the upstream 0.4.1 GTCRN worklet. Signal replaces only the AudioWorklet
processor adapter to add readiness, bounded initialization and fault reporting.
When upgrading that dependency, review the runtime, frame size, asset and
license notices together.

## Licenses and sources

- [GTCRN model and implementation](https://github.com/Xiaobin-Rong/gtcrn): MIT.
- [GTCRN Wasm](https://github.com/sapphi-red/gtcrn-wasm): MIT; embedded model is
  MIT and FFT uses the FFTPACK / UCAR terms.
- [Web Audio wrapper](https://github.com/sapphi-red/web-noise-suppressor): MIT.

Full notices are in `public/licenses/neural-noise.txt`, included in the web build
and appended to `desktop/THIRD-PARTY-LICENSES.txt` by the desktop license builder.
No quality equivalence with proprietary Krisp is claimed. Published upstream
benchmarks compare GTCRN with RNNoise, but Signal has not yet measured listening
quality or end-to-end latency on the user's devices.
