const PREFIX = '[playlist-utils]';

export function log(...args: unknown[]): void {
  console.debug(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}
