import { installAutoplay } from './autoplay';
import { attachDrag, detachDrag, dragActive, ensureGrips } from './dnd';
import { log, warn } from './log';
import { buttonMounted, mountButton, refreshMenu, unmountButton, updateButtonLabel } from './menu';
import type { MenuCallbacks } from './menu';
import { cachedMeta, labelContradicts, refineDisplayedDates, resolveMeta } from './metadata';
import type { MetaNeed } from './metadata';
import {
  applyOrder,
  clearOrder,
  computeOrder,
  domMeta,
  metaNeedFor,
} from './order';
import { detectPage } from './page';
import type { PageInfo } from './page';
import { getPrefs, getSettings, setPrefs, setSettings } from './store';
import type { PlaylistPrefs, Settings, SortMode, VideoMeta } from './store';
import { nearestScroller, scrollToBottom, scrollToTop, scrollTopOf } from './scroll';
import { continuationSentinel, findSurface } from './surface';
import type { Row, Surface } from './surface';

const WATCHDOG_MS = 700;
const SURFACE_TIMEOUT_MS = 25_000;
const CONTINUATION_ROUNDS = 25;
/** How long a fruitless displayed-date lookup is taken at its word. */
const REFINE_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

let page: PageInfo | null = null;
let surface: Surface | null = null;
let prefs: PlaylistPrefs = { mode: 'original', custom: null, updatedAt: 0 };
let settings: Settings = { dragEnabled: true, autoplayFollowsOrder: true };
let statusText: string | null = null;
let lastOrder: string[] = [];
/**
 * Whether `lastOrder` was computed over the whole playlist from resolved
 * metadata, rather than being a preview painted from what was known at the time.
 */
let orderConfirmed = false;
/** The pass currently growing the list on purpose, or 0 when none is; see `refresh`. */
let loadingGen = 0;
let generation = 0;
let observer: MutationObserver | null = null;
let refreshTimer: number | null = null;
let lastUrl = location.href;

function setStatus(text: string | null): void {
  if (statusText === text) return;
  statusText = text;
  refreshMenu();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(120);
  }
  return predicate();
}

function rowIdSignature(target: Surface | null): string {
  return target ? target.rows.map((row) => row.videoId).join(',') : '';
}

/**
 * Any global sort needs the whole playlist, otherwise it would only reorder the
 * first page of a lazily loaded list. This runs behind an already-sorted list
 * rather than in front of it, so nothing waits on the scroll.
 */
async function loadAllItems(gen: number): Promise<void> {
  if (!page || !surface) return;

  // YouTube grows these lists two different ways: an explicit continuation
  // sentinel on playlist pages, and plain lazy rendering inside the watch
  // panel. Nudging both covers every surface.
  const scroller = nearestScroller(surface.container);
  const restoreWindow = window.scrollY;
  const restoreScroller = scrollTopOf(scroller);
  loadingGen = gen;

  try {
    for (let round = 0; round < CONTINUATION_ROUNDS; round += 1) {
      if (gen !== generation) return;

      const before = surface?.rows.length ?? 0;
      const childrenBefore = surface?.container.childElementCount ?? 0;
      setStatus(`Loading playlist… ${before} videos`);

      const sentinel = continuationSentinel(surface);
      if (sentinel) sentinel.scrollIntoView({ block: 'center' });
      else scrollToBottom(scroller);

      // Rescanning the DOM eight times a second is most of the cost of a load,
      // so an unchanged child count skips the scan. It cannot be trusted on its
      // own — a batch that appends a row and drops the spinner leaves the count
      // exactly where it started — so a real scan still runs a couple of times
      // a second regardless, which is well inside every round's deadline.
      let polls = 0;
      const grew = await waitUntil(() => {
        // Superseded: stop polling and let the round guard above do the bailing.
        if (gen !== generation || !page) return true;
        const idle = (surface?.container.childElementCount ?? 0) === childrenBefore;
        if (idle && polls++ % 4 !== 0) return false;
        const found = findSurface(page.kind);
        if (found) surface = found;
        return (surface?.rows.length ?? 0) > before;
      }, sentinel ? 5_000 : 1_200);

      if (!grew) break;
    }
  } finally {
    // Only clear the flag if a successor has not already claimed it.
    if (loadingGen === gen) loadingGen = 0;
    // Likewise the scroll: the successor took its own snapshot, and undoing its
    // scroll would fight it.
    if (gen === generation) {
      scrollToTop(scroller, restoreScroller);
      window.scrollTo({ top: restoreWindow });
      setStatus(null);
    }
  }
}

