import { DRAGGING_ATTR, DRAG_READY_ATTR, GRIP_CLASS, ROW_ATTR } from './consts';
import { visualOrder } from './order';
import { nearestScroller } from './scroll';
import type { Row, Surface } from './surface';

const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE = 10;
const EDGE_ZONE = 72;
const MAX_SCROLL_STEP = 16;
const FLIP_MS = 140;
const CLICK_SUPPRESS_MS = 400;

export interface DragHooks {
  onCommit(orderedIds: string[]): void;
}

interface DragState {
  surface: Surface;
  row: Row;
  pointerId: number;
  captureTarget: HTMLElement;
  order: Row[];
  startIndex: number;
  index: number;
  grabOffset: number;
  height: number;
  clientY: number;
  rafId: number | null;
  scroller: HTMLElement | Window;
}

interface ArmedPress {
  row: Row;
  pointerId: number;
  startY: number;
  startX: number;
  timer: number;
  captureTarget: HTMLElement;
}

let active: DragState | null = null;
let armed: ArmedPress | null = null;
let suppressClicksUntil = 0;
let installed = false;
let currentSurface: Surface | null = null;
let currentHooks: DragHooks | null = null;

const GUTTER_PX = 22;
const COARSE_GUTTER_PX = 26;
const PAD_DATA_KEY = 'pluPad';

function gutterWidth(): number {
  return window.matchMedia('(pointer: coarse)').matches ? COARSE_GUTTER_PX : GUTTER_PX;
}

/**
 * Widens the row's leading padding to make room for the handle. The original
 * value is measured and stored so the gutter adds to YouTube's own padding
 * instead of replacing it, and so it can be restored exactly.
 */
function addGutter(el: HTMLElement): void {
  if (el.dataset[PAD_DATA_KEY] !== undefined) return;
  const original = getComputedStyle(el).paddingLeft;
  el.dataset[PAD_DATA_KEY] = original;
  const parsed = Number.parseFloat(original);
  el.style.paddingLeft = `${(Number.isFinite(parsed) ? parsed : 0) + gutterWidth()}px`;
}

function removeGutter(el: HTMLElement): void {
  const original = el.dataset[PAD_DATA_KEY];
  if (original === undefined) return;
  delete el.dataset[PAD_DATA_KEY];
  el.style.removeProperty('padding-left');
}

/** Adds the grab handle to every row that does not have one yet. */
export function ensureGrips(surface: Surface): void {
  for (const row of surface.rows) {
    addGutter(row.el);
    if (row.el.querySelector(`:scope > .${GRIP_CLASS}`)) continue;
    const grip = document.createElement('div');
    grip.className = GRIP_CLASS;
    grip.setAttribute('role', 'button');
    grip.setAttribute('aria-label', 'Drag to reorder');
    row.el.appendChild(grip);
  }
}

export function removeGrips(surface: Surface): void {
  for (const row of surface.rows) {
    row.el.querySelector(`:scope > .${GRIP_CLASS}`)?.remove();
    removeGutter(row.el);
  }
}

function rowFor(surface: Surface, el: Element | null): Row | null {
  if (!el) return null;
  const host = el.closest(`[${ROW_ATTR}]`);
  if (!host) return null;
  return surface.rows.find((row) => row.el === host) ?? null;
}

function applyOrderList(order: Row[]): void {
  order.forEach((row, index) => row.el.style.setProperty('order', String(index)));
}

function beginDrag(row: Row, pointerId: number, clientY: number, captureTarget: HTMLElement): void {
  const surface = currentSurface;
  if (!surface || active) return;

  const order = visualOrder(surface);
  const index = order.indexOf(row);
  if (index < 0) return;

  const rect = row.el.getBoundingClientRect();
  active = {
    surface,
    row,
    pointerId,
    captureTarget,
    order,
    startIndex: index,
    index,
    grabOffset: clientY - rect.top,
    height: rect.height,
    clientY,
    rafId: null,
    scroller: nearestScroller(row.el),
  };

  // Normalise `order` to a dense 0..n-1 range so index maths lines up.
  applyOrderList(order);

  try {
    captureTarget.setPointerCapture(pointerId);
  } catch {
    /* capture is a nicety; the document listeners still track the pointer */
  }

  row.el.setAttribute(DRAGGING_ATTR, '');
  surface.container.setAttribute(DRAGGING_ATTR, '');
  document.documentElement.setAttribute(DRAGGING_ATTR, '');
  navigator.vibrate?.(8);

  active.rafId = requestAnimationFrame(frame);
}

function positionDragged(state: DragState): { layoutTop: number; desiredTop: number } {
  const el = state.row.el;
  el.style.transition = 'none';
  el.style.transform = '';
  const layoutTop = el.getBoundingClientRect().top;
  const desiredTop = state.clientY - state.grabOffset;
  el.style.transform = `translateY(${desiredTop - layoutTop}px)`;
  return { layoutTop, desiredTop };
}

/**
 * Hit-testing uses offsetTop/offsetHeight rather than bounding rects: those are
 * layout positions, so in-flight FLIP transforms cannot make the target index
 * flicker.
 */
