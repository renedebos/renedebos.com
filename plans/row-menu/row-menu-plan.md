# A row overflow menu: one "…" instead of three controls

Status: **tasks 1-7 done, 2026-08-23** (branch `row-menu`, unpushed). Play
next / Add to queue remain parked — see §2a. Originally written as:
**planned, not started.** Written 2026-08-22 from Rene's ask, after he
pointed at Amazon Music and Spotify: *"they use a menu icon (…) to show a list
of options. Would that work for our audio player?"* — and then, on the one
point where I recommended otherwise: *"the download is part of the menu items
behind the (…)"*.

## 1. What exists today (verified against the built pages, 2026-08-22)

A **show-page** track row carries four controls:

| control | what it is |
|---|---|
| `.play-btn` | play/pause — since `051db771` it also *is* the track number (`::before`) |
| `.download-btn` | `<a>`, password-gated FLAC, carries the −14 variant as `data-lossy-*` |
| `.track-share` | `<a>` to `/t/{code}/`, **active row only** — there was no room otherwise |
| `.track-add` | add to the playlist selection |

A **song-page occurrence row** carries a *different* set: `.track-open` (↗ to
the show page) instead of a download — **song rows have no download at all**
(measured: 0 download buttons, 25 ↗ links on `/songs/truck/`).

And there is a fifth thing that is not a control and cannot be reached on a
phone:

- **`data-info`** on the title — Artist, Song, Venue, Date, Format, Size,
  Process version. Bound in `player.js` to `mouseover`/`mouseout` **only**.
  On touch it has never opened, not once. Seven fields of the archive's own
  provenance, invisible on the device most visitors use.

That last point is the actual argument for this work. The crowding is real,
but a menu is the only place that information could ever live.

## 2. The decision

**One `…` per row. Everything except play goes behind it — download
included.**

I argued for keeping the download arrow on the row, on the grounds that this
is an archive and the FLAC is the point, so a two-tap download is a
downgrade. Rene overruled it, and the case for his call is good: a row with
exactly two controls (play, menu) is a far simpler object than one with
three-and-a-half, the download is one tap *plus* a password modal either way,
and every music app people already use puts it there. Recorded here so the
reasoning is not relitigated from scratch later.

### What the row becomes

```
[02]  Illegal Smile                          0:00 / 2:57   ⋯
[▮▮]  Smoke in Heaven   ▁▃▅▇▅▃▁▂▄▆█▆▄▂▁      0:02 / 2:28   ⋯
```

### What the menu holds

| item | today |
|---|---|
| **Download** (password modal, with its version chooser) | on show rows only |
| **Share this song** | active row only |
| **Add to playlist** | on the row |
| **Track info** — venue, date, source, format, size, process version | **hover only; unreachable on touch** |
| **All N recordings of this song** → `/songs/{slug}/` | nowhere |
| **Open on show page** → `/shows/{slug}/#track-N` | song rows only (↗) |

Three of those six are currently either hidden or impossible on a phone. The
menu is not just a container for what the row already had.

**Unification is a side effect worth taking:** the three renderers currently
disagree about which controls a row gets. One menu builder, fed per-row data,
ends that — and song rows gain a download they never had.

## 2a. Contents, settled 2026-08-23 (supersedes the table in §2)

Rene brought an Amazon Music track sheet as the reference and proposed eight
items. Four conventions from that sheet were taken wholesale, and they are the
part worth keeping even if the item list changes again:

- an icon on **every** row, left-aligned, same size;
- a hairline rule between rows;
- a trailing chevron on rows that **navigate**, none on rows that **act** — it
  tells you before you press whether the menu will do something or take you
  somewhere;
- "Dismiss" as plain centred text, not a bordered button.

Icons are drawn to match `sitegen/fragments.py`'s existing set (24x24,
`fill:none`, `stroke:currentColor`, stroke-width 2, round caps) rather than
lifted from another library — this menu sits on the same page as those glyphs.

### What ships

| # | item | icon | notes |
|---|---|---|---|
| 1 | **Download** | download | no sub-label (Rene, 2026-08-23) — the password modal shows format and size before any byte moves, and a second line made this the only two-line row; format stays in the accessible name |
| 2 | **Add to playlist** | playlist | flips to "Remove from playlist"; state rendered at build time (§7) |
| 3 | **Share this song** | share | |
| — | *rule* | | actions above, navigation below |
| 4 | **View show** | show | chevron; suppressed when already on that show page |
| 5 | **All N recordings of this song** | song | chevron; no Amazon analogue, and the best thing this archive has that a streaming service does not |
| 6 | **Recording details** | info | chevron; opens a **second pane**, not an inline block |

