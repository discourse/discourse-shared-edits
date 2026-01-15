/**
 * Pure utility functions for shared edits encoding, diffing, and selection transforms.
 * These have no service dependencies and can be used anywhere.
 */

// Base64 encoding/decoding utilities

export function base64ToUint8Array(str) {
  if (!str) {
    return new Uint8Array();
  }

  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function uint8ArrayToBase64(uint8) {
  let binary = "";
  uint8.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export function uint8ArrayToBase64url(uint8) {
  return uint8ArrayToBase64(uint8)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64urlToUint8Array(str) {
  if (!str) {
    return new Uint8Array();
  }

  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return base64ToUint8Array(base64);
}

// Relative position encoding for cursor sync

export function encodeRelativePositionToBase64url(relativePosition) {
  if (!relativePosition || !window.Y || !window.Y.encodeRelativePosition) {
    return null;
  }

  const encoded = window.Y.encodeRelativePosition(relativePosition);
  return uint8ArrayToBase64url(encoded);
}

export function decodeRelativePositionFromBase64url(base64url) {
  if (!base64url || !window.Y || !window.Y.decodeRelativePosition) {
    return null;
  }

  try {
    const uint8 = base64urlToUint8Array(base64url);
    return window.Y.decodeRelativePosition(uint8);
  } catch {
    return null;
  }
}

// Text diff algorithm - applies minimal changes to Y.Text

export function applyDiff(yText, before, after) {
  if (before === after) {
    return;
  }

  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start++;
  }

  let endBefore = before.length - 1;
  let endAfter = after.length - 1;

  while (
    endBefore >= start &&
    endAfter >= start &&
    before[endBefore] === after[endAfter]
  ) {
    endBefore--;
    endAfter--;
  }

  const removeCount = Math.max(0, endBefore - start + 1);
  const insertText = endAfter >= start ? after.slice(start, endAfter + 1) : "";

  if (removeCount > 0) {
    yText.delete(start, removeCount);
  }

  if (insertText.length > 0) {
    yText.insert(start, insertText);
  }
}

// Selection transform through Yjs delta

export function transformSelection(selection, delta) {
  if (!selection) {
    return null;
  }

  let { start, end } = selection;
  let index = 0;

  delta.forEach((op) => {
    if (op.retain) {
      index += op.retain;
      return;
    }

    if (op.delete) {
      const count = op.delete;
      if (start > index) {
        start = Math.max(index, start - count);
      }
      if (end > index) {
        end = Math.max(index, end - count);
      }
      return;
    }

    if (op.insert) {
      const count = typeof op.insert === "string" ? op.insert.length : 0;
      if (start >= index) {
        start += count;
      }
      if (end >= index) {
        end += count;
      }
      index += count;
    }
  });

  return { start, end };
}

// User colors for cursor display

export const USER_COLORS = [
  { color: "#3b82f6", colorLight: "#dbeafe" }, // blue
  { color: "#22c55e", colorLight: "#dcfce7" }, // green
  { color: "#f59e0b", colorLight: "#fef3c7" }, // amber
  { color: "#ef4444", colorLight: "#fee2e2" }, // red
  { color: "#8b5cf6", colorLight: "#ede9fe" }, // violet
  { color: "#ec4899", colorLight: "#fce7f3" }, // pink
  { color: "#06b6d4", colorLight: "#cffafe" }, // cyan
];

export function getUserColorForId(userId) {
  return USER_COLORS[(userId || 0) % USER_COLORS.length];
}
