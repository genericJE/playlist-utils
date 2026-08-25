export type PageKind = 'playlist' | 'show' | 'watch';

export interface PageInfo {
  kind: PageKind;
  /** Canonical playlist id, shared across /show, /playlist and /watch surfaces. */
  playlistId: string;
}

/**
 * /show/VLPL123 and /playlist?list=PL123 are the same playlist. Dropping the
 * "VL" prefix makes both resolve to one stored order.
 */
export function normalizeListId(id: string): string {
  return id.startsWith('VL') ? id.slice(2) : id;
}

export function detectPage(): PageInfo | null {
  const { pathname } = location;
  const params = new URLSearchParams(location.search);

  if (pathname === '/playlist') {
    const list = params.get('list');
    return list ? { kind: 'playlist', playlistId: normalizeListId(list) } : null;
  }

  if (pathname.startsWith('/show/')) {
    const raw = decodeURIComponent(pathname.slice('/show/'.length).split('/')[0] ?? '');
    return raw ? { kind: 'show', playlistId: normalizeListId(raw) } : null;
  }

  if (pathname === '/watch') {
    const list = params.get('list');
    return list ? { kind: 'watch', playlistId: normalizeListId(list) } : null;
  }

  return null;
}
