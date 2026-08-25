import type { PageKind } from './page';

export interface Row {
  el: HTMLElement;
  videoId: string;
}

export interface Surface {
  /** Flex parent whose children get reordered via CSS `order`. */
  container: HTMLElement;
  rows: Row[];
  /** Where the menu button is inserted; null means use the floating fallback. */
  anchor: HTMLElement | null;
}

/**
 * Item elements, most specific first. YouTube ships two generations of
 * playlist markup: the Polymer `ytd-*`/`ytm-*` renderers and the newer
 * `yt-lockup-view-model` components.
 */
const ITEM_SELECTORS: Record<PageKind, string[]> = {
  watch: ['ytd-playlist-panel-video-renderer', 'ytm-playlist-panel-video-renderer'],
  playlist: ['ytd-playlist-video-renderer', 'yt-lockup-view-model'],
  show: ['ytd-playlist-video-renderer', 'yt-lockup-view-model'],
};

/** Roots searched in order, so the real playlist beats unrelated shelves. */
const SCOPE_SELECTORS: Record<PageKind, string[]> = {
  watch: ['ytd-playlist-panel-renderer', 'ytm-playlist-panel-renderer'],
  playlist: ['ytd-playlist-video-list-renderer', 'yt-item-section-renderer', 'ytd-item-section-renderer', 'ytd-browse'],
  show: ['ytd-playlist-video-list-renderer', 'yt-item-section-renderer', 'ytd-item-section-renderer', 'ytd-browse'],
};

const ANCHOR_SELECTORS: Record<PageKind, string[]> = {
  watch: [
    'ytd-playlist-panel-renderer #header-contents',
    '.playlist-engagement-panel-menu-container',
    'ytm-playlist-engagement-panel-header',
  ],
  playlist: ['yt-flexible-actions-view-model', 'yt-page-header-view-model'],
  show: ['ytd-playlist-show-metadata-renderer', 'yt-flexible-actions-view-model', 'ytd-playlist-header-renderer'],
};

/**
 * Walks up from the first matching item until it reaches the tightest ancestor
 * that holds several of them. That single rule covers every layout: panel
 * renderers sit directly in their container, lockups sit one wrapper div deep.
 */
function findRowGroup(scope: ParentNode, selector: string): { container: HTMLElement; rowEls: HTMLElement[] } | null {
  const first = scope.querySelector<HTMLElement>(selector);
  if (!first) return null;

  let node: HTMLElement = first;
  while (node.parentElement && node !== document.body) {
    const parent = node.parentElement;
    const rowEls = Array.from(parent.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && (child.matches(selector) || child.querySelector(selector) !== null),
    );
    if (rowEls.length >= 2) return { container: parent, rowEls };
    node = parent;
  }
  return null;
}

function classOf(el: Element): string {
  return el.getAttribute('class') ?? '';
}

/**
 * Video id straight from the DOM. Content scripts run in an isolated world, so
 * the Polymer `.data` property is not reachable and every source here has to be
 * markup the page actually rendered.
 */
export function videoIdOf(row: HTMLElement): string | null {
  const tagged = row.querySelector('[class*="content-id-"]');
  if (tagged) {
    const match = /content-id-([\w-]{6,})/.exec(classOf(tagged));
    if (match) return match[1] ?? null;
  }

  for (const link of Array.from(row.querySelectorAll('a[href]'))) {
    const match = /[?&]v=([\w-]{11})(?:&|$)/.exec(link.getAttribute('href') ?? '');
    if (match) return match[1] ?? null;
  }

  const img = row.querySelector<HTMLImageElement>('img[src*="/vi/"]');
  if (img) {
    const match = /\/vi\/([\w-]{11})\//.exec(img.getAttribute('src') ?? '');
    if (match) return match[1] ?? null;
  }

  return null;
}

/**
 * The /show/ layout gives every row the same `watch_videos?video_ids=...`
 * link, which spells out the whole playlist in author order. Thumbnails there
 * are lazy-loaded, so this index-based fallback is what identifies rows that
 * are still below the fold.
 */
function megaLinkOrder(): string[] | null {
  const link = document.querySelector('a[href*="watch_videos?video_ids="]');
  if (!link) return null;
  const raw = /video_ids=([^&]+)/.exec(link.getAttribute('href') ?? '')?.[1];
  if (!raw) return null;
  const ids = decodeURIComponent(raw).split(',').filter((id) => /^[\w-]{11}$/.test(id));
  return ids.length > 0 ? ids : null;
}

function findAnchor(kind: PageKind): HTMLElement | null {
  for (const selector of ANCHOR_SELECTORS[kind]) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && el.isConnected) return el;
  }
  return null;
}

export function findSurface(kind: PageKind): Surface | null {
  let group: { container: HTMLElement; rowEls: HTMLElement[] } | null = null;

  outer: for (const scopeSelector of SCOPE_SELECTORS[kind]) {
    for (const scope of Array.from(document.querySelectorAll(scopeSelector))) {
      for (const itemSelector of ITEM_SELECTORS[kind]) {
        group = findRowGroup(scope, itemSelector);
        if (group) break outer;
      }
    }
  }
  if (!group) return null;

  const fallbackIds = megaLinkOrder();
  const rows: Row[] = [];
  group.rowEls.forEach((el, index) => {
    const videoId = videoIdOf(el) ?? fallbackIds?.[index] ?? null;
    if (videoId) rows.push({ el, videoId });
  });

  if (rows.length < 2) return null;
  return { container: group.container, rows, anchor: findAnchor(kind) };
}

/** True while YouTube still has more pages of this playlist to append. */
export function continuationSentinel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'ytd-continuation-item-renderer, yt-continuation-item-view-model, ytm-continuation-item-renderer',
  );
}
