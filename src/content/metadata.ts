import { cacheMeta, getCachedMeta } from './store';
import type { VideoMeta } from './store';
import { warn } from './log';

const FALLBACK_CLIENT_VERSION = '2.20240101.00.00';
/**
 * These are ~10 KB same-origin POSTs on an already-warm connection, so the wait
 * is round trips rather than bandwidth and the pass takes (count / this) x RTT.
 * Held well short of what an uncredentialed caller can ask of YouTube: a 429
 * here would throttle the user's ordinary browsing in every other tab too.
 */
const CONCURRENCY = 8;
/** Publish dates are immutable; view counts are re-fetched after this long. */
const VIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `next` responses are ~400 KB, so only ever refine a handful per pass. */
const REFINE_LIMIT = 15;
const REFINE_CONCURRENCY = 2;
/** How often results are persisted, so an interrupted pass is not wasted work. */
const FLUSH_EVERY = 25;
const FLUSH_MS = 2_000;

/** Refinements tried this page session, so a failure is not retried in a loop. */
const attempted = new Set<string>();

/**
 * Lookups already in the air, keyed by video id. Two passes overlap whenever a
 * mode is toggled or rows arrive mid-fetch, and both want the same videos;
 * joining the promise is free where a second request is not.
 */
const inflight = new Map<string, Promise<VideoMeta | null>>();

/**
 * Videos the endpoint answered about without producing the field we asked for:
 * deleted, private, region-blocked, or simply not showing a view count. Nothing
 * usable can be cached for them, so without this they stay in `missing` forever
 * and every toggle re-fetches the whole set.
 *
 * Deliberately session-scoped rather than persisted: a throttled or bot-checked
 * response is byte-identical to a deleted video, so a durable tombstone would
 * let one bad minute poison a playlist with no way back. A reload re-checks.
 */
const barren = new Set<string>();

/** Set when YouTube asks for less; the rest of the pass then drains without firing. */
let throttled = false;

export type MetaNeed = 'date' | 'views';

interface InnertubeConfig {
  apiKey: string;
  clientName: string;
  clientVersion: string;
}

/** undefined = not looked up yet, null = the page did not expose a key. */
let configCache: InnertubeConfig | null | undefined;

/**
 * Reads ytcfg out of the inline scripts. The values live in page markup, which
 * an isolated content script can read, unlike the page's `window.ytcfg`.
 */
function innertubeConfig(): InnertubeConfig | null {
  if (configCache !== undefined) return configCache;

  let apiKey: string | undefined;
  let clientName: string | undefined;
  let clientVersion: string | undefined;

  for (const script of Array.from(document.querySelectorAll('script'))) {
    const text = script.textContent;
    if (!text || !text.includes('INNERTUBE_API_KEY')) continue;
    apiKey ??= /"INNERTUBE_API_KEY":"([^"]+)"/.exec(text)?.[1];
    clientName ??= /"INNERTUBE_CLIENT_NAME":"([^"]+)"/.exec(text)?.[1];
    clientVersion ??= /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(text)?.[1];
    if (apiKey && clientName && clientVersion) break;
  }

  // No key is bundled: it is read from the page YouTube already served us. If
  // it is not there, the exact lookups are skipped and sorting falls back to
  // the approximate values scraped from the page.
  configCache = apiKey
    ? {
        apiKey,
        clientName: clientName ?? (location.hostname.startsWith('m.') ? 'MWEB' : 'WEB'),
        clientVersion: clientVersion ?? FALLBACK_CLIENT_VERSION,
      }
    : null;
  if (!configCache) warn('InnerTube config not found on this page; exact metadata is unavailable');
  return configCache;
}

function innertubeUrl(endpoint: 'player' | 'next', config: InnertubeConfig): string {
  return `${location.origin}/youtubei/v1/${endpoint}?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`;
}

function innertubeBody(videoId: string, config: InnertubeConfig): string {
  return JSON.stringify({
    context: { client: { clientName: config.clientName, clientVersion: config.clientVersion, hl: 'en', gl: 'US' } },
    videoId,
  });
}

