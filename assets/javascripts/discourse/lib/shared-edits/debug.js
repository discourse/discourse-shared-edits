/**
 * Debug logging utilities for SharedEdits.
 * Logs are only output in development mode.
 */
import { isDevelopment } from "discourse/lib/environment";

const PREFIX = "[SharedEdits]";

export function debugLog(...args) {
  if (isDevelopment()) {
    // eslint-disable-next-line no-console
    console.log(PREFIX, ...args);
  }
}

export function debugWarn(...args) {
  if (isDevelopment()) {
    // eslint-disable-next-line no-console
    console.warn(PREFIX, ...args);
  }
}

export function debugError(...args) {
  if (isDevelopment()) {
    // eslint-disable-next-line no-console
    console.error(PREFIX, ...args);
  }
}
