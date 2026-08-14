// Shared test harness for the player suites (test-player-views.mjs,
// test-player-boot.mjs). Just enough of the DOM/media surface those modules
// touch — hand-rolled rather than jsdom, matching how the rest of this
// project's scripts stay dependency-free.
//
// Deliberately NOT a rendering fake: no layout, no canvas, no real media. What
// it supports is the logic that decides what the DOM should say. Elements
// report clientWidth 0 unless a test sets one, so the inert-canvas draw path is
// skipped here and stays part of the manual browser checklist.

export class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...c) { c.forEach(x => this._set.add(x)); }
  remove(...c) { c.forEach(x => this._set.delete(x)); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this._set.has(c) : !!force;
    if (want) this._set.add(c); else this._set.delete(c);
    return want;
  }
}

// One compound selector: any mix of a tag name, #id, .class, [attr], and
// [attr="value"]. Enough for every selector the player modules use.
const COMPOUND = /^[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\]/g;

// Shared by FakeElement and FakeWindow — both need the real DOM's `{ signal }`
// option so player-boot.js's AbortController-scoped listeners (added for the
// Step 4 review's finding #1: handle.destroy() must actually remove them) get
// exercised here rather than only in a browser. `signal` is the real global
// AbortSignal (Node has one), not a fake — only the addEventListener/dispatch
// side needs faking.
function addListener(listeners, type, fn, opts) {
  const list = (listeners[type] ||= []);
  const entry = { fn };
  const signal = opts && opts.signal;
  if (signal) {
    if (signal.aborted) return;          // never registered, matching real DOM
    signal.addEventListener('abort', () => {
      const i = list.indexOf(entry);
      if (i !== -1) list.splice(i, 1);
    });
  }
  list.push(entry);
}
function dispatchListeners(listeners, type, evt) {
  // Snapshot before iterating: a handler that unmounts/removes another
  // listener for the same event must not skip or double-fire a sibling.
  (listeners[type] || []).slice().forEach(({ fn }) => fn(evt));
}

