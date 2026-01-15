// Entry point for bundling core Yjs + awareness helpers
// Used by lib/tasks/yjs.rake to create public/javascripts/yjs-dist.js

import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

const SharedEditsYjs = {
  Y,
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
};

// Also expose globally
if (typeof window !== "undefined") {
  window.SharedEditsYjs = SharedEditsYjs;
  window.Y = Y;
}

export {
  Y,
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
};
