import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsOwnAudioExclusion } from '../desktop/capture-audio.cjs';

test('consumer Windows 10 releases do not enable unsupported process loopback', () => {
  for (const release of ['10.0.17763', '10.0.19041', '10.0.19044', '10.0.19045', '10.0.20347']) {
    assert.equal(supportsOwnAudioExclusion('win32', release), false, release);
  }
});

test('process loopback starts at build 20348 and is available on Windows 11', () => {
  for (const release of ['10.0.20348', '10.0.22000', '10.0.22631', '10.0.26100', '10.0.26200', '10.0.26100.1']) {
    assert.equal(supportsOwnAudioExclusion('win32', release), true, release);
  }
});

test('missing or malformed OS versions never claim audio exclusion', () => {
  for (const release of [undefined, null, 20348, '', '11', '10.0', '10.0.20348suffix', '10.0.NaN', '-10.0.20348', '11.bad.0', '10.0.999999999999999999999']) {
    assert.equal(supportsOwnAudioExclusion('win32', release), false, String(release));
  }
});

test('other operating systems never claim Windows loopback capability', () => {
  for (const platform of ['linux', 'darwin', 'freebsd', undefined]) {
    assert.equal(supportsOwnAudioExclusion(platform, '10.0.26100'), false, String(platform));
  }
});
