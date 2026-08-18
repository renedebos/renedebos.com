// Wires the Archive/Loud control on a page to the shared preference.
//
// Deliberately tiny and independent of PlaybackController: the controller
// subscribes to the same preference module and re-points itself, so this file
// only has to keep the buttons and the note in sync with the stored value.
// That means the control works identically on every surface, including ones
// whose rows are rendered client-side.

import { getVariant, setVariant, onVariantChange, watchStorage, VARIANTS }
  from './variant-pref.js';

const NOTE = {
  archive: '<strong>You are hearing the Archive version</strong> &mdash; the '
    + '&minus;20&nbsp;LUFS masters exactly as they were mastered. Switch to '
    + '<strong>Loud</strong> for an extra render at &minus;14&nbsp;LUFS, about as loud as a '
    + 'streaming service. Downloads are always the Archive version. '
    + '<a href="/process/">How these were made</a>.',
  loud: '<strong>You are hearing the Loud version</strong> &mdash; an extra render at '
    + '&minus;14&nbsp;LUFS, about as loud as a streaming service, so it isn’t too quiet '
    + 'on phone speakers or in a car. Switch to <strong>Archive</strong> for the '
    + '&minus;20&nbsp;LUFS masters exactly as they were mastered. Downloads are always '
    + 'the Archive version. <a href="/process/">How these were made</a>.',
};

function paint(root, v) {
  root.querySelectorAll('[data-variant]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.variant === v));
  });
  const note = root.querySelector('[data-variant-note]');
  if (note && NOTE[v]) note.innerHTML = NOTE[v];
}

export function initVariantUI(doc) {
  const d = doc || document;
  const roots = Array.from(d.querySelectorAll('[data-variant-pick]'));
  if (!roots.length) return;
  const apply = (v) => roots.forEach((r) => paint(r, v));
  apply(getVariant());
  roots.forEach((root) => {
    root.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-variant]');
      if (!btn) return;
      const want = btn.dataset.variant;
      if (!VARIANTS.includes(want)) return;   // markup is not trusted blindly
      setVariant(want);                        // controller re-points itself
    });
  });
  // Repaint when the value changes anywhere — this tab or another one.
  onVariantChange(apply);
  watchStorage();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initVariantUI());
  } else {
    initVariantUI();
  }
}
