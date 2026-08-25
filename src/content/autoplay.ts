import { log } from './log';

/** Ignore repeat jumps to the same video while a navigation settles. */
const NAV_COOLDOWN_MS = 2500;

export interface AutoplayHooks {
  enabled(): boolean;
  /** Current visual order, as video ids. */
  order(): string[];
  container(): HTMLElement | null;
}

let hooks: AutoplayHooks | null = null;
let installed = false;
let lastNavigatedAt = 0;
let lastNavigatedTo: string | null = null;

function currentVideoId(): string | null {
  return new URLSearchParams(location.search).get('v');
}

/** The video `offset` places away from the current one in *our* order. */
function neighbour(offset: number): string | null {
  const order = hooks?.order() ?? [];
  const current = currentVideoId();
  if (!current || order.length === 0) return null;

  const index = order.indexOf(current);
  if (index < 0) return null;

  const target = index + offset;
  if (target < 0 || target >= order.length) return null;
  return order[target] ?? null;
}

function linkFor(videoId: string): HTMLAnchorElement | null {
  const selector = `a[href*="v=${videoId}"]`;
  const scope = hooks?.container();
  return (scope?.querySelector<HTMLAnchorElement>(selector))
    ?? document.querySelector<HTMLAnchorElement>(`${selector}[href*="list="]`);
}

/**
 * Navigates by clicking the video's own row link where possible, so YouTube
 * routes it internally and its playlist state moves with us. A full page load
 * is the fallback.
 */
function go(videoId: string): boolean {
  const now = Date.now();
  if (lastNavigatedTo === videoId && now - lastNavigatedAt < NAV_COOLDOWN_MS) return false;
  lastNavigatedAt = now;
  lastNavigatedTo = videoId;

  const link = linkFor(videoId);
  if (link) {
    log('autoplay: following our order to', videoId);
    link.click();
    return true;
  }

  const url = new URL(location.href);
  url.searchParams.set('v', videoId);
  url.searchParams.delete('pp');
  url.searchParams.delete('index');
  log('autoplay: no row link, hard navigating to', videoId);
  location.assign(url.toString());
  return true;
}

/**
 * `ended` does not bubble, but it still travels the capture phase, so a
 * listener here runs before YouTube's own handler on the video element and can
 * pick the next video first.
 */
function onEnded(event: Event): void {
  if (!hooks?.enabled()) return;
  if (!(event.target instanceof HTMLVideoElement)) return;

  const next = neighbour(1);
  if (!next) return; // End of our order: leave YouTube to do whatever it does.

  // Stopping here in the capture phase keeps the event from reaching YouTube's
  // own handler on the video element, so its choice of next video never races
  // with ours. Only done when we are actually taking over.
  event.stopPropagation();
  go(next);
}

function onClickCapture(event: MouseEvent): void {
  if (!hooks?.enabled()) return;
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest('.ytp-next-button, .ytp-prev-button');
  if (!button) return;

  const destination = neighbour(button.classList.contains('ytp-prev-button') ? -1 : 1);
  if (!destination) return;

  event.preventDefault();
  event.stopPropagation();
  go(destination);
}

export function installAutoplay(next: AutoplayHooks): void {
  hooks = next;
  if (installed) return;
  installed = true;
  document.addEventListener('ended', onEnded, true);
  document.addEventListener('click', onClickCapture, true);
}

export function clearAutoplay(): void {
  hooks = null;
}