function reorderIfNeeded(state: DragState, layoutTop: number, desiredTop: number): void {
  const el = state.row.el;
  const originDelta = layoutTop - el.offsetTop;
  const center = desiredTop - originDelta + state.height / 2;

  let target = 0;
  for (const row of state.order) {
    if (row === state.row) continue;
    if (row.el.offsetTop + row.el.offsetHeight / 2 < center) target += 1;
  }
  if (target === state.index) return;

  const before = new Map<HTMLElement, number>();
  for (const row of state.order) {
    if (row !== state.row) before.set(row.el, row.el.offsetTop);
  }

  state.order.splice(state.index, 1);
  state.order.splice(target, 0, state.row);
  state.index = target;
  applyOrderList(state.order);

  const moved: Array<[HTMLElement, number]> = [];
  for (const row of state.order) {
    if (row === state.row) continue;
    const previous = before.get(row.el);
    if (previous === undefined) continue;
    const delta = previous - row.el.offsetTop;
    if (delta !== 0) moved.push([row.el, delta]);
  }
  for (const [element, delta] of moved) {
    element.style.transition = 'none';
    element.style.transform = `translateY(${delta}px)`;
  }
  if (moved.length > 0) {
    requestAnimationFrame(() => {
      for (const [element] of moved) {
        element.style.transition = `transform ${FLIP_MS}ms ease`;
        element.style.transform = '';
      }
    });
  }
}

function autoScroll(state: DragState): void {
  let top: number;
  let bottom: number;
  if (state.scroller === window) {
    top = 0;
    bottom = window.innerHeight;
  } else {
    const rect = (state.scroller as HTMLElement).getBoundingClientRect();
    top = rect.top;
    bottom = rect.bottom;
  }

  let step = 0;
  if (state.clientY < top + EDGE_ZONE) {
    step = -MAX_SCROLL_STEP * Math.min(1, (top + EDGE_ZONE - state.clientY) / EDGE_ZONE);
  } else if (state.clientY > bottom - EDGE_ZONE) {
    step = MAX_SCROLL_STEP * Math.min(1, (state.clientY - (bottom - EDGE_ZONE)) / EDGE_ZONE);
  }
  if (step === 0) return;

  if (state.scroller === window) window.scrollBy(0, step);
  else (state.scroller as HTMLElement).scrollTop += step;
}

function frame(): void {
  const state = active;
  if (!state) return;
  autoScroll(state);
  const { layoutTop, desiredTop } = positionDragged(state);
  reorderIfNeeded(state, layoutTop, desiredTop);
  state.rafId = requestAnimationFrame(frame);
}

function endDrag(commit: boolean): void {
  const state = active;
  if (!state) return;
  active = null;

  if (state.rafId !== null) cancelAnimationFrame(state.rafId);
  try {
    state.captureTarget.releasePointerCapture(state.pointerId);
  } catch {
    /* capture may already be gone */
  }

  for (const row of state.order) {
    row.el.style.transition = '';
    row.el.style.transform = '';
  }
  state.row.el.removeAttribute(DRAGGING_ATTR);
  state.surface.container.removeAttribute(DRAGGING_ATTR);
  document.documentElement.removeAttribute(DRAGGING_ATTR);

  const changed = state.index !== state.startIndex;
  if (changed) suppressClicksUntil = Date.now() + CLICK_SUPPRESS_MS;

  if (commit && changed) {
    currentHooks?.onCommit(state.order.map((row) => row.videoId));
  } else if (!changed) {
    applyOrderList(state.order);
  }
}

function disarm(): void {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed = null;
}

function onPointerDown(event: PointerEvent): void {
  if (!currentSurface || active) return;
  if (event.button !== 0 && event.pointerType === 'mouse') return;

  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest(`.${GRIP_CLASS}`)) {
    const row = rowFor(currentSurface, target);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    beginDrag(row, event.pointerId, event.clientY, row.el);
    return;
  }

  // Press-and-hold anywhere on a row is the touch-friendly second route in.
  const row = rowFor(currentSurface, target);
  if (!row) return;
  disarm();
  armed = {
    row,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    captureTarget: row.el,
    timer: window.setTimeout(() => {
      const pending = armed;
      armed = null;
      if (pending) beginDrag(pending.row, pending.pointerId, pending.startY, pending.captureTarget);
    }, LONG_PRESS_MS),
  };
}

function onPointerMove(event: PointerEvent): void {
  if (active && event.pointerId === active.pointerId) {
    active.clientY = event.clientY;
    if (event.cancelable) event.preventDefault();
    return;
  }
  if (armed && event.pointerId === armed.pointerId) {
    // Movement before the timer fires means the user is scrolling, not dragging.
    if (Math.abs(event.clientY - armed.startY) > MOVE_TOLERANCE
      || Math.abs(event.clientX - armed.startX) > MOVE_TOLERANCE) {
      disarm();
    }
  }
}

function onPointerUp(event: PointerEvent): void {
  if (armed && event.pointerId === armed.pointerId) disarm();
  if (active && event.pointerId === active.pointerId) endDrag(true);
}

function onPointerCancel(event: PointerEvent): void {
  if (armed && event.pointerId === armed.pointerId) disarm();
  if (active && event.pointerId === active.pointerId) endDrag(false);
}

/**
 * Touch scrolling is cancelled here rather than through `touch-action`, because
 * the long-press route only knows it is a drag after the gesture has started.
 */
function onTouchMove(event: TouchEvent): void {
  if (active && event.cancelable) event.preventDefault();
}

function onClickCapture(event: MouseEvent): void {
  if (Date.now() > suppressClicksUntil) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(`[${ROW_ATTR}]`)) return;
  event.preventDefault();
  event.stopPropagation();
}

function onContextMenu(event: Event): void {
  if (active) event.preventDefault();
}

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('contextmenu', onContextMenu, true);
}

export function attachDrag(surface: Surface, hooks: DragHooks): void {
  currentSurface = surface;
  currentHooks = hooks;
  install();
  ensureGrips(surface);
  surface.container.setAttribute(DRAG_READY_ATTR, '');
}

export function detachDrag(surface: Surface | null): void {
  disarm();
  endDrag(false);
  if (surface) {
    removeGrips(surface);
    surface.container.removeAttribute(DRAG_READY_ATTR);
  }
  currentSurface = null;
  currentHooks = null;
}
