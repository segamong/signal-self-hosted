/** Toggle the same element in both directions; the browser owns the state. */
export async function toggleElementFullscreen(element: HTMLElement, owner: Document = element.ownerDocument): Promise<void> {
  if (owner.fullscreenElement === element) {
    await owner.exitFullscreen();
  } else {
    await element.requestFullscreen({ navigationUI: 'hide' });
  }
}
