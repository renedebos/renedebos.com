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

// Direct property assignment (`style.background = ...`) is what the row/hero
// views use; the mini-player publishes a custom property on <html> instead,
// which only the setProperty/removeProperty pair can express. Both work here,
// and a removed custom property reads back as '' exactly as in a browser.
export class FakeStyle {
  setProperty(name, value) { this[name] = String(value); }
  removeProperty(name) { const had = this[name]; delete this[name]; return had === undefined ? '' : had; }
  getPropertyValue(name) { return this[name] === undefined ? '' : this[name]; }
}

export class FakeElement {
  constructor(tag, classes = [], attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList();
    classes.forEach(c => this.classList.add(c));
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.style = new FakeStyle();
    this.id = '';
    this._rawHTML = '';             // set directly -- the innerHTML setter parses via
                                     // parseHTMLFragment(), which itself constructs
                                     // FakeElements and would recurse if routed through here
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
  // The playlist views (playlist-views.js) build their markup from scratch
  // via innerHTML strings, unlike the player-views.js fixtures (which mutate
  // pre-built FakeElement trees) -- so a real, if minimal, parser is needed
  // here, plus closest() for their delegated click handlers.
  get innerHTML() { return this._rawHTML || ''; }
  set innerHTML(html) {
    this._rawHTML = html;
    this.children = parseHTMLFragment(html);
    this.children.forEach((c) => { c._parent = this; });
  }
  closest(sel) {
    let node = this;
    while (node) {
      if (node._matches && node._matches(sel)) return node;
      node = node._parent;
    }
    return null;
  }
  // Views measure the waveform to turn a click into a position. Node has no
  // layout, so tests set _rect explicitly on the elements they click.
  getBoundingClientRect() { return this._rect || { left: 0, width: 0, top: 0, height: 0 }; }
  scrollIntoView() { this.scrolledIntoView = true; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
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

// ── minimal innerHTML parser ────────────────────────────────────────────
// Just enough to parse the markup playlist-views.js actually generates:
// nested divs/spans/buttons/a/input plus inline SVG icons (which use
// self-closing tags like <polygon .../>). Not a real HTML parser (no
// entity table beyond what esc() in the real modules produces, no handling
// of unquoted attributes with special characters) -- deliberately narrow,
// same "just enough" philosophy as the rest of this file.
const VOID_TAGS = new Set(['input', 'br', 'img', 'hr']);
const TOKEN_RE = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
const ATTR_RE = /([a-zA-Z_:][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#9834;/g, '♪');
}

function parseAttrs(attrStr) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrStr))) {
    if (!m[1]) continue;
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[m[1]] = value;
  }
  return attrs;
}

export function parseHTMLFragment(html) {
  const root = new FakeElement('fragment');
  const stack = [root];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(html))) {
    const [, closing, tag, attrStr, selfClose, text] = m;
    const current = stack[stack.length - 1];
    if (text !== undefined) {
      current.textContent += decodeEntities(text);
      continue;
    }
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new FakeElement(tag);
    const attrs = parseAttrs(attrStr || '');
    for (const [k, v] of Object.entries(attrs)) {
      const dv = decodeEntities(v);
      if (k === 'class') el.className = dv;
      else if (k === 'id') el.id = dv;
      else if (k.startsWith('data-')) {
        el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = dv;
      } else {
        el.attributes[k] = dv;
        if (k === 'value') el.value = dv;
      }
    }
    current.appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag.toLowerCase())) stack.push(el);
  }
  return root.children;
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
  // player-boot.js/playlist-boot.js both use one or the other; only
  // playlist-boot.js needs getElementById (its markup is all id-addressed,
  // unlike show pages' class-selector-based ROW_SELECTOR/HERO_SELECTOR).
  getElementById(id) { return this.querySelector('#' + id); }
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

// The mini-player republishes --miniplayer-height from a ResizeObserver. Node
// has none, and there is no layout here to drive one anyway, so tests set the
// bar's _rect and call resize() to stand in for the browser firing it.
export const resizeObservers = [];
export class FakeResizeObserver {
  constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; resizeObservers.push(this); }
  observe(el) { this.targets.push(el); }
  disconnect() { this.disconnected = true; this.targets = []; }
  // What the browser does after a layout change — and, like the platform, does
  // NOT do once disconnect() has run. Delivery stays synchronous (the real one
  // is async, but nothing here tests delivery timing, and making it async would
  // force every height assertion to await for no property under test); the
  // no-op-after-disconnect half is modelled because a fake that outlives its
  // disconnect is exactly how a confidently-wrong test gets believed later.
  resize() { if (!this.disconnected) this.cb([], this); }
}