/**
 * A preview order is one derived from a partial list or unresolved metadata. It
 * is painted, but never handed to autoplay, which would otherwise send the user
 * to whatever video the half-finished sort happened to put next.
 */
function applyIds(ids: string[], provisional = false): void {
  if (!surface) return;
  lastOrder = ids;
  orderConfirmed = !provisional;
  applyOrder(surface, ids);
  if (settings.dragEnabled) ensureGrips(surface);
}

/**
 * Everything already known for these rows without touching the network: the
 * page's own "481K views • 3 weeks ago" labels, overlaid with whatever exact
 * values the cache holds.
 */
async function knownMeta(rows: Row[], need: MetaNeed): Promise<Map<string, VideoMeta>> {
  const meta = domMeta(rows);
  for (const [id, value] of await cachedMeta(rows.map((row) => row.videoId), need)) {
    meta.set(id, value);
  }
  return meta;
}

/**
 * Folds exact values into the display map, keeping the page's own label for any
 * video the lookup could not answer for. Without this a video whose fetch
 * failed loses the approximation it already had and drops to the bottom of the
 * list, which is what a throttled or partly offline pass used to look like.
 */
function overlay(into: Map<string, VideoMeta>, from: Map<string, VideoMeta>, need: MetaNeed): void {
  for (const [id, value] of from) {
    const known = need === 'date' ? value.publishedAt !== null : value.viewCount !== null;
    if (known) into.set(id, value);
  }
}

