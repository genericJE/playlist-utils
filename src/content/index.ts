import { attachDrag, detachDrag, ensureGrips } from './dnd';
import { log, warn } from './log';
import { buttonMounted, mountButton, refreshMenu, unmountButton, updateButtonLabel } from './menu';
import type { MenuCallbacks } from './menu';
import { labelContradicts, refineDisplayedDates, resolveMeta } from './metadata';
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
import type { PlaylistPrefs, Settings, SortMode } from './store';
import { nearestScroller, scrollToBottom, scrollToTop, scrollTopOf } from './scroll';
import { continuationSentinel, findSurface } from './surface';
import type { Surface } from './surface';

const WATCHDOG_MS = 700;
const SURFACE_TIMEOUT_MS = 25_000;
const CONTINUATION_ROUNDS = 25;

let page: PageInfo | null = null;
let surface: Surface | null = null;
let prefs: PlaylistPrefs = { mode: 'original', custom: null, updatedAt: 0 };
let settings: Settings = { dragEnabled: true };
let statusText: string | null = null;
let lastOrder: string[] = [];
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
 * first page of a lazily loaded list.
 */
async function loadAllItems(gen: number): Promise<void> {
  if (!page || !surface) return;

  // YouTube grows these lists two different ways: an explicit continuation
  // sentinel on playlist pages, and plain lazy rendering inside the watch
  // panel. Nudging both covers every surface.
  const scroller = nearestScroller(surface.container);
  const restoreWindow = window.scrollY;
  const restoreScroller = scrollTopOf(scroller);

  for (let round = 0; round < CONTINUATION_ROUNDS; round += 1) {
    if (gen !== generation) return;

    const before = surface?.rows.length ?? 0;
    setStatus(`Loading playlist… ${before} videos`);

    const sentinel = continuationSentinel();
    if (sentinel) sentinel.scrollIntoView({ block: 'center' });
    else scrollToBottom(scroller);

    const grew = await waitUntil(() => {
      const found = findSurface(page!.kind);
      return (found?.rows.length ?? 0) > before;
    }, sentinel ? 5_000 : 1_200);

    surface = findSurface(page.kind) ?? surface;
    if (!grew) break;
  }

  scrollToTop(scroller, restoreScroller);
  window.scrollTo({ top: restoreWindow });
  setStatus(null);
}

function applyIds(ids: string[]): void {
  if (!surface) return;
  lastOrder = ids;
  applyOrder(surface, ids);
  if (settings.dragEnabled) ensureGrips(surface);
}

async function applyCurrentMode(options: { loadAll?: boolean } = {}): Promise<void> {
  if (!surface || !page) return;
  const gen = ++generation;
  const mode = prefs.mode;

  if (mode === 'original') {
    applyIds(computeOrder(surface.rows, 'original'));
    setStatus(null);
    return;
  }

  if (options.loadAll !== false) {
    await loadAllItems(gen);
    if (gen !== generation) return;
    surface = findSurface(page.kind) ?? surface;
  }

  const need = metaNeedFor(mode);
  if (!need) {
    applyIds(computeOrder(surface.rows, mode, { custom: prefs.custom }));
    return;
  }

  // Land an approximate order immediately from the labels YouTube already
  // rendered, then refine it once the exact values arrive.
  applyIds(computeOrder(surface.rows, mode, { meta: domMeta(surface.rows) }));

  const ids = surface.rows.map((row) => row.videoId);
  const meta = await resolveMeta(
    ids,
    need,
    ({ done, total }) => {
      setStatus(done < total ? `Reading video details… ${done}/${total}` : null);
    },
    () => gen !== generation,
  );
  if (gen !== generation) return;

  surface = findSurface(page.kind) ?? surface;
  applyIds(computeOrder(surface.rows, mode, { meta }));

  if (need === 'date') {
    // The player endpoint reports upload dates. Where that disagrees with the
    // row's own "x ago" label, the video was published later than it was
    // uploaded, and the displayed date is the one to sort by.
    const suspects = surface.rows
      .filter((row) => {
        const entry = meta.get(row.videoId);
        return entry?.publishedAt != null
          && entry.dateChecked !== true
          && labelContradicts(entry.publishedAt, row.el.textContent ?? '');
      })
      .map((row) => row.videoId);

    if (suspects.length > 0) {
      setStatus(`Checking publish dates… ${suspects.length}`);
      const { refined, skipped } = await refineDisplayedDates(
        suspects,
        meta,
        undefined,
        () => gen !== generation,
      );
      if (gen !== generation) return;
      if (skipped > 0) warn(`${skipped} video(s) left unrefined this pass`);
      log('refined displayed dates', refined, 'of', suspects.length);
      surface = findSurface(page.kind) ?? surface;
      applyIds(computeOrder(surface.rows, mode, { meta }));
    }
  }

  setStatus(null);
}

const callbacks: MenuCallbacks = {
  getState: () => ({
    mode: prefs.mode,
    hasCustom: (prefs.custom?.length ?? 0) > 0,
    dragEnabled: settings.dragEnabled,
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

  if (rowIdSignature(surface) !== previousSignature && prefs.mode !== 'original') {
    // New videos arrived, so the sort has to be recomputed rather than replayed.
    void applyCurrentMode({ loadAll: false });
  } else if (lastOrder.length > 0) {
    applyIds(lastOrder);
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

window.addEventListener('yt-navigate-finish', () => void boot());
window.addEventListener('popstate', () => void boot());
window.setInterval(watchdog, WATCHDOG_MS);
void boot();