### Three decisions behind that list

**Like: dropped (Rene, 2026-08-23).** There are no user accounts — the site is
static pages, a Worker, R2, and one KV namespace holding playlist short links.
A Like is therefore either localStorage (private, invisible, gone with site
data) or KV-backed with an anonymous id (rate limiting, abuse, moderation).
Either way it needs a "your likes" surface or it is a button with no
perceptible effect — a feature, not a menu item, and one that overlaps what
playlists already do here. Not built.

**Play next / Add to queue: parked, not rejected.** `PlaybackController`
already has `appendQueue()`, `reorder()`, `removeAt()`, so both compose from
existing primitives — no new architecture. The blocker is that `QueueView` is
mounted only by `playlist-boot.js` and the mini-player bar, so **a show page
has no visible queue**: both items would silently mutate something the visitor
cannot see or reorder. They are additive whenever a visible queue exists (the
bar is the natural home). That is a bigger UX decision than this menu and
should be taken on its own terms.

**Recording details is a pane, not an inline block.** Seven rows of provenance
nearly doubled the menu's height — measured on the live page, where it pushed
the desktop popover off the bottom of the viewport. Behind a chevron it fixes
the height *and* matches the reference.

### Two bugs this section cost, both fixed

- **Synchronous pane swaps orphan the clicked item.** Rebuilding the menu
  inside the click handler detaches the pressed row, so the document-level
  dismiss handler's `closest('.row-menu')` walks a parentless node, concludes
  the click was outside, and closes everything — the pane opened and vanished
  in one tick. Same mechanism as the 2026-08-22 row-click double-fire. Every
  DOM change now waits for the event to finish; see `defer()`.
- **`placeNear()` only clamped downwards.** Safe while its only caller was the
  mini-player's two-row popover anchored to a bar at the foot of the viewport;
  wrong for a six-row menu anchored to a row anywhere in a long list. Now
  clamped in both directions. A menu taller than the viewport still needs a
  max-height and internal scrolling — that belongs with the CSS in task 6.

## 3. Delivery: sheet on touch, popover on desktop

`share.js` already makes exactly this choice, by pointer type rather than by
browser (`wantsSheet()` → `matchMedia('(pointer: coarse)')`), and its
`.share-pop` is already an anchored popover with outside-click, Escape,
scroll-close and resize-close. **Generalise that, do not write a second one.**

- **Coarse pointer:** a bottom sheet, like the Amazon screenshot — full
  width, large rows, a Dismiss affordance. Thumb-reachable at the bottom of
  the screen, which an anchored popover near the top of a list is not.
- **Fine pointer:** the anchored popover, positioned by the existing
  `place()`.

The share popover then becomes *one item inside* this menu rather than its
own control, which removes a component rather than adding two.

## 4. The trap that would ship green

`player.js` binds the password modal like this:

```js
document.querySelectorAll('a.download-btn').forEach(btn => { … })
```

A **one-time snapshot at load.** A download rendered inside a menu that is
created on first press has no such listener, so the click follows the `href`
— which points at `/stream?file=…FLAC…`, and the wav-download Worker **403s
every `.flac` on `/stream` by design**. The visitor gets a 403 instead of the
password modal, the page throws nothing, and every test stays green.

**So: the download interception must become delegated** (one `document`
listener matching `e.target.closest('a.download-btn')`) *before* the button
moves. Same for `.zip-download-btn` if it ever moves. This is the single
highest-risk item in the plan and it is invisible from the markup.

## 5. Accessibility contract

The row's controls are today real `<button>`/`<a>` elements, which is what
makes the list keyboard-operable at all (no `.track-row` is focusable — see
`site.css`'s note on the play button). The menu must not regress that:

- The trigger is a `<button>` with `aria-haspopup="menu"` and
  `aria-expanded`, labelled per row (`Options for Illegal Smile`) — never a
  bare "More", of which there would be thirty on a page.
- The menu is `role="menu"`, items `role="menuitem"`, arrow keys move, Escape
  closes and **returns focus to the trigger**.
- Opening must not trap focus behind an element that scroll-closes: the
  existing popover closes on scroll, which is right for a hover-ish popover
  and wrong for a focused menu. Decide per delivery — the sheet should not
  close on scroll.
- The password modal is itself a dialog. Opening it *from* the menu means
  closing the menu first and handing focus to the modal, or two focus traps
  fight. Test this specifically.

## 6. Tasks, in order (each leaves the site working)

1. **Delegate the download binding** in `player.js` and prove it still works
   from a row — no markup change yet. This is the trap in §4, defused first
   and independently verifiable.
2. **`scripts/row-menu.js`** — the component. Built on `share.js`'s popover;
   sheet vs popover by pointer type; full keyboard contract. Lazily imported
   on first press, as `share.js` already is.
3. **One menu-item builder**, fed from the row's `data-item` (which already
   carries title, artist, venue, date, `shareUrl`, `pageUrl`, `downloads`)
   plus `data-info`. No new data plumbing should be needed — confirm before
   building.
