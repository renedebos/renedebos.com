// Wires the Archive/Loud control on a page to the shared preference.
//
// Deliberately tiny and independent of PlaybackController: the controller
// subscribes to the same preference module and re-points itself, so this file
// only has to keep the buttons and the note in sync with the stored value.
// That means the control works identically on every surface, including ones
// whose rows are rendered client-side.

import { getVariant, setVariant, onVariantChange, watchStorage, VARIANTS }
  from './variant-pref.js';

// Both notes are SERVED in the markup (variant_toggle() in
// sitegen/fragments.py) and this only picks which one is shown. This file used
// to hold its own copy of the prose and overwrite the served markup on first
// paint -- which silently reverted the 2026-08-19 download update, putting
// "Downloads are always the Archive version" back on screen after the server
// had sent the corrected sentence. Keep note text out of this file.
function paint(root, v) {
  root.querySelectorAll('[data-variant]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.variant === v));
  });
  root.querySelectorAll('[data-variant-note-for]').forEach((n) => {
    n.hidden = n.dataset.variantNoteFor !== v;
  });
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
