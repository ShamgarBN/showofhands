/**
 * True while a mouse button or finger is down. Pages hold off redrawing until it's
 * released, so a live update can't swap a button out from under a click.
 */
export const pointer = { down: false };
const afterRelease: (() => void)[] = [];
document.addEventListener('pointerdown', () => { pointer.down = true; }, true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    setTimeout(() => { // after the click event has fired
      pointer.down = false;
      afterRelease.splice(0).forEach(fn => fn());
    }, 0);
  }, true);
}

/** Run now, or right after the current press is released. */
export function whenReleased(fn: () => void) {
  if (pointer.down) afterRelease.push(fn);
  else fn();
}

/** Escape text before putting it into innerHTML. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
