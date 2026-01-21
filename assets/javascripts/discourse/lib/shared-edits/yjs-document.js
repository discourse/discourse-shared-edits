/**
 * Manages Y.Doc lifecycle: creation, initialization, and teardown.
 * Also handles Yjs library loading and ProseMirror capture utilities.
 */
import { getOwner, setOwner } from "@ember/owner";
import { service } from "@ember/service";
import loadScript from "discourse/lib/load-script";
import { YJS_DIST_URL, YJS_PROSEMIRROR_URL } from "./bundle-paths";
import { base64ToUint8Array, getUserColorForId } from "./encoding-utils";

// Yjs loading promises (module-level for singleton behavior)
let yjsPromise;
let yjsProsemirrorPromise;

// ProseMirror capture namespace
const PM_NAMESPACE = "__sharedEditsProseMirror";

// ProseMirror capture utilities for rich mode

export function capturePM(params) {
  if (typeof window === "undefined") {
    return;
  }

  window[PM_NAMESPACE] = {
    pmState: params.pmState,
    pmView: params.pmView,
    pmModel: params.pmModel,
    pmTransform: params.pmTransform,
    pmCommands: params.pmCommands,
    pmHistory: params.pmHistory,
    pmInputrules: params.pmInputrules,
    pmKeymap: params.pmKeymap,
  };
}

export function clearPM() {
  if (typeof window === "undefined") {
    return;
  }

  delete window[PM_NAMESPACE];
}

export function getPM() {
  if (typeof window === "undefined") {
    return null;
  }
  return window[PM_NAMESPACE] || null;
}

// Markdown conversion utilities for rich mode

let convertToMarkdownFn = null;
let prosemirrorViewGetter = null;
let capturedMarkdown = null;

export function setConvertToMarkdown(fn) {
  convertToMarkdownFn = fn;
}

export function setProsemirrorViewGetter(getter) {
  prosemirrorViewGetter = getter;
}

export function setCapturedMarkdown(markdown) {
  capturedMarkdown = markdown;
}

export function clearRichModeSerializers() {
  convertToMarkdownFn = null;
  prosemirrorViewGetter = null;
  capturedMarkdown = null;
}

export function getMarkdownFromView({ consumeCapture = false } = {}) {
  // Try to get markdown from live ProseMirror view first.
  // This ensures we always use the current editor state when the view is available,
  // rather than potentially stale captured markdown from a previous session.
  if (convertToMarkdownFn && prosemirrorViewGetter) {
    const view = prosemirrorViewGetter();
    if (view && !view.isDestroyed) {
      try {
        const result = convertToMarkdownFn(view.state.doc);
        // Successfully got markdown from live view - clear any stale captured value
        if (capturedMarkdown !== null) {
          capturedMarkdown = null;
        }
        return result;
      } catch {
        // Fall through to captured markdown fallback
      }
    }
  }

  // Fall back to captured markdown only when the live view is not available.
  // This happens during commit when the ProseMirror view has been destroyed
  // but we still need to serialize the final document state.
  if (capturedMarkdown !== null) {
    if (consumeCapture) {
      const captured = capturedMarkdown;
      capturedMarkdown = null;
      return captured;
    }
    return capturedMarkdown;
  }

  return null;
}

// Test support: reset module state between tests
// Note: We don't reset yjsPromise/yjsProsemirrorPromise because the Yjs
// library is a singleton that persists for the browser session. Resetting
// these would cause issues if code still holds references to Y objects.
export function resetYjsModuleState() {
  clearRichModeSerializers();
  clearPM();
}

// Yjs loading functions

export function triggerYjsLoad() {
  if (!yjsPromise) {
    yjsPromise = (async () => {
      await loadScript(YJS_DIST_URL);
      return window.Y;
    })().catch((e) => {
      yjsPromise = null;
      throw e;
    });
  }
  return yjsPromise;
}

export async function ensureYjsLoaded() {
  if (!yjsPromise) {
    return triggerYjsLoad();
  }
  return yjsPromise;
}

export function ensureYjsProsemirrorLoaded() {
  if (!yjsProsemirrorPromise) {
    yjsProsemirrorPromise = (async () => {
      await ensureYjsLoaded();

      const pm = getPM();
      if (!pm?.pmState || !pm?.pmView || !pm?.pmModel) {
        throw new Error(
          "ProseMirror modules missing - ensure capturePM() was called"
        );
      }

      await loadScript(YJS_PROSEMIRROR_URL);

      return window.SharedEditsYjs;
    })().catch((e) => {
      yjsProsemirrorPromise = null;
      throw e;
    });
  }

  return yjsProsemirrorPromise;
}

/**
 * YjsDocument manages the lifecycle of a Y.Doc instance.
 */