async function applyCurrentMode(options: { loadAll?: boolean } = {}): Promise<void> {
  if (!surface || !page) return;
  const gen = ++generation;
  const mode = prefs.mode;
  // A drag commits a custom order without starting a pass of its own, so the
  // mode is checked alongside the generation: once the user has placed a video
  // by hand, this pass's answer is no longer the one they asked for.
  const stale = (): boolean => gen !== generation || prefs.mode !== mode;

  if (mode === 'original') {
    applyIds(computeOrder(surface.rows, 'original'));
    setStatus(null);
    return;
  }

  const need = metaNeedFor(mode);
  if (!need) {
    // Reverse and custom cost nothing but the row list, and a partial answer
    // for them is not an approximation of the real one — reversing the first
    // twenty videos of two hundred is simply a different list. So they wait.
    if (options.loadAll !== false) {
      await loadAllItems(gen);
      if (stale()) return;
      surface = findSurface(page.kind) ?? surface;
    }
    applyIds(computeOrder(surface.rows, mode, { custom: prefs.custom }));
    return;
  }

  // Sort with what is already known before anything is fetched or loaded. On a
  // revisit the cache holds every value this needs, so the list is sorted about
  // one storage read after the surface exists, rather than after a round trip
  // to the bottom of the playlist and back.
  //
  // `shown` is what the list is sorted by and blends both sources. `exact` is
  // only ever what the API returned, because that is what gets persisted and
  // what the label comparison further down has to be made against.
  let shown = await knownMeta(surface.rows, need);
  if (stale()) return;
  applyIds(computeOrder(surface.rows, mode, { meta: shown }), true);

  if (options.loadAll !== false) {
    await loadAllItems(gen);
    if (stale()) return;
    surface = findSurface(page.kind) ?? surface;
    // Rows that arrived during the load have never been placed.
    shown = await knownMeta(surface.rows, need);
    if (stale()) return;
    applyIds(computeOrder(surface.rows, mode, { meta: shown }), true);
  }

  const exact = await resolveMeta(surface.rows.map((row) => row.videoId), need, {
    onProgress: ({ done, total, throttled }) => {
      // Stay quiet once superseded: a newer pass owns the status line, and a
      // drag has already cleared it.
      if (stale()) return;
      if (throttled) setStatus('YouTube is throttling lookups; sorting with what is known');
      else setStatus(done < total ? `Reading video details… ${done}/${total}` : null);
    },
    onBatch: (batch) => {
      // Converge as answers land rather than snapping once at the end — but
      // never out from under a drag, whose drop index is read back off the very
      // `order` values this would rewrite.
      if (stale() || !surface || dragActive()) return;
      overlay(shown, batch, need);
      applyIds(computeOrder(surface.rows, mode, { meta: shown }), true);
    },
    shouldStop: () => stale(),
  });
  if (stale()) return;

  overlay(shown, exact, need);
  surface = findSurface(page.kind) ?? surface;
  applyIds(computeOrder(surface.rows, mode, { meta: shown }));

  if (need === 'date') {
    // The player endpoint reports upload dates. Where that disagrees with the
    // row's own "x ago" label, the video was published later than it was
    // uploaded, and the displayed date is the one to sort by.
    const now = Date.now();
    const suspects = surface.rows
      .filter((row) => {
        const entry = exact.get(row.videoId);
        return entry?.publishedAt != null
          && entry.dateChecked !== true
          && (entry.refineAttemptedAt == null || now - entry.refineAttemptedAt > REFINE_RETRY_MS)
          && labelContradicts(entry.publishedAt, row.el.textContent ?? '');
      })
      .map((row) => row.videoId);

    if (suspects.length > 0) {
      setStatus(`Checking publish dates… ${suspects.length}`);
      const { refined, skipped } = await refineDisplayedDates(suspects, exact, {
        shouldStop: () => stale(),
      });
      if (stale()) return;
      if (skipped > 0) warn(`${skipped} video(s) left unrefined this pass`);
      log('refined displayed dates', refined, 'of', suspects.length);
      overlay(shown, exact, need);
      surface = findSurface(page.kind) ?? surface;
      applyIds(computeOrder(surface.rows, mode, { meta: shown }));
    }
  }

  setStatus(null);
}

const callbacks: MenuCallbacks = {
  getState: () => ({
    mode: prefs.mode,
    hasCustom: (prefs.custom?.length ?? 0) > 0,
    dragEnabled: settings.dragEnabled,
    autoplayFollowsOrder: settings.autoplayFollowsOrder,
    status: statusText,
  }),
  onSelectMode: (mode: SortMode) => {
    if (!page) return;
    prefs = { ...prefs, mode };
    void setPrefs(page.playlistId, prefs);
    updateButtonLabel(mode);
    void applyCurrentMode();
  },
  onToggleDrag: (enabled: boolean) => {
    settings = { ...settings, dragEnabled: enabled };
    void setSettings(settings);
    syncDrag();
  },
  onToggleAutoplay: (enabled: boolean) => {
    settings = { ...settings, autoplayFollowsOrder: enabled };
    void setSettings(settings);
  },
  onResetCustom: () => {
    if (!page) return;
    prefs = { ...prefs, custom: null, mode: prefs.mode === 'custom' ? 'original' : prefs.mode };
    void setPrefs(page.playlistId, prefs);
    updateButtonLabel(prefs.mode);
    void applyCurrentMode();
  },
};

