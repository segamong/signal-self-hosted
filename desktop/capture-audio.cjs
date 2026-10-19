'use strict';

// Electron's restrictOwnAudio capture uses Windows process loopback. Earlier
// builds must keep screen capture video-only rather than use unfiltered audio.
// https://learn.microsoft.com/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params
function supportsOwnAudioExclusion(platform, release) {
  if (platform !== 'win32' || typeof release !== 'string'
    || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(release)) return false;
  const parts = release.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const [major, minor, build] = parts;
  return major > 10 || (major === 10 && (minor > 0 || build >= 20348));
}

module.exports = { supportsOwnAudioExclusion };
