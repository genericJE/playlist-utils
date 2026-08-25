export type Scroller = HTMLElement | Window;

/** Nearest ancestor that actually scrolls, falling back to the window. */
export function nearestScroller(el: HTMLElement): Scroller {
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
      return node;
    }
    node = node.parentElement;
  }
  return window;
}

export function scrollTopOf(scroller: Scroller): number {
  return scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop;
}

export function scrollToTop(scroller: Scroller, value: number): void {
  if (scroller === window) window.scrollTo({ top: value });
  else (scroller as HTMLElement).scrollTop = value;
}

export function scrollToBottom(scroller: Scroller): void {
  if (scroller === window) window.scrollTo({ top: document.documentElement.scrollHeight });
  else {
    const el = scroller as HTMLElement;
    el.scrollTop = el.scrollHeight;
  }
}
