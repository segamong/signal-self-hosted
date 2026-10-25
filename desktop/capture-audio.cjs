'use strict';

// Chromium gates restrictOwnAudio on Windows 11, even though the underlying
// process-loopback API also exists in some Windows Server builds. Match the
// browser gate: advertising the lower OS API minimum would promise filtering
// that Electron cannot negotiate on those systems.
// https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/media/base/media_switches.cc
function supportsOwnAudioExclusion(platform, release) {
  if (platform !== 'win32' || typeof release !== 'string'
    || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(release)) return false;
  const parts = release.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const [major, minor, build] = parts;
  return major > 10 || (major === 10 && (minor > 0 || build >= 22000));
}

module.exports = { supportsOwnAudioExclusion };
