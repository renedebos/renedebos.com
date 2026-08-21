// Loudness-variant preference — which render of a track the player streams.
//
// The archive is -20 LUFS and remains the master and the download. The "loud"
// variant is an additional -14 LUFS render (see CLAUDE.md, "The -14 loud
// variant"). Rene's decision 2026-08-18: LOUD IS THE DEFAULT, because -20 is
// too quiet in a car or on phone speakers, and the page says so in plain words
// rather than leaving the visitor to work it out.
//
// Kept in its own module, not inside PlaybackController, because three
// independent things need it: the controller (which URL to stream), the toggle
// UI (which button is pressed), and any surface that renders rows client-side.

export const VARIANTS = ['archive', 'loud'];
export const DEFAULT_VARIANT = 'loud';
const KEY = 'hannanVariant';
export const CHANGE_EVENT = 'hannanvariantchange';

const listeners = new Set();

// A stored value is untrusted input: it can be stale from an older build, hand
// -edited, or corrupted. Validate against the enum rather than passing it
// through to a URL lookup — an unrecognised value must fall back, never 404.
export function coerceVariant(value) {
  return VARIANTS.includes(value) ? value : DEFAULT_VARIANT;
}

export function getVariant() {
  try {
    return coerceVariant(localStorage.getItem(KEY));
  } catch (_) {
    // Private mode / storage disabled: the feature degrades to the default
    // rather than throwing on every read.
    return DEFAULT_VARIANT;
  }
}

// One notification path for every source of a change (this tab's setVariant,
// another tab's storage event). It fires the module subscribers AND a DOM
// CustomEvent on window: classic scripts (player.js) cannot import this module and, being parsed before it, cannot even rely on
// the window bridge below existing yet at their own boot time — but they can
// always add an event listener. See the bridge comment at the bottom.
function notify(v) {
  listeners.forEach((fn) => { try { fn(v); } catch (_) { /* one bad subscriber */ } });
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { variant: v } }));
  }
}

export function setVariant(value) {
  const v = coerceVariant(value);
  try { localStorage.setItem(KEY, v); } catch (_) { /* not fatal */ }
  notify(v);
  return v;
}

export function onVariantChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Cross-tab sync. `storage` fires only in OTHER tabs, and per the project's
// standing rule its `newValue` is a wake-up signal, never the source of truth —
// it can be stale by delivery, so re-read and re-validate instead.
export function watchStorage(target) {
  const handler = (e) => {
    if (e && e.key !== null && e.key !== KEY) return;
    notify(getVariant());
  };
  (target || window).addEventListener('storage', handler);
  return () => (target || window).removeEventListener('storage', handler);
}

// Which URL a given playable item should stream under the active preference.
// Falls back to the archive whenever the variant does not exist for that track,
// so a partial rollout is silently correct rather than broken.
export function srcForItem(item, variant) {
  if (!item) return '';
  const v = coerceVariant(variant === undefined ? getVariant() : variant);
  if (v === 'loud' && item.loudUrl) return item.loudUrl;
  return item.streamUrl;
}

// ── bridge for classic (non-module) scripts ─────────────────────────────────
// player.js is a classic script and cannot `import`. Rather than let it
// re-implement the enum/localStorage handling (one more place to get the
// fallback wrong), it reads this one object. It is defined
// as a side effect of loading this module, so a classic script MUST null-check
// it: on a page that never loads the variant UI the global is absent and the
// caller correctly falls back to the archive URL already in its markup.
if (typeof window !== 'undefined') {
  window.HannanVariant = {
    get: getVariant,
    set: setVariant,
    onChange: onVariantChange,
    srcForItem,
    CHANGE_EVENT,
    DEFAULT: DEFAULT_VARIANT,
  };
}