export class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.preload = ''; this._src = ''; this.currentTime = 0; this.duration = NaN;
    this.paused = true; this.error = null; this.playbackRate = 1;
  }
  get src() { return this._src; }
  // Assigning src runs the media element load algorithm, and that algorithm
  // SETS PAUSED TO TRUE (HTML standard, "media element load algorithm"). It is
  // modelled here because play()'s transition rule below makes it observable:
  // switching tracks assigns src first, so the play() that follows really is a
  // paused -> playing transition and really does fire play/playing — which is
  // why an ordinary track change works while calling play() on an untouched,
  // already-playing element does not.
  set src(v) {
    this._src = v;
    this.error = null;
    this.paused = true;
    this.loadCount = (this.loadCount || 0) + 1;
  }
  load() { this.error = null; this.paused = true; }
  // Fires play/playing ONLY on a paused -> playing transition, which is what
  // WHATWG's internal play steps do: calling play() on an element that is
  // already playing resolves the promise and fires nothing. The earlier version
  // queued both events unconditionally, and that lie hid a real bug — a view
  // calling play() on an already-playing element left the controller in
  // 'loading' forever, waiting for a `playing` event a browser never sends
  // (third-round review finding 2). A fake that asserts transitions the
  // platform does not make is worse than no fake.
  play() {
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    queueMicrotask(() => { this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); });
    return Promise.resolve();
  }
  pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')); }
  simulateError(code = 4) { this.error = { code }; this.dispatchEvent(new Event('error')); }
}

export const wsInstances = [];
export class FakeWaveSurfer {
  // A test sets this to simulate a real construction failure (e.g. a corrupt
  // peaks buffer, an unsupported codec) -- consumed once, so it targets
  // exactly the next create() call rather than breaking every test after it.
  static failNext = false;
  static create(opts) {
    if (FakeWaveSurfer.failNext) {
      FakeWaveSurfer.failNext = false;
      throw new Error('synthetic WaveSurfer.create failure');
    }
    const ws = new FakeWaveSurfer(opts); wsInstances.push(ws); return ws;
  }
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

// song-boot.js reuses player-views.js (plain PlayerView — every occurrence
// row is its own singleton, unlike player-boot.js's CompactPlayerView) —
// same rewrite/stub shape, same "importing it IS running the bootstrap"
// caveat as loadPlayerBoot().
let songBootSeq = 0;
export async function loadSongBoot() {
  await loadPlayerViews();
  const src = read('song-boot.js')
    .replace("from '/assets/player-controller.js';", `from '${controllerUrl}';`)
    .replace("from '/assets/player-views.js';", `from '${viewsUrl}';`)
    + `\n// instance ${++songBootSeq}\n`;
  return import(dataUrl(src));
}

// playlist-views.js has no WaveSurfer dependency to stub — a plain rewrite.
let playlistViewsUrl = null;
export async function loadPlaylistViews() {
  if (!playlistViewsUrl) {
    playlistViewsUrl = dataUrl(read('playlist-views.js')
      .replace("from '/assets/player-controller.js';", `from '${controllerUrl}';`));
  }
  return import(playlistViewsUrl);
}

// miniplayer-views.js imports player-controller.js and nothing else — that is
// a load-bearing property of the module (a WaveSurfer asset problem must not
// reach the pages the mini-player ships on), so the rewrite below is
// deliberately the ONLY specifier substitution: if the file ever grows a
// second /assets/ import, it fails to resolve here rather than passing
// silently. test-miniplayer-views.mjs asserts the same thing on the source
// text directly.
let miniplayerViewsUrl = null;
export async function loadMiniplayerViews() {
  if (!miniplayerViewsUrl) {
    miniplayerViewsUrl = dataUrl(read('miniplayer-views.js')
      .replace("from '/assets/player-controller.js';", `from '${controllerUrl}';`));
  }
  return import(miniplayerViewsUrl);
}

// Same "importing it IS running the bootstrap" shape as loadPlayerBoot().
// Also shrinks the catalog-fetch-local timeout (implementation review
// finding #6) to a test-scale duration -- every OTHER test's fake fetch
// resolves/rejects on a microtask well within this, so the substitution is
// unobservable there; only the dedicated never-resolving-fetch test actually
// needs to wait this long.
let playlistBootSeq = 0;
export const TEST_CATALOG_FETCH_TIMEOUT_MS = 20;
export async function loadPlaylistBoot() {
  await loadPlaylistViews();
  const src = read('playlist-boot.js')
    .replace("from '/assets/player-controller.js';", `from '${controllerUrl}';`)
    .replace("from '/assets/playlist-views.js';", `from '${playlistViewsUrl}';`)
    .replace('const CATALOG_FETCH_TIMEOUT_MS = 10000;', `const CATALOG_FETCH_TIMEOUT_MS = ${TEST_CATALOG_FETCH_TIMEOUT_MS};`)
    + `\n// instance ${++playlistBootSeq}\n`;
  return import(dataUrl(src));
}