export default class YjsDocument {
  @service siteSettings;
  @service currentUser;

  doc = null;
  text = null;
  xmlFragment = null;
  awareness = null;
  undoManager = null;
  textObserver = null;

  #onDocUpdate = null;
  #onRichDocUpdate = null;

  constructor(context) {
    setOwner(this, getOwner(context));
  }

  get isRichMode() {
    return this.siteSettings.shared_edits_editor_mode === "rich";
  }

  async setup(state, raw, callbacks = {}) {
    this.teardown();

    if (this.isRichMode) {
      try {
        await this.#setupRichDoc(state, callbacks);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[SharedEdits] Rich mode setup failed, falling back to markdown:",
          error
        );
        this.teardown();
        callbacks.onRichModeFailed?.();
        await this.#setupMarkdownDoc(state, raw, callbacks);
      }
    } else {
      await this.#setupMarkdownDoc(state, raw, callbacks);
    }
  }

  async #setupMarkdownDoc(
    state,
    raw,
    { onDocUpdate, onTextObserve, undoOrigin } = {}
  ) {
    const Y = await ensureYjsLoaded();

    this.doc = new Y.Doc();
    this.text = this.doc.getText("post");

    const initialUpdate = base64ToUint8Array(state);

    if (initialUpdate.length > 0) {
      Y.applyUpdate(this.doc, initialUpdate, "remote");
    } else if (raw) {
      this.text.insert(0, raw);
    }

    if (onTextObserve) {
      this.textObserver = (event, transaction) =>
        onTextObserve(event, transaction);
      this.text.observe(this.textObserver);
    }

    if (onDocUpdate) {
      this.#onDocUpdate = onDocUpdate;
      this.doc.on("update", this.#onDocUpdate);
    }

    this.undoManager = new Y.UndoManager(this.text, {
      trackedOrigins: new Set([undoOrigin || this]),
      captureTimeout: 500,
    });
  }

  async #setupRichDoc(state, { onDocUpdate } = {}) {
    await ensureYjsLoaded();

    const SharedEditsYjs = window.SharedEditsYjs;
    if (!SharedEditsYjs) {
      throw new Error("SharedEditsYjs not loaded - Yjs bundle may be missing");
    }

    const { Y, Awareness } = SharedEditsYjs;
    if (!Y || !Awareness) {
      throw new Error("Yjs or Awareness not available in SharedEditsYjs");
    }

    this.doc = new Y.Doc();
    this.xmlFragment = this.doc.getXmlFragment("prosemirror");
    this.text = this.doc.getText("post");
    this.awareness = new Awareness(this.doc);

    const userColors = getUserColorForId(this.currentUser?.id || 0);
    this.awareness.setLocalStateField("user", {
      name: this.currentUser?.username || "Anonymous",
      color: userColors.color,
      colorLight: userColors.colorLight,
    });

    const initialUpdate = base64ToUint8Array(state);
    if (initialUpdate.length > 0) {
      Y.applyUpdate(this.doc, initialUpdate, "remote");
    }

    if (onDocUpdate) {
      this.#onRichDocUpdate = onDocUpdate;
      this.doc.on("update", this.#onRichDocUpdate);
    }

    // Note: Awareness handler is registered separately via RichModeSync.setupAwarenessHandler
    // to ensure proper cleanup. Don't register it here to avoid double registration.

    return {
      xmlFragment: this.xmlFragment,
      awareness: this.awareness,
      hasXmlContent: this.xmlFragment.length > 0,
    };
  }

  applyRemoteUpdate(updateBinary) {
    if (this.doc && updateBinary) {
      window.Y.applyUpdate(this.doc, updateBinary, "remote");
    }
  }

  applyRemoteUpdateWithOrigin(updateBinary, origin) {
    if (this.doc && updateBinary) {
      window.Y.applyUpdate(this.doc, updateBinary, origin);
    }
  }

  getText() {
    return this.text?.toString() ?? "";
  }

  teardown() {
    if (this.text && this.textObserver) {
      this.text.unobserve(this.textObserver);
    }

    if (this.doc) {
      if (this.#onDocUpdate) {
        this.doc.off("update", this.#onDocUpdate);
      }
      if (this.#onRichDocUpdate) {
        this.doc.off("update", this.#onRichDocUpdate);
      }
    }

    if (this.undoManager) {
      this.undoManager.destroy();
      this.undoManager = null;
    }

    if (this.awareness) {
      this.awareness.destroy();
      this.awareness = null;
    }

    if (this.doc) {
      this.doc.destroy();
    }

    this.doc = null;
    this.text = null;
    this.xmlFragment = null;
    this.textObserver = null;
    this.#onDocUpdate = null;
    this.#onRichDocUpdate = null;
  }
}
