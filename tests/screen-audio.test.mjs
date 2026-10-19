import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const temporary = await mkdtemp(join(tmpdir(), 'signal-screen-audio-tests-'));
after(async () => {
  const target = resolve(temporary);
  assert.ok(target.startsWith(resolve(tmpdir(), 'signal-screen-audio-tests-')));
  await rm(target, { recursive: true, force: true });
});
const source = await readFile(new URL('../src/screenAudio.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const compiledPath = join(temporary, 'screenAudio.mjs');
await writeFile(compiledPath, compiled);
const { screenAudioCaptureOptions, allowScreenAudio, filterScreenAudio } = await import(pathToFileURL(compiledPath).href);

test('request own-audio exclusion and avoid offering system audio when browser cannot filter it', () => {
  const unsupported = screenAudioCaptureOptions(true, {});
  assert.equal(unsupported.systemAudio, 'exclude');
  assert.equal(unsupported.audio.restrictOwnAudio, true);
  assert.equal(screenAudioCaptureOptions(true, { restrictOwnAudio: false }).systemAudio, 'exclude');
  assert.equal(screenAudioCaptureOptions(true, { restrictOwnAudio: true }).systemAudio, 'include');
  assert.equal(screenAudioCaptureOptions(true, {}, true).systemAudio, 'include');
  assert.deepEqual(screenAudioCaptureOptions(false, { restrictOwnAudio: true }, true), { audio: false, systemAudio: 'exclude' });
});

test('reject unconfirmed loopback even when support was advertised, preserving separate-tab audio', () => {
  for (const displaySurface of ['monitor', 'window', undefined, 'unexpected']) {
    assert.equal(allowScreenAudio({}, displaySurface), false);
    assert.equal(allowScreenAudio({ restrictOwnAudio: false }, displaySurface), false);
    assert.equal(allowScreenAudio({ restrictOwnAudio: true }, displaySurface), true);
    assert.equal(allowScreenAudio({}, displaySurface, true), true);
  }
  assert.equal(allowScreenAudio({}, 'browser'), true);
  assert.equal(allowScreenAudio({ restrictOwnAudio: false }, 'browser'), true);
});

function fakeTrack(kind, settings, failSettings = false) {
  return {
    kind, stopped: false,
    getSettings() { if (failSettings) throw new Error('unsupported settings'); return settings; },
    stop() { this.stopped = true; },
  };
}
function fakeStream(videoTracks, audioTracks) {
  const tracks = [...videoTracks, ...audioTracks];
  return {
    getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
    getAudioTracks: () => tracks.filter(track => track.kind === 'audio'),
    removeTrack(track) { tracks.splice(tracks.indexOf(track), 1); },
  };
}

test('remove and stop unsafe system audio without stopping the screen or filtered audio', () => {
  const screen = fakeTrack('video', { displaySurface: 'monitor' });
  const unsafe = fakeTrack('audio', {});
  const safe = fakeTrack('audio', { restrictOwnAudio: true });
  const stream = fakeStream([screen], [unsafe, safe]);
  const result = filterScreenAudio(stream);
  assert.equal(result.removedCount, 1);
  assert.equal(result.retainedCount, 1);
  assert.ok(result.warning.includes('вкладку'));
  assert.equal(unsafe.stopped, true);
  assert.equal(safe.stopped, false);
  assert.equal(screen.stopped, false);
  assert.deepEqual(stream.getAudioTracks(), [safe]);
});

test('unknown or failing source settings cannot accidentally publish whole-system audio', () => {
  for (const videos of [[], [fakeTrack('video', {}, true)]]) {
    const audio = fakeTrack('audio', {}, true);
    const stream = fakeStream(videos, [audio]);
    assert.equal(filterScreenAudio(stream).removedCount, 1);
    assert.equal(audio.stopped, true);
    assert.deepEqual(stream.getAudioTracks(), []);
  }
});

test('separate-tab and trusted desktop sharing retain audio; audio-less shares show no warning', () => {
  const tabAudio = fakeTrack('audio', {});
  const tab = fakeStream([fakeTrack('video', { displaySurface: 'browser' })], [tabAudio]);
  assert.deepEqual(filterScreenAudio(tab), { removedCount: 0, retainedCount: 1 });
  assert.equal(tabAudio.stopped, false);
  const desktopAudio = fakeTrack('audio', {});
  assert.deepEqual(filterScreenAudio(fakeStream([], [desktopAudio]), true), { removedCount: 0, retainedCount: 1 });
  assert.equal(desktopAudio.stopped, false);
  assert.deepEqual(filterScreenAudio(fakeStream([], [])), { removedCount: 0, retainedCount: 0 });
});
