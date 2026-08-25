# Playlist Utils

A Firefox extension that reorders YouTube playlists — sort presets plus manual
drag and drop — and remembers the order per playlist. Works on desktop Firefox
and Firefox for Android.

## Features

**Order menu.** An `Order` button appears next to YouTube's own playlist
controls, offering:

| Option | Result |
|---|---|
| Original | The author's ordering |
| Reverse | Last episode first |
| Chronological | Oldest published first |
| Chrono-flipped | Newest published first |
| Most views | Most watched first |
| Least views | Least watched first |

**Drag and drop.** Every row gets a grab handle. Drag it with a mouse, or on a
touch screen drag the handle or press and hold anywhere on the row. Rows shift
out of the way as you drag, and the list auto-scrolls near the edges. Dropping
saves a custom order for that playlist.

The chosen order is stored per playlist and reapplied on your next visit.

## Where it works

| Surface | URL |
|---|---|
| Playlist page | `youtube.com/playlist?list=…` |
| Show page | `youtube.com/show/VL…` |
| Watch page panel | `youtube.com/watch?v=…&list=…` |
| Mobile equivalents | `m.youtube.com/…` |

`/show/VLxxx` and `/playlist?list=xxx` are the same playlist, so they share one
saved order.

## How it works

The extension never rearranges YouTube's DOM. It makes the list container a
column flexbox and gives each row a CSS `order`. YouTube's own re-renders
therefore cannot fight it, and "Original" is always recoverable because the
underlying document order is left untouched.

Sorting by date or views needs values YouTube does not always render, so the
extension reads them from the same InnerTube `player` endpoint the site itself
uses (~10 KB per video, sent without credentials, cached indefinitely for dates
and for a week for view counts). While that runs, the list is sorted
immediately using the approximate "3 weeks ago" / "481K views" labels already on
the page, then refined.

### Upload date vs publish date

`player` reports a video's **upload** date. For anything published later than it
was uploaded — members-early-access, scheduled posts — that is not the date
YouTube displays, and sorting by it puts the video in the wrong place. The
extension detects this by checking the exact date against the row's own
"x ago" label, and for the videos that disagree it fetches the displayed date
instead. That second lookup is much heavier, so it is used only where needed and
capped per pass.

## Known limitations

- **The order is visual, and local to your browser.** These playlists are not
  yours to edit, so nothing is sent to YouTube and nothing changes for anyone
  else.
- **Autoplay still follows YouTube's order.** YouTube picks the next video from
  its own internal playlist state, which the extension does not touch — the
  "Next:" label on the watch page keeps showing YouTube's next item, not yours.
- A global sort needs the whole playlist, so the extension loads the remaining
  pages first. On very long playlists that takes a moment.
- On the new playlist-page layout, flexing the list adds ~16px of space at the
  very bottom (a collapsed margin that flex does not collapse).

## Install

The extension is unsigned, so Firefox release will only load it temporarily.

**Desktop** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on*
→ pick `dist/manifest.json`. Gone when Firefox restarts.

**Android** — enable *Settings → Advanced → Remote debugging via USB*, plug the
phone in, then:

```bash
npm run build && npm run start:android
```

For an install that survives a restart the add-on has to be signed by
addons.mozilla.org (`web-ext sign --channel=unlisted`), which needs an AMO API
key.

## Development

```bash
npm install
npm run build      # bundle to dist/
npm run watch      # rebuild on change
npm run typecheck
```

`scripts/` also holds the tooling used to verify behaviour on real devices:
`rdp.py` (a minimal Firefox remote-debugging client), `ff_desktop.py` (launches
a scratch Firefox and installs the extension over RDP), and `verify_full.py`
(diffs the order a device actually applied against independently fetched dates).

### Layout

```
src/content/
  index.ts       orchestration, SPA navigation, re-applying after re-renders
  surface.ts     finds the list container and rows across YouTube's layouts
  order.ts       order computation and application via CSS `order`
  dnd.ts         pointer-based drag and drop (mouse and touch)
  metadata.ts    publish dates and view counts, with caching
  menu.ts        the button and its popup
  store.ts       persistence
```
