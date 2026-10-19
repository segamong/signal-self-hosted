import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleElementFullscreen } from '../src/fullscreen.ts';

function browser() {
  const owner = { fullscreenElement: null, exitFullscreen: async () => { owner.fullscreenElement = null; } };
  const element = { ownerDocument: owner, requestFullscreen: async () => { owner.fullscreenElement = element; } };
  return { owner, element };
}

test('the same fullscreen control expands then collapses repeatedly', async () => {
  const { owner, element } = browser();
  for (let cycle = 0; cycle < 2; cycle++) {
    await toggleElementFullscreen(element);
    assert.equal(owner.fullscreenElement, element);
    await toggleElementFullscreen(element);
    assert.equal(owner.fullscreenElement, null);
  }
});

test('browser Escape changes are respected by the next click', async () => {
  const { owner, element } = browser();
  await toggleElementFullscreen(element);
  await owner.exitFullscreen();
  await toggleElementFullscreen(element);
  assert.equal(owner.fullscreenElement, element);
});

test('a rejected transition leaves the browser state usable for retry', async () => {
  const { owner, element } = browser();
  const enter = element.requestFullscreen;
  element.requestFullscreen = async () => { throw new Error('request denied'); };
  await assert.rejects(toggleElementFullscreen(element), /request denied/);
  assert.equal(owner.fullscreenElement, null);
  element.requestFullscreen = enter;
  await toggleElementFullscreen(element);
  await toggleElementFullscreen(element);
  assert.equal(owner.fullscreenElement, null);
});