function syncDrag(): void {
  if (!surface) return;
  if (settings.dragEnabled) {
    attachDrag(surface, {
      onCommit: (orderedIds) => {
        if (!page) return;
        lastOrder = orderedIds;
        // Placed by hand over the whole loaded list, so autoplay may follow it.
        orderConfirmed = true;
        // Any sort still running is now working towards an order the user has
        // just overruled; it will notice and stop, but the line it left is ours.
        setStatus(null);
        prefs = { ...prefs, custom: orderedIds, mode: 'custom' };
        void setPrefs(page.playlistId, prefs);
        updateButtonLabel('custom');
      },
    });
  } else {
    detachDrag(surface);
  }
}

function mountUi(): void {
  if (!surface) return;
  mountButton(surface.anchor, callbacks);
  updateButtonLabel(prefs.mode);
  syncDrag();
}

/** Re-applies state after YouTube re-renders or appends rows. */
function refresh(): void {
  if (!page) return;
  const previousSignature = rowIdSignature(surface);
  const found = findSurface(page.kind);
  if (!found) return;
  surface = found;

  mountUi();

  // While a pass is loading the rest of the playlist, the rows it appends are
  // what triggered this. Recomputing here would bump the generation and abort
  // the very load that produced them, so the arrivals are parked at the tail by
  // applyOrder and the owning pass does the real sort when it is done.
  if (loadingGen !== generation && rowIdSignature(surface) !== previousSignature && prefs.mode !== 'original') {
    // New videos arrived, so the sort has to be recomputed rather than replayed.
    void applyCurrentMode({ loadAll: false });
  } else if (lastOrder.length > 0) {
    applyIds(lastOrder, !orderConfirmed);
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 150);
}

function startObserving(): void {
  observer?.disconnect();
  if (!surface) return;
  observer = new MutationObserver(() => scheduleRefresh());
  observer.observe(surface.container, { childList: true });
}

function teardown(): void {
  generation += 1;
  observer?.disconnect();
  observer = null;
  detachDrag(surface);
  unmountButton();
  if (surface) clearOrder(surface);
  surface = null;
  page = null;
  lastOrder = [];
  orderConfirmed = false;
  loadingGen = 0;
  statusText = null;
}

async function boot(): Promise<void> {
  const next = detectPage();
  if (!next) {
    if (page) teardown();
    return;
  }
  if (page && page.kind === next.kind && page.playlistId === next.playlistId && surface?.container.isConnected) {
    return;
  }

  teardown();
  page = next;
  const gen = ++generation;

  const [loadedPrefs, loadedSettings] = await Promise.all([getPrefs(next.playlistId), getSettings()]);
  if (gen !== generation) return;
  prefs = loadedPrefs;
  settings = loadedSettings;

  const ready = await waitUntil(() => findSurface(next.kind) !== null, SURFACE_TIMEOUT_MS);
  if (gen !== generation || !ready) return;

  surface = findSurface(next.kind);
  if (!surface) return;

  log('active on', next.kind, next.playlistId, `${surface.rows.length} rows`, 'mode', prefs.mode);
  mountUi();
  startObserving();
  void applyCurrentMode();
}

function watchdog(): void {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    void boot();
    return;
  }
  if (!page) return;
  // The mutation observer covers row changes; this only catches YouTube
  // rebuilding the list container or the header the button lives in.
  if (!surface || !surface.container.isConnected || !buttonMounted()) refresh();
}

/**
 * Claiming the URL here matters: otherwise the watchdog still sees it as new a
 * moment later and boots a second time, and because the first boot has not
 * assigned its surface yet the guard above cannot tell the two apart — it tears
 * the first one down and starts the surface wait over.
 */
function navigated(): void {
  lastUrl = location.href;
  void boot();
}

installAutoplay({
  enabled: () => settings.autoplayFollowsOrder
    && page?.kind === 'watch'
    && orderConfirmed
    && lastOrder.length > 1,
  order: () => lastOrder,
  container: () => surface?.container ?? null,
});

window.addEventListener('yt-navigate-finish', navigated);
window.addEventListener('popstate', navigated);
window.setInterval(watchdog, WATCHDOG_MS);
void boot();
