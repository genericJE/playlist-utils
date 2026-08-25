import { CONTAINER_ATTR, ROW_ATTR } from './consts';
import { parseRelativeDate, parseViewCount } from './metadata';
import type { MetaNeed } from './metadata';
import type { Row, Surface } from './surface';
import type { SortMode, VideoMeta } from './store';

export const MODE_LABELS: Record<SortMode, string> = {
  original: 'Original',
  reverse: 'Reverse',
  chrono: 'Chronological',
  'chrono-flipped': 'Chrono-flipped',
  'views-desc': 'Most views',
  'views-asc': 'Least views',
  custom: 'Custom order',
};

export const MODE_HINTS: Record<SortMode, string> = {
  original: "The author's ordering",
  reverse: 'Last episode first',
  chrono: 'Oldest published first',
  'chrono-flipped': 'Newest published first',
  'views-desc': 'Most watched first',
  'views-asc': 'Least watched first',
  custom: 'Your drag-and-drop order',
};

/** Which remote field a mode needs, or null when the DOM alone is enough. */
export function metaNeedFor(mode: SortMode): MetaNeed | null {
  if (mode === 'chrono' || mode === 'chrono-flipped') return 'date';
  if (mode === 'views-desc' || mode === 'views-asc') return 'views';
  return null;
}

export interface OrderInputs {
  meta?: Map<string, VideoMeta> | null;
  custom?: string[] | null;
}

/**
 * Approximate values scraped from the "481k views • 3 weeks ago" labels, where
 * the layout has them. Lets a sort land instantly while exact values load.
 */
export function domMeta(rows: Row[]): Map<string, VideoMeta> {
  const now = Date.now();
  const out = new Map<string, VideoMeta>();
  for (const row of rows) {
    const text = row.el.textContent ?? '';
    const publishedAt = parseRelativeDate(text, now);
    const viewCount = parseViewCount(text);
    if (publishedAt !== null || viewCount !== null) {
      out.set(row.videoId, { publishedAt, viewCount, fetchedAt: now });
    }
  }
  return out;
}

function sortByValue(
  rows: Row[],
  valueOf: (row: Row) => number | null,
  direction: 'asc' | 'desc',
): string[] {
  const known: Array<{ row: Row; value: number }> = [];
  const unknown: Row[] = [];
  for (const row of rows) {
    const value = valueOf(row);
    if (value === null) unknown.push(row);
    else known.push({ row, value });
  }
  known.sort((a, b) => a.value - b.value);
  if (direction === 'desc') known.reverse();
  // Videos with no resolvable value keep author order at the end.
  return [...known.map((entry) => entry.row), ...unknown].map((row) => row.videoId);
}

/** Target visual order as a list of video ids. DOM order is always the original. */
export function computeOrder(rows: Row[], mode: SortMode, inputs: OrderInputs = {}): string[] {
  const ids = rows.map((row) => row.videoId);
  const meta = inputs.meta;

  switch (mode) {
    case 'original':
      return ids;

    case 'reverse':
      return [...ids].reverse();

    case 'chrono':
    case 'chrono-flipped': {
      if (!meta || meta.size === 0) return ids;
      return sortByValue(
        rows,
        (row) => meta.get(row.videoId)?.publishedAt ?? null,
        mode === 'chrono' ? 'asc' : 'desc',
      );
    }

    case 'views-desc':
    case 'views-asc': {
      if (!meta || meta.size === 0) return ids;
      return sortByValue(
        rows,
        (row) => meta.get(row.videoId)?.viewCount ?? null,
        mode === 'views-asc' ? 'asc' : 'desc',
      );
    }

    case 'custom': {
      const custom = inputs.custom;
      if (!custom || custom.length === 0) return ids;
      const rank = new Map(custom.map((id, index) => [id, index]));
      const known = rows.filter((row) => rank.has(row.videoId));
      const unknown = rows.filter((row) => !rank.has(row.videoId));
      known.sort((a, b) => (rank.get(a.videoId) ?? 0) - (rank.get(b.videoId) ?? 0));
      // Newly loaded videos the saved order has never seen go last.
      return [...known, ...unknown].map((row) => row.videoId);
    }
  }
}

/**
 * Applies an order without touching the DOM tree: the container becomes a
 * column flexbox and each row gets a CSS `order`. YouTube's own re-renders
 * therefore never fight us, and "original" is always recoverable because DOM
 * order is left untouched.
 */
export function applyOrder(surface: Surface, orderedIds: string[]): void {
  const position = new Map<string, number>();
  orderedIds.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });

  surface.container.setAttribute(CONTAINER_ATTR, '');
  surface.rows.forEach((row, domIndex) => {
    row.el.setAttribute(ROW_ATTR, '');
    row.el.style.setProperty('order', String(position.get(row.videoId) ?? orderedIds.length + domIndex));
  });
}

/** Puts the surface back exactly as YouTube rendered it. */
export function clearOrder(surface: Surface): void {
  surface.container.removeAttribute(CONTAINER_ATTR);
  for (const row of surface.rows) {
    row.el.removeAttribute(ROW_ATTR);
    row.el.style.removeProperty('order');
  }
}

/** Current visual order, derived from the applied `order` values. */
export function visualOrder(surface: Surface): Row[] {
  return [...surface.rows].sort(
    (a, b) => (Number(a.el.style.order) || 0) - (Number(b.el.style.order) || 0),
  );
}
