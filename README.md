# Playlist Utils

A small Firefox extension that reorders YouTube playlists and remembers the order you picked.

YouTube only lets you reorder playlists you own. This one reorders them in your browser instead, so it works on anybody's playlist. Nothing is sent to YouTube and nobody else sees a difference.

## What it does

An **Order** button appears next to YouTube's own playlist controls, both on the playlist page and in the panel beside the player:

- **Original**, the author's ordering
- **Reverse**
- **Chronological**, oldest published first
- **Chrono-flipped**, newest published first
- **Most views**
- **Least views**

Every row also gets a grab handle, so you can drag videos wherever you want them. On a phone, drag the handle or press and hold a row. Whatever you choose is saved per playlist and comes back next time.

Works on desktop Firefox and on Firefox for Android.

## Things worth knowing

Autoplay still follows YouTube's order, not yours. The extension changes what you see; YouTube picks the next video from its own state, which it does not expose.

Sorting by date or views needs numbers YouTube does not always render, so those come from the same internal API the site itself calls, without credentials, and are cached. Sorting a long playlist for the first time takes a moment.

It reads YouTube's own "3 weeks ago" and "481K views" labels to sort instantly while the exact values load. Those are English only. In another language it still sorts correctly, just without the instant preview.

## Install

Grab it from addons.mozilla.org, on desktop or on Android.

To run it from source on desktop, load `dist/manifest.json` at `about:debugging`. For Android you need *Remote debugging via USB* turned on in Firefox, then `npm run start:android` with the phone plugged in.

## Build

```bash
npm install
npm run build
```

`npm run typecheck` for types, `npm run watch` while working.

## Licence

MIT.