/**
 * Publish date and view count for one video. The player endpoint answers with a
 * ~10 KB payload whose microformat block carries both. Playability is
 * irrelevant here, so the request is sent without credentials and never touches
 * the signed-in account or watch history.
 */
async function fetchMeta(videoId: string): Promise<VideoMeta | null> {
  const config = innertubeConfig();
  if (!config) return null;
  try {
    const response = await fetch(innertubeUrl('player', config), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: innertubeBody(videoId, config),
    });
    if (response.status === 429 || response.status === 503) {
      // Stand down for the rest of the pass instead of retrying. More requests
      // is the one thing that makes this worse, and the sort still lands using
      // whatever is already known.
      throttled = true;
      return null;
    }
    if (!response.ok) return null;
    const json = (await response.json()) as {
      microformat?: { playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string; viewCount?: string } };
      videoDetails?: { viewCount?: string };
    };
    const micro = json.microformat?.playerMicroformatRenderer;

    const rawDate = micro?.publishDate ?? micro?.uploadDate;
    const parsedDate = rawDate ? Date.parse(rawDate) : Number.NaN;

    const rawViews = micro?.viewCount ?? json.videoDetails?.viewCount;
    const parsedViews = rawViews !== undefined ? Number(rawViews) : Number.NaN;

    return {
      publishedAt: Number.isFinite(parsedDate) ? parsedDate : null,
      viewCount: Number.isFinite(parsedViews) ? parsedViews : null,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    warn('metadata lookup failed', videoId, err);
    return null;
  }
}

/**
 * One request per video, however many passes want it. The raw result is shared,
 * never the merged record: merging reads the calling pass's own view of the
 * cache, and handing that snapshot to another pass could re-persist a stale
 * date over a refinement.
 */
function dedupe(videoId: string): Promise<VideoMeta | null> {
  let pending = inflight.get(videoId);
  if (!pending) {
    pending = fetchMeta(videoId).finally(() => inflight.delete(videoId));
    inflight.set(videoId, pending);
  }
  return pending;
}

const RELATIVE_UNITS: Array<[RegExp, number]> = [
  [/^sec/, 1_000],
  [/^min/, 60_000],
  [/^(hour|hr)/, 3_600_000],
  [/^day/, 86_400_000],
  [/^(week|wk)/, 604_800_000],
  [/^(mon|mo$)/, 2_629_746_000],
  [/^(year|yr)/, 31_556_952_000],
];

/**
 * Turns "3 weeks ago" into an approximate timestamp. Good enough to sort a list
 * instantly while the exact values are still being fetched.
 */
export function parseRelativeDate(text: string, now = Date.now()): number | null {
  const match = /(\d+)\s*(second|sec|minute|min|hour|hr|day|week|wk|month|mon|mo|year|yr)s?\s+ago/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  if (!Number.isFinite(amount)) return null;
  for (const [pattern, ms] of RELATIVE_UNITS) {
    if (pattern.test(unit)) return now - amount * ms;
  }
  return null;
}