4. **Swap the row markup** in all three renderers: `show_track_row()` and
   `_song_occ_html()` (fragments.py) and `occRowHtml()` (songs.js). Delete
   `.track-share`, `.track-add`, `.download-btn`, `.track-open` from the row.
5. **Track info into the menu** — the win. Keep the desktop hover tooltip or
   retire it; decide once the menu exists rather than now.
6. **CSS**: the sheet, the menu, and the removal of four now-dead row rules.
7. **Tests**: `test-row-menu.mjs` (contents per row type, keyboard, Escape
   focus return, the download hand-off); `browser_check.mjs` gains a real
   touch-tap opening the sheet and a real download click reaching the
   password modal.

## 6a. What actually shipped, and where it differed from this plan

- **Tasks 4 and 6 were done together**, not in sequence. Separately neither
  leaves the site working: 4 alone strips the controls and renders an unstyled
  menu, 6 alone styles something nothing shows.
- **Task 5 folded into task 3.** Track info arrived as the details pane the
  moment the builder existed. The sub-decision it deferred — keep or retire the
  desktop hover tooltip — was settled as **keep**: hover is instant and free on
  a mouse, and the menu exists because hover never worked on touch. Retiring it
  would make desktop worse to fix a phone problem.
- **§3 was right that the shared popover should be generalised**, and the cost
  of not having done so earlier showed up immediately: `placeNear()` only
  clamped downwards, which cut items off the bottom of the menu.
- **The dead-code sweep went further than "four now-dead row rules."** Also
  removed: `track_share_button()`, `track_add_button()`, `OPEN_SVG`,
  `PLUS_SVG` and `SHARE_SVG` from fragments.py; `window.trackShareButtonHtml`,
  its `SHARE_SVG`, the `.track-share` click branch and `shareRow()` from
  track-select.js. **Kept deliberately:** `trackAddButtonHtml` and the base
  `.track-add` rules (still rendered by playlist-views.js on `/playlist/`
  rows, which §7 puts out of scope), the base `.download-btn` rules (whole-show
  recording cards still carry one), and `.zip-download-btn`.

## 7. Risks and open questions

- **Two taps to download.** Accepted (§2), but worth watching: if the
  archive's own download rate drops, this is the first thing to look at.
- **Discoverability.** A `…` hides what is behind it. The counter is that
  three of the six items are hidden or impossible *today*.
- **The active-row waveform.** On a phone the active row already spends a
  second line on the waveform; check the menu trigger does not push the
  layout the way the share control did (see `track-share-plan.md` §10.1 for
  the measurements that fix cost).
- **`/playlist/` rows are a different view** (`QueueView`, `.pl-row`) and are
  out of scope here. Decide separately whether they get the same menu.
- **Anything else that snapshots row controls at load?** Grepped rather than
  assumed (2026-08-22). Two things touch row controls at load, and only one
  is the §4 trap:

  - `player.js:679` — the download binding. **The trap.** Fix first.
  - `track-select.js:130` — `querySelectorAll('.track-add[data-id]')` in
    `syncAllButtons()`. This one is *not* a click binding (that is properly
    delegated); it **paints** each add-button against the stored selection at
    load and whenever `window.syncTrackSelection` is called. A menu built on
    first press simply will not exist then, so the menu's "Add to playlist"
    item must **render its own on/off state from the store at build time**
    rather than expect to be painted afterwards. Cheap, but silent if missed:
    the item would always show "Add" even for an already-selected track.

  Everything else in that grep is unrelated (`.custom-player`, `.track-row.
  target`, `/songs/` filters). `share.js` is invoked by handler and safe.

## 8. Size

Realistically a few hours: a new component with a real keyboard contract,
three renderers, one delegation fix, and test coverage in two suites plus the
harness. Not a twenty-minute change, and it should not be attempted as one.

Verify on the real page, not a mockup. The merged track-number change was
sold on a mockup that promised the active row's title would stop wrapping;
on the live page it still wraps, because the mockup omitted the waveform row
and the share control. Measure the page.
