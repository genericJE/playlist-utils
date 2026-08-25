import { BUTTON_CLASS, MENU_CLASS } from './consts';
import { MODE_HINTS, MODE_LABELS } from './order';
import type { SortMode } from './store';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MODES: SortMode[] = [
  'original',
  'reverse',
  'chrono',
  'chrono-flipped',
  'views-desc',
  'views-asc',
];

export interface MenuState {
  mode: SortMode;
  hasCustom: boolean;
  dragEnabled: boolean;
  autoplayFollowsOrder: boolean;
  /** Transient line under the options, e.g. date-fetch progress. */
  status: string | null;
}

export interface MenuCallbacks {
  getState(): MenuState;
  onSelectMode(mode: SortMode): void;
  onToggleDrag(enabled: boolean): void;
  onToggleAutoplay(enabled: boolean): void;
  onResetCustom(): void;
}

function icon(paths: string[], size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const SORT_ICON = () => icon(['M4 7h10', 'M4 12h7', 'M4 17h4', 'M17 7v10', 'M14 14l3 3 3-3']);
const CHECK_ICON = () => icon(['M4 12.5l5 5L20 6.5'], 16);

let button: HTMLButtonElement | null = null;
let holder: HTMLElement | null = null;
let menu: HTMLElement | null = null;
let callbacks: MenuCallbacks | null = null;

function closeMenu(): void {
  menu?.remove();
  menu = null;
  button?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', positionMenu);
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target instanceof Node ? event.target : null;
  if (!target) return;
  if (menu?.contains(target) || button?.contains(target)) return;
  closeMenu();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeMenu();
  }
}

function positionMenu(): void {
  if (!menu || !button) return;
  const compact = window.innerWidth < 600;
  menu.classList.toggle('plu-menu--sheet', compact);
  if (compact) {
    menu.style.left = '';
    menu.style.top = '';
    return;
  }
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 8;
  const top = below + height > window.innerHeight - 8
    ? Math.max(8, rect.top - height - 8)
    : below;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function optionRow(mode: SortMode, state: MenuState): HTMLElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'plu-menu__item';
  if (state.mode === mode) item.classList.add('is-selected');

  const tick = document.createElement('span');
  tick.className = 'plu-menu__tick';
  if (state.mode === mode) tick.appendChild(CHECK_ICON());
  item.appendChild(tick);

  const text = document.createElement('span');
  text.className = 'plu-menu__text';
  const label = document.createElement('span');
  label.className = 'plu-menu__label';
  label.textContent = MODE_LABELS[mode];
  const hint = document.createElement('span');
  hint.className = 'plu-menu__hint';
  hint.textContent = MODE_HINTS[mode];
  text.append(label, hint);
  item.appendChild(text);

  item.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    callbacks?.onSelectMode(mode);
    closeMenu();
  });
  return item;
}

function toggleRow(label: string, hint: string, on: boolean, onPick: () => void): HTMLElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'plu-menu__item plu-menu__item--toggle';

  const tick = document.createElement('span');
  tick.className = 'plu-menu__tick';
  if (on) tick.appendChild(CHECK_ICON());

  const text = document.createElement('span');
  text.className = 'plu-menu__text';
  const title = document.createElement('span');
  title.className = 'plu-menu__label';
  title.textContent = label;
  const sub = document.createElement('span');
  sub.className = 'plu-menu__hint';
  sub.textContent = hint;
  text.append(title, sub);

  item.append(tick, text);
  item.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPick();
    closeMenu();
  });
  return item;
}

function buildMenu(state: MenuState): HTMLElement {
  const root = document.createElement('div');
  root.className = MENU_CLASS;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Playlist order');

  const title = document.createElement('div');
  title.className = 'plu-menu__title';
  title.textContent = 'Playlist order';
  root.appendChild(title);

  for (const mode of MODES) root.appendChild(optionRow(mode, state));
  if (state.hasCustom) root.appendChild(optionRow('custom', state));

  if (state.status) {
    const status = document.createElement('div');
    status.className = 'plu-menu__status';
    status.textContent = state.status;
    root.appendChild(status);
  }

  const divider = document.createElement('div');
  divider.className = 'plu-menu__divider';
  root.appendChild(divider);

  root.appendChild(toggleRow(
    'Drag to reorder',
    'Grab the handle, or press and hold a row',
    state.dragEnabled,
    () => callbacks?.onToggleDrag(!state.dragEnabled),
  ));

  root.appendChild(toggleRow(
    'Autoplay follows this order',
    'Next and previous use your order, not YouTube\'s',
    state.autoplayFollowsOrder,
    () => callbacks?.onToggleAutoplay(!state.autoplayFollowsOrder),
  ));

  if (state.hasCustom) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'plu-menu__item plu-menu__item--danger';
    const spacer = document.createElement('span');
    spacer.className = 'plu-menu__tick';
    const resetText = document.createElement('span');
    resetText.className = 'plu-menu__text';
    const resetLabel = document.createElement('span');
    resetLabel.className = 'plu-menu__label';
    resetLabel.textContent = 'Forget my drag order';
    resetText.appendChild(resetLabel);
    reset.append(spacer, resetText);
    reset.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      callbacks?.onResetCustom();
      closeMenu();
    });
    root.appendChild(reset);
  }

  return root;
}

function openMenu(): void {
  if (!callbacks) return;
  closeMenu();
  menu = buildMenu(callbacks.getState());
  document.body.appendChild(menu);
  button?.setAttribute('aria-expanded', 'true');
  positionMenu();
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', positionMenu);
}

/** Re-renders the popup in place, used while date lookups report progress. */
export function refreshMenu(): void {
  if (!menu || !callbacks) return;
  const next = buildMenu(callbacks.getState());
  menu.replaceWith(next);
  menu = next;
  positionMenu();
}

export function updateButtonLabel(mode: SortMode): void {
  const label = button?.querySelector('.plu-button__label');
  if (label) label.textContent = mode === 'original' ? 'Order' : MODE_LABELS[mode];
  button?.classList.toggle('is-active', mode !== 'original');
}

function createButton(): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = BUTTON_CLASS;
  element.setAttribute('aria-haspopup', 'dialog');
  element.setAttribute('aria-expanded', 'false');
  element.title = 'Playlist order';
  element.appendChild(SORT_ICON());
  const label = document.createElement('span');
  label.className = 'plu-button__label';
  label.textContent = 'Order';
  element.appendChild(label);
  element.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu) closeMenu();
    else openMenu();
  });
  return element;
}

/**
 * Puts the button in YouTube's own header when there is a sensible slot, and
 * falls back to a floating control so the feature is never unreachable.
 */
export function mountButton(anchor: HTMLElement | null, cbs: MenuCallbacks): void {
  callbacks = cbs;

  const parent = anchor ?? document.body;
  if (holder?.isConnected && holder.parentElement === parent) return;

  holder?.remove();
  holder = document.createElement('div');
  holder.className = 'plu-holder';
  button = createButton();
  holder.appendChild(button);

  if (anchor) {
    anchor.appendChild(holder);
  } else {
    holder.classList.add('plu-holder--floating');
    document.body.appendChild(holder);
  }
}

export function buttonMounted(): boolean {
  return !!holder?.isConnected;
}

export function unmountButton(): void {
  closeMenu();
  holder?.remove();
  holder = null;
  button = null;
  callbacks = null;
}