const VIEW_SUFFIXES: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** Parses the "481k views" / "1.2M views" / "481,839 views" label. */
export function parseViewCount(text: string): number | null {
  const match = /([\d.,]+)\s*([kmb])?\s*views/i.exec(text);
  if (!match) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  const digits = suffix ? (match[1] ?? '').replace(/,/g, '') : (match[1] ?? '').replace(/[.,]/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return suffix ? value * (VIEW_SUFFIXES[suffix] ?? 1) : value;
}

export interface MetaProgress {
  done: number;
  total: number;
  /** True once YouTube has asked us to back off; the pass finishes with what it has. */
  throttled: boolean;
}

export interface MetaHooks {
  onProgress?(progress: MetaProgress): void;
  /**
   * Fired with each batch of newly resolved values, so the visible order can
   * converge as they land instead of snapping once at the end. A delta rather
   * than the whole map: the caller blends these over the approximate values it
   * scraped from the page, and handing it everything cached would overwrite a
   * good approximation with a record that has no value for the field at all.
   */
  onBatch?(batch: Map<string, VideoMeta>): void;
  shouldStop?(): boolean;
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
}

function isUsable(meta: VideoMeta | undefined, need: MetaNeed, now: number): boolean {
  if (!meta) return false;
  if (need === 'date') return meta.publishedAt !== null;
  return meta.viewCount !== null && now - meta.fetchedAt < VIEW_TTL_MS;
}

/**
 * What is already known for these videos, with no network at all. Lets a sort
 * land from the cache before the playlist has even finished loading, which on a
 * revisit is the final answer arriving in a frame.
 */
export async function cachedMeta(videoIds: string[], need: MetaNeed): Promise<Map<string, VideoMeta>> {
  const now = Date.now();
  const meta = await getCachedMeta(Array.from(new Set(videoIds)));
  for (const [id, value] of meta) {
    if (!isUsable(value, need, now)) meta.delete(id);
  }
  return meta;
}

/**
 * Resolves metadata for a list of videos, hitting the network only for entries
 * the cache cannot satisfy for the requested field.
 */
export async function resolveMeta(
  videoIds: string[],
  need: MetaNeed,
  hooks: MetaHooks = {},
): Promise<Map<string, VideoMeta>> {
  const unique = Array.from(new Set(videoIds));
  const now = Date.now();
  const meta = await getCachedMeta(unique);
  const missing = unique.filter((id) => !barren.has(id) && !isUsable(meta.get(id), need, now));

  if (missing.length === 0) {
    hooks.onProgress?.({ done: unique.length, total: unique.length, throttled: false });
    return meta;
  }

  throttled = false;
  let done = unique.length - missing.length;
  let reported = done;
  let pending = new Map<string, VideoMeta>();
  let flushedAt = Date.now();
  hooks.onProgress?.({ done, total: unique.length, throttled });

  const flush = (notify: boolean): Promise<void> => {
    if (pending.size === 0) return Promise.resolve();
    const batch = pending;
    pending = new Map();
    flushedAt = Date.now();
    const written = cacheMeta(batch);
    if (notify) hooks.onBatch?.(batch);
    return written;
  };

  await runPool(missing, CONCURRENCY, async (videoId) => {
    // Checked outside the shared promise on purpose: resolving it as null for a
    // torn-down pass would record a false miss for whoever else is waiting.
    if (!throttled && !hooks.shouldStop?.()) {
      const value = await dedupe(videoId);
      if (value) {
        const previous = meta.get(videoId);
        const merged: VideoMeta = {
          // The player endpoint reports the *upload* date, so it must never
          // overwrite one already reconciled against YouTube's own label.
          publishedAt: previous?.dateChecked
            ? previous.publishedAt
            : value.publishedAt ?? previous?.publishedAt ?? null,
          viewCount: value.viewCount ?? previous?.viewCount ?? null,
          fetchedAt: value.fetchedAt,
          dateChecked: previous?.dateChecked === true,
          refineAttemptedAt: previous?.refineAttemptedAt,
        };
        meta.set(videoId, merged);
        pending.set(videoId, merged);
        if (!isUsable(merged, need, now)) barren.add(videoId);
      }
    }
    done += 1;
    if (pending.size >= FLUSH_EVERY || Date.now() - flushedAt >= FLUSH_MS) void flush(true);
    // Progress rebuilds the menu, so it is reported on the flush cadence rather
    // than per video — plus the last tick, so the status never sticks at 199/200.
    if (done - reported >= FLUSH_EVERY || done === unique.length) {
      reported = done;
      hooks.onProgress?.({ done, total: unique.length, throttled });
    }
  });

  await flush(false);
  return meta;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parses the "Jun 5, 2026" form. Requests pin hl=en, so the format is fixed. */
export function parseDateText(text: string): number | null {
  const match = /([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (!match) return null;
  const month = MONTHS[(match[1] ?? '').slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  return Date.UTC(year, month, day, 12);
}

function unitMs(unit: string): number | null {
  for (const [pattern, ms] of RELATIVE_UNITS) {
    if (pattern.test(unit)) return ms;
  }
  return null;
}

/**
 * True when a timestamp cannot be reconciled with YouTube's own "x ago" label.
 *
 * The player endpoint reports a video's *upload* date. For anything published
 * later than it was uploaded — members-early-access, scheduled posts — that is
 * not the date YouTube shows, and sorting by it puts the video in the wrong
 * place. Disagreeing with the label is the cheap signal that this happened.
 */
export function labelContradicts(exactMs: number, text: string, now = Date.now()): boolean {
  const match = /(\d+)\s*(second|sec|minute|min|hour|hr|day|week|wk|month|mon|mo|year|yr)s?\s+ago/i.exec(text);
  if (!match) return false;
  const amount = Number(match[1]);
  const ms = unitMs((match[2] ?? '').toLowerCase());
  if (!Number.isFinite(amount) || ms === null) return false;

  const age = now - exactMs;
  const slack = 3 * 86_400_000;
  return age < amount * ms - slack || age > (amount + 1) * ms + slack;
}

/**
 * Desktop and mobile return the displayed date under different keys, so each
 * shape is tried in turn, most specific first.
 */
const DISPLAYED_DATE_PATTERNS: RegExp[] = [
  /"dateText":\{"simpleText":"([^"]+)"/,
  /"publishDate":\{"runs":\[\{"text":"([^"]+)"/,
  /"trailingLabel":\{"content":"([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})"/,
  /"accessibilityText":"([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})"/,
];

interface DisplayedDate {
  /**
   * Whether YouTube actually answered. False means the request itself failed,
   * which must not be remembered — a well-formed answer we could not read is a
   * property of the video and is worth remembering.
   */
  answered: boolean;
  date: number | null;
}

/**
 * Reads the date YouTube actually displays for a video. This costs a `next`
 * request, which is far heavier than `player`, so it is reserved for videos
 * whose label betrayed an upload/publish mismatch.
 */
async function fetchDisplayedDate(videoId: string): Promise<DisplayedDate> {
  const config = innertubeConfig();
  if (!config) return { answered: false, date: null };
  try {
    const response = await fetch(innertubeUrl('next', config), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: innertubeBody(videoId, config),
    });
    if (!response.ok) return { answered: false, date: null };
    // Scanned as text: parsing the whole payload would be far more expensive.
    const raw = await response.text();
    for (const pattern of DISPLAYED_DATE_PATTERNS) {
      const value = pattern.exec(raw)?.[1];
      const parsed = value ? parseDateText(value) : null;
      if (parsed !== null) return { answered: true, date: parsed };
    }
    return { answered: true, date: null };
  } catch (err) {
    warn('displayed date lookup failed', videoId, err);
    return { answered: false, date: null };
  }
}

/**
 * Replaces upload dates with the displayed publish date for the given videos.
 * Mutates `meta` in place and persists the result, marking each video as
 * checked so the heavy lookup happens at most once.
 */
export async function refineDisplayedDates(
  videoIds: string[],
  meta: Map<string, VideoMeta>,
  hooks: MetaHooks = {},
): Promise<{ refined: number; skipped: number }> {
  const targets = videoIds.filter((id) => !attempted.has(id)).slice(0, REFINE_LIMIT);
  const skipped = videoIds.length - targets.length;
  if (targets.length === 0) return { refined: 0, skipped };

  const updated = new Map<string, VideoMeta>();
  let done = 0;
  let refined = 0;

  await runPool(targets, REFINE_CONCURRENCY, async (videoId) => {
    if (!hooks.shouldStop?.()) {
      attempted.add(videoId);
      const { answered, date } = await fetchDisplayedDate(videoId);
      if (answered) {
        const previous = meta.get(videoId);
        const next: VideoMeta = {
          publishedAt: date ?? previous?.publishedAt ?? null,
          viewCount: previous?.viewCount ?? null,
          fetchedAt: previous?.fetchedAt ?? Date.now(),
          dateChecked: date !== null || previous?.dateChecked === true,
          // Stamped even when nothing parsed. That is the whole point: a video
          // whose displayed date this endpoint never exposes stops costing
          // ~400 KB on every single visit.
          refineAttemptedAt: Date.now(),
        };
        if (date !== null) refined += 1;
        meta.set(videoId, next);
        updated.set(videoId, next);
      }
    }
    done += 1;
    hooks.onProgress?.({ done, total: targets.length, throttled });
  });

  await cacheMeta(updated);
  return { refined, skipped };
}
