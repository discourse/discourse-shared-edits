// Entry point for bundling y-prosemirror plugins for shared edits
// Requires the core bundle to have already set window.SharedEditsYjs.Y

import {
  prosemirrorToYXmlFragment,
  redo,
  undo,
  yCursorPlugin,
  ySyncPlugin,
  yUndoPlugin,
} from "y-prosemirror";

const base =
  typeof window !== "undefined" && window.SharedEditsYjs
    ? window.SharedEditsYjs
    : {};

const SharedEditsYjs = {
  ...base,
  prosemirrorToYXmlFragment,
  ySyncPlugin,
  yCursorPlugin,
  yUndoPlugin,
  undo,
  redo,
};

if (typeof window !== "undefined") {
  window.SharedEditsYjs = SharedEditsYjs;
  if (base.Y) {
    window.Y ||= base.Y;
  }
}