export class FakeElement {
  constructor(tag, classes = [], attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList();
    classes.forEach(c => this.classList.add(c));
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.style = {};
    this.id = '';
    this.innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.value = 0;
    this.clientWidth = 0;           // 0 => inert-canvas draw is skipped (no layout in Node)
    this.scrolledIntoView = false;
    this._listeners = {};
    Object.assign(this, attrs);
  }
  // Real DOM keeps className and classList in sync; the views set className on
  // elements they create, and querySelector then has to find them by class.
  get className() { return [...this.classList._set].join(' '); }
  set className(v) {
    this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  appendChild(el) { this.children.push(el); el._parent = this; return el; }
  remove() {
    if (!this._parent) return;
    const i = this._parent.children.indexOf(this);
    if (i !== -1) this._parent.children.splice(i, 1);
    this._parent = null;
  }
  // Views measure the waveform to turn a click into a position. Node has no
  // layout, so tests set _rect explicitly on the elements they click.
  getBoundingClientRect() { return this._rect || { left: 0, width: 0, top: 0, height: 0 }; }
  scrollIntoView() { this.scrolledIntoView = true; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(type, fn, opts) { addListener(this._listeners, type, fn, opts); }
  dispatch(type, evt = {}) { dispatchListeners(this._listeners, type, evt); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    // Descendant combinators only — that's all these modules use
    // (".track-list [data-item]").
    let nodes = [this];
    for (const part of String(sel).trim().split(/\s+/)) {
      const next = [];
      nodes.forEach(n => n._descendants(part, next));
      nodes = next;
    }
    return nodes;
  }
  _attr(name) {
    if (name.startsWith('data-')) {
      return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
    }
    return name === 'id' ? this.id : this.attributes[name];
  }
  _matches(sel) {
    const parts = String(sel).match(COMPOUND) || [];
    if (!parts.length) return false;
    return parts.every(p => {
      if (p[0] === '.') return this.classList.contains(p.slice(1));
      if (p[0] === '#') return this.id === p.slice(1);
      if (p[0] === '[') {
        const body = p.slice(1, -1);
        const eq = body.indexOf('=');
        if (eq === -1) return this._attr(body) !== undefined;
        return String(this._attr(body.slice(0, eq)))
          === body.slice(eq + 1).replace(/^["']|["']$/g, '');
      }
      return this.tagName === p.toUpperCase();
    });
  }
  _descendants(sel, out) {
    for (const c of this.children) {
      if (c._matches(sel)) out.push(c);
      c._descendants(sel, out);
    }
    return out;
  }
}

// A document is just a root element plus the few document-level members the
// player modules read.
export class FakeDocument extends FakeElement {
  constructor() {
    super('html');
    this.documentElement = this;
    this.activeElement = new FakeElement('div');
  }
  createElement(tag) { return new FakeElement(tag); }
}

export class FakeWindow {
  constructor({ hash = '', search = '' } = {}) {
    this.location = { hash, search };
    this.devicePixelRatio = 1;
    this._listeners = {};
  }
  addEventListener(type, fn, opts) { addListener(this._listeners, type, fn, opts); }
  dispatch(type, evt = {}) { dispatchListeners(this._listeners, type, evt); }
}

export class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.preload = ''; this._src = ''; this.currentTime = 0; this.duration = NaN;
    this.paused = true; this.error = null; this.playbackRate = 1;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.error = null; this.loadCount = (this.loadCount || 0) + 1; }
  load() { this.error = null; }
  play() {
    this.paused = false;
    queueMicrotask(() => { this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); });
    return Promise.resolve();
  }
  pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')); }
  simulateError(code = 4) { this.error = { code }; this.dispatchEvent(new Event('error')); }
}

export const wsInstances = [];
export class FakeWaveSurfer {
  static create(opts) { const ws = new FakeWaveSurfer(opts); wsInstances.push(ws); return ws; }
  constructor(opts) { this.opts = opts; this.destroyed = false; this._on = {}; }
  on(evt, fn) { (this._on[evt] ||= []).push(fn); }
  emit(evt, arg) { (this._on[evt] || []).forEach(fn => fn(arg)); }
  destroy() { this.destroyed = true; }
}

// ── module loading ─────────────────────────────────────────────────────────
// The browser modules import from absolute /assets/ URLs that only resolve in
// a browser. Rewrite those specifiers to something Node can resolve — the real
// controller by absolute file: URL, the WaveSurfer stub above — then import the
// result as a data: URL. (Relative specifiers can't survive the trip: a data:
// URL has no hierarchical base to resolve them against.)
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
// Exported so a test can execute a slice of a REAL classic script (player.js,
// wavesurfer.js) against the fake DOM, rather than only re-implementing what
// it's supposed to do — the Step 4 review's finding #4: no suite loaded
// either file, so their own engine-selection gates had zero coverage.
export const readScript = read;
const dataUrl = (src) => 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
export const controllerUrl = new URL('./player-controller.js', import.meta.url).href;

let viewsUrl = null;
export async function loadPlayerViews() {
  if (!viewsUrl) {
    globalThis.__FakeWaveSurfer = FakeWaveSurfer;
    viewsUrl = dataUrl(read('player-views.js')
      .replace("import WaveSurfer from '/assets/wavesurfer.esm.js';",
        'const WaveSurfer = globalThis.__FakeWaveSurfer;')
      .replace("from '/assets/player-controller.js';", `from '${controllerUrl}';`));
  }
  return import(viewsUrl);
}

// player-boot.js runs its bootstrap as a side effect of being imported — that
// IS the behavior under test — so every call gets a distinct module URL (a
// unique trailing comment) rather than a cached instance.
let bootSeq = 0;
export async function loadPlayerBoot() {
  await loadPlayerViews();
  const src = read('player-boot.js')
    .replace("from '/assets/player-controller.js';", `from '${controllerUrl}';`)
    .replace("from '/assets/player-views.js';", `from '${viewsUrl}';`)
    + `\n// instance ${++bootSeq}\n`;
  return import(dataUrl(src));
}
