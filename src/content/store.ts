import { storage } from './browser';
import { warn } from './log';

export type SortMode =
  | 'original'
  | 'reverse'
  | 'chrono'
  | 'chrono-flipped'
  | 'views-desc'
  | 'views-asc'
  | 'custom';

export interface PlaylistPrefs {
  mode: SortMode;
  /** Explicit video-id order, set by dragging. Kept even while another mode is active. */
  custom: string[] | null;
  updatedAt: number;
}

export interface Settings {
  /** Master switch for the drag handles. */
  dragEnabled: boolean;
  /** Whether playlist navigation should follow this order instead of YouTube's. */
  autoplayFollowsOrder: boolean;
}

const PREFS_PREFIX = 'pl:';
const META_PREFIX = 'm2:';
const SETTINGS_KEY = 'settings';

const DEFAULT_PREFS: PlaylistPrefs = { mode: 'original', custom: null, updatedAt: 0 };
const DEFAULT_SETTINGS: Settings = { dragEnabled: true, autoplayFollowsOrder: true };

function isMode(value: unknown): value is SortMode {
  return value === 'original' || value === 'reverse' || value === 'chrono'
    || value === 'chrono-flipped' || value === 'views-desc' || value === 'views-asc'
    || value === 'custom';
}

export async function getPrefs(playlistId: string): Promise<PlaylistPrefs> {
  const key = PREFS_PREFIX + playlistId;
  try {
    const raw = (await storage.get(key))[key] as Partial<PlaylistPrefs> | undefined;
    if (!raw) return { ...DEFAULT_PREFS };
    return {
      mode: isMode(raw.mode) ? raw.mode : 'original',
      custom: Array.isArray(raw.custom) ? raw.custom.filter((v): v is string => typeof v === 'string') : null,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch (err) {
    warn('failed to read prefs', err);
    return { ...DEFAULT_PREFS };
  }
}

export async function setPrefs(playlistId: string, prefs: PlaylistPrefs): Promise<void> {
  try {
    await storage.set({ [PREFS_PREFIX + playlistId]: { ...prefs, updatedAt: Date.now() } });
  } catch (err) {
    warn('failed to write prefs', err);
  }
}

export async function getSettings(): Promise<Settings> {
  try {
    const raw = (await storage.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<Settings> | undefined;
    return {
      dragEnabled: typeof raw?.dragEnabled === 'boolean' ? raw.dragEnabled : DEFAULT_SETTINGS.dragEnabled,
      autoplayFollowsOrder: typeof raw?.autoplayFollowsOrder === 'boolean'
        ? raw.autoplayFollowsOrder
        : DEFAULT_SETTINGS.autoplayFollowsOrder,
    };
  } catch (err) {
    warn('failed to read settings', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(settings: Settings): Promise<void> {
  try {
    await storage.set({ [SETTINGS_KEY]: settings });
  } catch (err) {
    warn('failed to write settings', err);
  }
}

export interface VideoMeta {
  /** Publish timestamp in ms; immutable once known. */
  publishedAt: number | null;
  /** View count at `fetchedAt`; goes stale, unlike the publish date. */
  viewCount: number | null;
  fetchedAt: number;
  /**
   * Set once the publish date has been reconciled with YouTube's own "x ago"
   * label, so the expensive second lookup is attempted at most once per video.
   */
  dateChecked?: boolean;
  /**
   * When that reconciliation was last attempted, successful or not. Some videos
   * simply never expose a displayed date, and without this they cost a ~400 KB
   * lookup on every fresh page load, forever.
   */
  refineAttemptedAt?: number;
}

interface StoredMeta {
  p?: number | null;
  v?: number | null;
  t?: number;
  c?: boolean;
  a?: number;
}

/**
 * Everything read or written this page session. The content script survives
 * YouTube's SPA navigations, so this is what turns a mode toggle, a
 * continuation batch and a hop from /playlist to /watch into zero storage
 * round trips instead of one per video per pass.
 */
const memo = new Map<string, VideoMeta>();

/**
 * Ids storage has already answered about, so a video it has never heard of is
 * not asked about again. Another tab writing a record this tab has already
 * probed is the one thing this misses; the cost is one duplicate lookup.
 */
const probed = new Set<string>();

/**
 * Cached metadata for these videos. The returned map is the caller's to mutate;
 * records themselves are replaced wholesale rather than edited, so sharing them
 * with the session memo is safe.
 */
export async function getCachedMeta(videoIds: string[]): Promise<Map<string, VideoMeta>> {
  const out = new Map<string, VideoMeta>();
  const cold: string[] = [];
  for (const id of videoIds) {
    const hit = memo.get(id);
    if (hit) out.set(id, hit);
    else if (!probed.has(id)) cold.push(id);
  }
  if (cold.length === 0) return out;

  try {
    const found = await storage.get(cold.map((id) => META_PREFIX + id));
    for (const id of cold) {
      // Marked inside the try: a read that threw has to be retried, not
      // remembered as an absence.
      probed.add(id);
      const raw = found[META_PREFIX + id] as StoredMeta | undefined;
      if (!raw) continue;
      const value: VideoMeta = {
        publishedAt: typeof raw.p === 'number' ? raw.p : null,
        viewCount: typeof raw.v === 'number' ? raw.v : null,
        fetchedAt: typeof raw.t === 'number' ? raw.t : 0,
        dateChecked: raw.c === true,
        refineAttemptedAt: typeof raw.a === 'number' ? raw.a : undefined,
      };
      memo.set(id, value);
      out.set(id, value);
    }
  } catch (err) {
    warn('failed to read metadata cache', err);
  }
  return out;
}

export async function cacheMeta(meta: Map<string, VideoMeta>): Promise<void> {
  if (meta.size === 0) return;
  const items: Record<string, unknown> = {};
  // The memo is written through before the await, so a caller that reads back
  // immediately sees the new values whether or not the disk write lands.
  for (const [id, value] of meta) {
    memo.set(id, value);
    probed.add(id);
    const stored: StoredMeta = {
      p: value.publishedAt, v: value.viewCount, t: value.fetchedAt, c: value.dateChecked === true,
    };
    if (value.refineAttemptedAt !== undefined) stored.a = value.refineAttemptedAt;
    items[META_PREFIX + id] = stored;
  }
  try {
    await storage.set(items);
  } catch (err) {
    warn('failed to write metadata cache', err);
  }
}
