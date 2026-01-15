import { debounce, throttle } from "@ember/runloop";
import Service, { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import loadScript from "discourse/lib/load-script";
import { i18n } from "discourse-i18n";
import CursorOverlay from "../lib/cursor-overlay";
import {
  clearSharedEditYjsState,
  setSharedEditYjsState,
} from "../lib/shared-edits-prosemirror-extension";

const THROTTLE_SAVE = 350;
const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";
const SPELLCHECK_SUSPEND_DURATION_MS = 1000;
let yjsPromise;
let yjsProsemirrorPromise;

// Namespaced storage for ProseMirror references to avoid polluting window
// The yjs-prosemirror bundle's require shim reads from this namespace
const PM_NAMESPACE = "__sharedEditsProseMirror";

export function capturePM(params) {
  if (typeof window === "undefined") {
    return;
  }

  // Store in namespaced object to avoid global pollution.
  // The yjs-prosemirror bundle's require shim reads from this namespace.
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

// Store reference to convertToMarkdown for proper serialization of rich content
// This allows images, links, etc. to be converted back to markdown on commit
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

export function getMarkdownFromView() {
  // First check if we have captured markdown (from view destroy)
  if (capturedMarkdown !== null) {
    return capturedMarkdown;
  }

  if (!convertToMarkdownFn || !prosemirrorViewGetter) {
    return null;
  }

  const view = prosemirrorViewGetter();

  if (!view || view.isDestroyed) {
    return null;
  }

  try {
    return convertToMarkdownFn(view.state.doc);
  } catch {
    return null;
  }
}

async function ensureYjsLoaded() {
  if (!yjsPromise) {
    return triggerYjsLoad();
  }
  return yjsPromise;
}

export function triggerYjsLoad() {
  if (!yjsPromise) {
    yjsPromise = (async () => {
      await loadScript(
        "/plugins/discourse-shared-edits/javascripts/yjs-dist.js"
      );
      return window.Y;
    })().catch((e) => {
      yjsPromise = null;
      throw e;
    });
  }
  return yjsPromise;
}

export function ensureYjsProsemirrorLoaded() {
  if (!yjsProsemirrorPromise) {
    yjsProsemirrorPromise = (async () => {
      await ensureYjsLoaded();

      // Check the namespaced PM object for required modules
      const pm = getPM();
      if (!pm?.pmState || !pm?.pmView || !pm?.pmModel) {
        throw new Error(
          "ProseMirror modules missing - ensure capturePM() was called"
        );
      }

      await loadScript(
        "/plugins/discourse-shared-edits/javascripts/yjs-prosemirror.js"
      );

      return window.SharedEditsYjs;
    })().catch((e) => {
      yjsProsemirrorPromise = null;
      throw e;
    });
  }

  return yjsProsemirrorPromise;
}

function base64ToUint8Array(str) {
  if (!str) {
    return new Uint8Array();
  }

  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

function uint8ArrayToBase64(uint8) {
  let binary = "";
  uint8.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function encodeRelativePositionToBase64(relativePosition) {
  if (!relativePosition || !window.Y || !window.Y.encodeRelativePosition) {
    return null;
  }

  const encoded = window.Y.encodeRelativePosition(relativePosition);
  return uint8ArrayToBase64(encoded);
}

function decodeRelativePositionFromBase64(base64) {
  if (!base64 || !window.Y || !window.Y.decodeRelativePosition) {
    return null;
  }

  try {
    const uint8 = base64ToUint8Array(base64);
    return window.Y.decodeRelativePosition(uint8);
  } catch {
    return null;
  }
}

function applyDiff(yText, before, after) {
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

function transformSelection(selection, delta) {
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

// User colors for cursor display (from hello.html pattern)
const USER_COLORS = [
  { color: "#3b82f6", colorLight: "#dbeafe" }, // blue
  { color: "#22c55e", colorLight: "#dcfce7" }, // green
  { color: "#f59e0b", colorLight: "#fef3c7" }, // amber
  { color: "#ef4444", colorLight: "#fee2e2" }, // red
  { color: "#8b5cf6", colorLight: "#ede9fe" }, // violet
  { color: "#ec4899", colorLight: "#fce7f3" }, // pink
  { color: "#06b6d4", colorLight: "#cffafe" }, // cyan
];

export default class SharedEditManager extends Service {
  @service composer;
  @service messageBus;
  @service siteSettings;
  @service currentUser;
  @service dialog;

  ajaxInProgress = false;
  doc = null;
  text = null;
  currentPostId = null;
  pendingUpdates = [];
  suppressComposerChange = false;
  textObserver = null;
  /** @type {Promise<void>|null} - for eslint */
  inFlightRequest = null;
  messageBusLastId = null;
  pendingComposerReply = null;
  // Rich mode properties (hello.html:480-481, 547)
  awareness = null;
  xmlFragment = null;
  pendingAwarenessUpdate = null;
  #composerReady = false;
  #composerObserverAttached = false;
  #messageBusPostId = null;
  #messageBusLastSubscribedId = null;

  #pendingRelativeSelection = null;
  #isSelecting = false;
  #selectionListenersAttached = false;
  #skippedUpdatesDuringSelection = false;
  #spellcheckTimeoutId = null;
  #spellcheckRestoreValue = null;
  #spellcheckTextarea = null;
  #syncingTextFromComposer = false;
  #onRemoteMessage = (message) => {
    if (message.action === "resync") {
      this.#handleResync();
      return;
    }

    if (!this.doc || message.client_id === this.messageBus.clientId) {
      return;
    }

    if (this.isRichMode && message.awareness) {
      const { applyAwarenessUpdate } = window.SharedEditsYjs;
      applyAwarenessUpdate(
        this.awareness,
        base64ToUint8Array(message.awareness),
        "sync" // Critical: prevents re-broadcasting (hello.html:490)
      );
    }

    if (message.update) {
      // Markdown mode: disable spellcheck during remote updates
      if (!this.isRichMode) {
        this.#temporarilyDisableSpellcheck();
      }
    }

    // Rich mode: Yjs handles everything via ySyncPlugin
    if (this.isRichMode) {
      if (message.update) {
        const update = base64ToUint8Array(message.update);
        window.Y.applyUpdate(this.doc, update, "remote");
      }
      return;
    }

    // Markdown mode: handle cursor and text sync manually
    if (!this.#isSelecting) {
      this.#pendingRelativeSelection = this.#captureRelativeSelection();
    }

    const update = base64ToUint8Array(message.update);
    const cursor = this.#deserializeCursorPayload(message.cursor);

    window.Y.applyUpdate(this.doc, update, {
      type: "remote",
      client_id: message.client_id,
      user_id: message.user_id,
      user_name: message.user_name,
      cursor,
    });
  };
  #handleDocUpdate = (update, origin) => {
    if (origin !== this && origin !== this.undoManager) {
      return;
    }

    this.pendingUpdates.push(update);
    this.#sendUpdatesThrottled();
  };
  #onTextareaMouseDown = () => {
    this.#isSelecting = true;
    this.#skippedUpdatesDuringSelection = false;
  };
  #onTextareaKeydown = (event) => {
    if (!this.undoManager) {
      return;
    }

    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (isCtrl && !isShift && event.key.toLowerCase() === "z") {
      event.preventDefault();
      this.undoManager.undo();
    }

    if (
      (isCtrl && isShift && event.key.toLowerCase() === "z") ||
      (isCtrl && !isShift && event.key.toLowerCase() === "y")
    ) {
      event.preventDefault();
      this.undoManager.redo();
    }
  };
  #onTextareaMouseUp = () => {
    const hadSkippedUpdates = this.#skippedUpdatesDuringSelection;

    if (hadSkippedUpdates) {
      // Keep #isSelecting true until after the browser has processed the click's
      // selection change. Use requestAnimationFrame to defer capturing the selection
      // so we get the correct post-click cursor position rather than the pre-click
      // selection range.
      requestAnimationFrame(() => {
        const textareaSelection = this.#getTextareaSelection();
        this.#isSelecting = false;
        this.#skippedUpdatesDuringSelection = false;
        this.#syncTextareaAfterSelection(textareaSelection);
      });
    } else {
      this.#isSelecting = false;
      this.#skippedUpdatesDuringSelection = false;
    }
  };
  // Follow hello.html:460-477 pattern - handle doc updates in rich mode
  #handleRichDocUpdate = (update, origin) => {
    // Only send updates from local changes, not remote ones
    // Include "xmlSync" updates so Y.Text changes reach the server for commit
    if (origin !== "remote" && origin !== "sync") {
      this.pendingUpdates.push(update);
      // Don't trigger immediate send for xmlSync - let it batch with ProseMirror updates
      if (!this.#syncingTextFromComposer && origin !== "xmlSync") {
        this.#sendUpdatesThrottled();
      }
    }
  };
  // Follow hello.html:484-503 pattern - handle awareness updates
  #handleAwarenessUpdate = ({ added, updated, removed }, origin) => {
    if (origin !== "sync") {
      const { encodeAwarenessUpdate } = window.SharedEditsYjs;
      const clientIds = [...added, ...updated, ...removed];
      if (clientIds.length > 0) {
        this.pendingAwarenessUpdate = encodeAwarenessUpdate(
          this.awareness,
          clientIds
        );
        this.#sendUpdatesThrottled();
      }
    }
  };
  #onRichModeFailure = (error) => {
    if (this._richModeFailed || this._handlingRichModeFailure) {
      return;
    }

    this._richModeFailed = true;
    this._handlingRichModeFailure = true;

    // eslint-disable-next-line no-console
    console.error("[SharedEdits] Rich mode collaboration failed:", error);
    this.dialog.alert(i18n("shared_edits.errors.rich_mode_failed"));

    if (this.composer?.model?.action === "sharedEdit") {
      this.composer.close();
    } else {
      this.commit();
    }

    this._handlingRichModeFailure = false;
  };
  _handlingRichModeFailure = false;

  willDestroy() {
    this.#resetSpellcheckSuppression();
    super.willDestroy(...arguments);
  }

  get isRichMode() {
    // If rich mode setup failed, don't attempt it again for this session
    if (this._richModeFailed) {
      return false;
    }
    return this.siteSettings.shared_edits_editor_mode === "rich";
  }

  #getTextareaSelection() {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) {
      return null;
    }
    return { start: textarea.selectionStart, end: textarea.selectionEnd };
  }

  #syncTextareaAfterSelection(oldSelection) {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea || !this.text) {
      return;
    }

    const oldText = textarea.value;
    const newText = this.text.toString();
    const scrollTop = textarea.scrollTop;

    // Transform the selection from old content coordinates to new content coordinates
    let adjustedSelection = null;

    if (oldSelection && oldText !== newText) {
      adjustedSelection = this.#transformSelectionThroughDiff(
        oldText,
        newText,
        oldSelection
      );
    } else if (oldSelection) {
      adjustedSelection = oldSelection;
    }

    this.suppressComposerChange = true;
    this.composer.model?.set("reply", newText);
    this.suppressComposerChange = false;

    if (oldText !== newText) {
      this.#applyDiffToTextarea(textarea, oldText, newText);
    }

    if (adjustedSelection) {
      // Clamp selection to valid range
      const maxPos = newText.length;
      textarea.selectionStart = Math.min(
        Math.max(0, adjustedSelection.start),
        maxPos
      );
      textarea.selectionEnd = Math.min(
        Math.max(0, adjustedSelection.end),
        maxPos
      );
    }

    if (scrollTop !== undefined) {
      window.requestAnimationFrame(() => {
        textarea.scrollTop = scrollTop;
      });
    }
  }

  #applyDiffToTextarea(textarea, oldText, newText) {
    // Find common prefix length
    let prefixLen = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
      prefixLen++;
    }

    // Find common suffix length (but don't overlap with prefix)
    let suffixLen = 0;
    while (
      suffixLen < oldText.length - prefixLen &&
      suffixLen < newText.length - prefixLen &&
      oldText[oldText.length - 1 - suffixLen] ===
        newText[newText.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const replacement = newText.slice(prefixLen, newText.length - suffixLen);
    textarea.setRangeText(
      replacement,
      prefixLen,
      oldText.length - suffixLen,
      "preserve"
    );
  }

  #transformSelectionThroughDiff(oldText, newText, selection) {
    // Find common prefix length
    let prefixLen = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
      prefixLen++;
    }

    // Find common suffix length (but don't overlap with prefix)
    let suffixLen = 0;
    while (
      suffixLen < oldText.length - prefixLen &&
      suffixLen < newText.length - prefixLen &&
      oldText[oldText.length - 1 - suffixLen] ===
        newText[newText.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    // The change region in old text is [prefixLen, oldText.length - suffixLen)
    // The change region in new text is [prefixLen, newText.length - suffixLen)
    const oldChangeEnd = oldText.length - suffixLen;
    const newChangeEnd = newText.length - suffixLen;

    const transformPos = (pos) => {
      if (pos <= prefixLen) {
        // Before the change region - no adjustment needed
        return pos;
      } else if (pos >= oldChangeEnd) {
        // After the change region - shift by the length difference
        return pos + (newChangeEnd - oldChangeEnd);
      } else {
        // Inside the change region - map to end of new change region
        // (best guess - the old position no longer exists)
        return newChangeEnd;
      }
    };

    return {
      start: transformPos(selection.start),
      end: transformPos(selection.end),
    };
  }

  async #handleResync() {
    const postId = this.currentPostId || this.#postId;
    if (!postId) {
      return;
    }

    try {
      const data = await ajax(`/shared_edits/p/${postId}`);
      if (!this.composer.model || this.isDestroying || this.isDestroyed) {
        return;
      }
      await this.#setupDoc(data.state, data.raw);
      this.messageBusLastId = data.message_bus_last_id ?? -1;
      this.pendingComposerReply = this.text?.toString() ?? data.raw ?? "";
      this.#composerReady = false;
      await this.finalizeSubscription();
    } catch (e) {
      popupAjaxError(e);
    }
  }

  async subscribe(postId, { preOpen = false } = {}) {
    let data;
    try {
      postId = postId || this.#postId;

      if (!postId) {
        return;
      }

      // If already subscribing or subscribed to another post, don't overlap
      if (this.ajaxInProgress && this.currentPostId !== postId) {
        return;
      }

      if (this.currentPostId === postId && this.doc) {
        if (!preOpen) {
          await this.finalizeSubscription();
        }
        return { reply: this.pendingComposerReply ?? this.text?.toString() };
      }

      this.ajaxInProgress = true;
      data = await ajax(`/shared_edits/p/${postId}`);
    } catch (e) {
      popupAjaxError(e);
      return;
    } finally {
      this.ajaxInProgress = false;
    }

    try {
      if (
        this.isDestroying ||
        this.isDestroyed ||
        (this.#postId && this.#postId !== postId)
      ) {
        return;
      }

      this.currentPostId = postId;
      await this.#setupDoc(data.state, data.raw);
      this.messageBusLastId = data.message_bus_last_id ?? -1;
      this.pendingComposerReply = this.text?.toString() ?? data.raw ?? "";
      this.#composerReady = false;

      if (!preOpen) {
        await this.finalizeSubscription();
      }

      return { reply: this.pendingComposerReply };
    } catch (e) {
      popupAjaxError(e);
      return;
    }
  }

  async finalizeSubscription() {
    const postId = this.currentPostId || this.#postId;
    if (!postId || !this.doc || this.isDestroying || this.isDestroyed) {
      return;
    }

    // Wait for textarea to appear in DOM (composer may still be rendering)
    // This is needed because super.open() returns before Ember finishes rendering
    if (!this.isRichMode) {
      await this.#waitForTextarea();
    }

    if (this.#syncComposerFromDoc()) {
      this.pendingComposerReply = null;
      this.#composerReady = true;
    }

    if (!this.isRichMode) {
      this.#attachSelectionListeners();
      if (!this.cursorOverlay) {
        const textarea = document.querySelector(TEXTAREA_SELECTOR);
        if (textarea) {
          this.cursorOverlay = new CursorOverlay(textarea);
        }
      }
    }

    this.#attachComposerObserver();
    this.#subscribeMessageBus(postId);
  }

  async #waitForTextarea(maxWait = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      if (this.isDestroying || this.isDestroyed) {
        return;
      }
      const textarea = document.querySelector(TEXTAREA_SELECTOR);
      if (textarea) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async commit() {
    const postId = this.currentPostId || this.#postId;

    if (!postId) {
      return;
    }

    try {
      await this.#flushPendingUpdates();

      this.#detachComposerObserver();
      this.messageBus.unsubscribe(`/shared_edits/${postId}`);
      this.#teardownDoc();
      this.pendingUpdates = [];
      this.currentPostId = null;

      await ajax(`/shared_edits/p/${postId}/commit`, {
        method: "PUT",
      });
    } catch (e) {
      popupAjaxError(e);
    }
  }

  async #setupDoc(state, raw) {
    this.#teardownDoc();

    if (this.isRichMode) {
      try {
        await this.#setupRichDoc(state);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[SharedEdits] Rich mode setup failed, falling back to markdown:",
          error
        );
        // Clean up any partial rich mode setup
        this.#teardownDoc();
        // Fall back to markdown mode
        this._richModeFailed = true;
        await this.#setupMarkdownDoc(state, raw);
      }
    } else {
      await this.#setupMarkdownDoc(state, raw);
    }
  }

  // Markdown mode setup - uses Y.Text (original implementation)
  async #setupMarkdownDoc(state, raw) {
    const Y = await ensureYjsLoaded();

    this.doc = new Y.Doc();
    this.text = this.doc.getText("post");

    const initialUpdate = base64ToUint8Array(state);

    if (initialUpdate.length > 0) {
      Y.applyUpdate(this.doc, initialUpdate, "remote");
    } else if (raw) {
      this.text.insert(0, raw);
    }

    this.textObserver = (event, transaction) =>
      this.#handleTextChange(event, transaction);
    this.text.observe(this.textObserver);
    this.doc.on("update", this.#handleDocUpdate);

    this.undoManager = new Y.UndoManager(this.text, {
      trackedOrigins: new Set([this]),
      captureTimeout: 500,
    });

    this.#attachSelectionListeners();

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (textarea) {
      this.cursorOverlay = new CursorOverlay(textarea);
    }
  }

  // Rich mode setup - uses Y.XmlFragment with y-prosemirror
  // Consult hello.html lines 455-506 for the setup pattern
  async #setupRichDoc(state) {
    await ensureYjsLoaded();

    const SharedEditsYjs = window.SharedEditsYjs;
    if (!SharedEditsYjs) {
      throw new Error("SharedEditsYjs not loaded - Yjs bundle may be missing");
    }

    const { Y, Awareness } = SharedEditsYjs;
    if (!Y || !Awareness) {
      throw new Error("Yjs or Awareness not available in SharedEditsYjs");
    }

    // From hello.html:456 - Create Y.Doc
    this.doc = new Y.Doc();

    // From hello.html:547 - Get XmlFragment (not Y.Text!)
    this.xmlFragment = this.doc.getXmlFragment("prosemirror");
    this.text = this.doc.getText("post");

    // From hello.html:480 - Create Awareness
    this.awareness = new Awareness(this.doc);

    // From hello.html:505-506 - Set user state for cursor display
    const userColors = this.#getUserColors();
    this.awareness.setLocalStateField("user", {
      name: this.currentUser?.username || "Anonymous",
      color: userColors.color,
      colorLight: userColors.colorLight,
    });

    // Apply initial state (like hello.html but from server)
    const initialUpdate = base64ToUint8Array(state);
    if (initialUpdate.length > 0) {
      Y.applyUpdate(this.doc, initialUpdate, "remote");
    }

    const hasXmlContent = this.xmlFragment.length > 0;

    // Set state for ProseMirror extension to pick up
    // The extension's plugins() function will read this
    setSharedEditYjsState({
      xmlFragment: this.xmlFragment,
      awareness: this.awareness,
      seedXmlFromView: !hasXmlContent,
      onError: this.#onRichModeFailure,
    });

    // From hello.html:460-477 - Setup doc update handler
    this.doc.on("update", this.#handleRichDocUpdate);

    // From hello.html:484-503 - Setup awareness update handler
    this.awareness.on("update", this.#handleAwarenessUpdate);

    // Observe XmlFragment changes to keep Y.Text in sync for server-side commit
    // The server extracts text from Y.Text("post"), so we need to keep it updated.
    // Debounce to avoid heavy work on every keystroke.
    this.xmlFragmentObserver = () => {
      debounce(this, this.#syncYTextFromXmlFragment, 500);
    };
    this.xmlFragment.observeDeep(this.xmlFragmentObserver);
  }

  // Extract content from ProseMirror and sync to Y.Text
  // This ensures the server can extract the correct text on commit
  // Uses proper markdown serialization to preserve images, links, etc.
  // Returns true if sync was performed, false otherwise
  #syncYTextFromXmlFragment() {
    if (
      !this.xmlFragment ||
      this.xmlFragment.length === 0 ||
      !this.text ||
      !this.doc ||
      this.isDestroying ||
      this.isDestroyed
    ) {
      return false;
    }

    // Try proper markdown serialization first (handles images, links, etc.)
    // Falls back to text extraction if serializer not available
    let newText = getMarkdownFromView();
    if (newText === null) {
      newText = this.#extractTextFromXmlFragment(this.xmlFragment);
    }

    const currentText = this.text.toString();

    if (newText === currentText) {
      return false;
    }

    // Use a transaction to update Y.Text without triggering our own handlers
    // Use applyDiff instead of full wipe/refill for efficiency
    this.doc.transact(() => {
      applyDiff(this.text, currentText, newText);
    }, "xmlSync");

    return true;
  }

  // Recursively extract text content from XmlFragment
  #extractTextFromXmlFragment(fragment) {
    let text = "";

    const processNode = (node) => {
      if (typeof node === "string") {
        text += node;
      } else if (node.toString && !node.nodeName) {
        // This is likely an XmlText node (no nodeName, has toString)
        const str = node.toString();
        if (str) {
          text += str;
        }
      } else if (node.forEach) {
        // This is an XmlElement or XmlFragment
        node.forEach(processNode);
      }
    };

    fragment.forEach((child) => {
      processNode(child);
      // Add newline between top-level block elements
      text += "\n";
    });

    // Trim trailing newline
    return text.replace(/\n+$/, "");
  }

  // Get user colors based on user ID (hello.html pattern)
  #getUserColors() {
    const userId = this.currentUser?.id || 0;
    return USER_COLORS[userId % USER_COLORS.length];
  }

  #teardownDoc() {
    this.#resetSpellcheckSuppression();
    this.#detachComposerObserver();

    if (this.#messageBusPostId) {
      this.messageBus.unsubscribe(`/shared_edits/${this.#messageBusPostId}`);
    }

    // Markdown mode cleanup
    if (this.text && this.textObserver) {
      this.text.unobserve(this.textObserver);
    }

    if (this.doc) {
      this.doc.off("update", this.#handleDocUpdate);
      this.doc.off("update", this.#handleRichDocUpdate);
    }

    if (this.undoManager) {
      this.undoManager.destroy();
      this.undoManager = null;
    }

    this.#detachSelectionListeners();

    if (this.cursorOverlay) {
      this.cursorOverlay.destroy();
      this.cursorOverlay = null;
    }

    // Rich mode cleanup
    if (this.xmlFragment && this.xmlFragmentObserver) {
      this.xmlFragment.unobserveDeep(this.xmlFragmentObserver);
      this.xmlFragmentObserver = null;
    }

    if (this.awareness) {
      this.awareness.off("update", this.#handleAwarenessUpdate);
      this.awareness.destroy();
      this.awareness = null;
    }

    // Clear the ProseMirror extension state
    clearSharedEditYjsState();

    // Destroy the Yjs document to clean up internal state
    if (this.doc) {
      this.doc.destroy();
    }

    this.doc = null;
    this.text = null;
    this.textObserver = null;
    this.xmlFragment = null;
    this.pendingAwarenessUpdate = null;
    this.pendingComposerReply = null;
    this.messageBusLastId = null;
    this.#composerReady = false;
    this.#messageBusPostId = null;
    this.#messageBusLastSubscribedId = null;
    this._handlingRichModeFailure = false;
    // Reset rich mode failure flag on full teardown so next subscription can try again
    this._richModeFailed = false;
  }

  #attachSelectionListeners() {
    if (this.#selectionListenersAttached) {
      return;
    }

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) {
      return;
    }

    textarea.addEventListener("mousedown", this.#onTextareaMouseDown);
    textarea.addEventListener("keydown", this.#onTextareaKeydown);
    // Use document for mouseup to catch releases outside the textarea
    document.addEventListener("mouseup", this.#onTextareaMouseUp);
    this.#selectionListenersAttached = true;
  }

  #detachSelectionListeners() {
    if (!this.#selectionListenersAttached) {
      return;
    }

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (textarea) {
      textarea.removeEventListener("mousedown", this.#onTextareaMouseDown);
      textarea.removeEventListener("keydown", this.#onTextareaKeydown);
    }
    document.removeEventListener("mouseup", this.#onTextareaMouseUp);
    this.#selectionListenersAttached = false;
    this.#isSelecting = false;
  }

  #attachComposerObserver() {
    if (this.#composerObserverAttached) {
      return;
    }

    this.addObserver("composer.model.reply", this, this.#onComposerChange);
    this.#composerObserverAttached = true;
  }

  #detachComposerObserver() {
    if (!this.#composerObserverAttached) {
      return;
    }

    this.removeObserver("composer.model.reply", this, this.#onComposerChange);
    this.#composerObserverAttached = false;
  }

  #syncComposerFromDoc() {
    if (!this.composer.model || !this.text) {
      return false;
    }

    const next = this.pendingComposerReply ?? this.text.toString();
    if (this.composer.model.reply === next) {
      return true;
    }

    this.suppressComposerChange = true;
    this.composer.model.set("reply", next);
    this.suppressComposerChange = false;
    return true;
  }

  #subscribeMessageBus(postId) {
    if (!postId) {
      return;
    }

    const lastId = this.messageBusLastId ?? -1;
    const needsResubscribe =
      this.#messageBusPostId !== postId ||
      this.#messageBusLastSubscribedId !== lastId;

    if (!needsResubscribe) {
      return;
    }

    if (this.#messageBusPostId) {
      this.messageBus.unsubscribe(`/shared_edits/${this.#messageBusPostId}`);
    }

    this.messageBus.subscribe(
      `/shared_edits/${postId}`,
      this.#onRemoteMessage,
      lastId
    );
    this.#messageBusPostId = postId;
    this.#messageBusLastSubscribedId = lastId;
  }

  get #postId() {
    return this.composer.model?.post.id;
  }

  syncFromComposerValue(nextValue) {
    if (
      !this.#composerReady ||
      !this.text ||
      !this.doc ||
      this.suppressComposerChange
    ) {
      return;
    }

    const next = nextValue ?? "";
    const current = this.text.toString();

    if (current === next) {
      return;
    }

    this.doc.transact(() => applyDiff(this.text, current, next), this);
  }

  #onComposerChange() {
    if (!this.composer.model) {
      return;
    }

    this.syncFromComposerValue(this.composer.model.reply || "");
  }

  #handleTextChange(event, transaction) {
    // Update remote cursors based on text changes
    if (
      transaction.origin &&
      transaction.origin.type === "remote" &&
      this.cursorOverlay
    ) {
      const origin = transaction.origin;
      let relativePosition = origin.cursor?.end || origin.cursor?.start;

      if (!relativePosition) {
        let index = 0;
        (event.delta || []).forEach((op) => {
          if (op.retain) {
            index += op.retain;
          }
          if (op.insert) {
            const length = typeof op.insert === "string" ? op.insert.length : 1;
            index += length;
          }
        });

        relativePosition = window.Y.createRelativePositionFromTypeIndex(
          this.text,
          index,
          -1
        );
      }

      if (relativePosition) {
        this.cursorOverlay.updateCursor(
          origin.client_id,
          origin,
          relativePosition,
          this.doc
        );
      }
    }

    this.cursorOverlay?.refresh();

    if (transaction?.origin === this) {
      return;
    }

    // If user is actively selecting, skip the textarea update to avoid interrupting
    // the native selection. The Yjs doc already has the update, and we'll sync
    // the textarea on mouseup.
    if (this.#isSelecting) {
      this.#skippedUpdatesDuringSelection = true;
      return;
    }

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    const selection =
      textarea && typeof textarea.selectionStart === "number"
        ? {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
          }
        : null;

    let adjustedSelection = null;
    let scrollTop = textarea?.scrollTop;

    if (this.#pendingRelativeSelection) {
      adjustedSelection = this.#absoluteSelectionFromRelative(
        this.#pendingRelativeSelection
      );
      if (scrollTop === undefined || scrollTop === null) {
        scrollTop = this.#pendingRelativeSelection?.scrollTop;
      }
      this.#pendingRelativeSelection = null;
    }

    if (!adjustedSelection) {
      adjustedSelection = transformSelection(selection, event.delta || []);
    }

    const text = this.text.toString();
    this.suppressComposerChange = true;
    this.composer.model?.set("reply", text);
    this.suppressComposerChange = false;

    if (textarea) {
      const currentValue = textarea.value;
      if (currentValue === text) {
        // Already in sync (e.g. local edit echoed back or no change)
        return;
      }

      let appliedSurgically = false;

      if (event.delta) {
        // Calculate expected length of "old" text (State A) from current length (State B) and delta
        let expectedOldLength = text.length;
        let insertLen = 0;
        let deleteLen = 0;

        for (const op of event.delta) {
          if (op.insert) {
            insertLen += typeof op.insert === "string" ? op.insert.length : 0;
          } else if (op.delete) {
            deleteLen += op.delete;
          }
        }
        // Length B = Length A + Inserts - Deletes
        // Length A = Length B - Inserts + Deletes
        expectedOldLength = expectedOldLength - insertLen + deleteLen;

        if (currentValue.length === expectedOldLength) {
          let index = 0;
          event.delta.forEach((op) => {
            if (op.retain) {
              index += op.retain;
            } else if (op.insert) {
              textarea.setRangeText(op.insert, index, index);
              index += op.insert.length;
            } else if (op.delete) {
              textarea.setRangeText("", index, index + op.delete);
            }
          });
          appliedSurgically = true;
        }
      }

      if (!appliedSurgically) {
        this.#applyDiffToTextarea(textarea, currentValue, text);
      }

      // Refresh cursor overlay positions as text layout may have changed
      this.cursorOverlay?.refresh();

      if (adjustedSelection) {
        textarea.selectionStart = adjustedSelection.start;
        textarea.selectionEnd = adjustedSelection.end;
      }

      if (scrollTop !== undefined && textarea.scrollTop !== scrollTop) {
        window.requestAnimationFrame(() => {
          textarea.scrollTop = scrollTop;
        });
      }
    }
  }

  #captureRelativeSelection() {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);

    if (
      !textarea ||
      typeof textarea.selectionStart !== "number" ||
      typeof textarea.selectionEnd !== "number"
    ) {
      return null;
    }

    const Y = window.Y;
    return {
      start: Y.createRelativePositionFromTypeIndex(
        this.text,
        textarea.selectionStart,
        0
      ),
      end: Y.createRelativePositionFromTypeIndex(
        this.text,
        textarea.selectionEnd,
        0
      ),
      scrollTop: textarea.scrollTop,
    };
  }

  #absoluteSelectionFromRelative(rel) {
    if (!rel) {
      return null;
    }

    const Y = window.Y;

    const startAbs = Y.createAbsolutePositionFromRelativePosition(
      rel.start,
      this.doc
    );
    const endAbs = Y.createAbsolutePositionFromRelativePosition(
      rel.end,
      this.doc
    );

    if (
      !startAbs ||
      !endAbs ||
      startAbs.type !== this.text ||
      endAbs.type !== this.text
    ) {
      return null;
    }

    return {
      start: startAbs.index,
      end: endAbs.index,
      scrollTop: rel.scrollTop,
    };
  }

  #buildCursorPayload() {
    if (!this.text) {
      return null;
    }

    const selection = this.#captureRelativeSelection();
    if (!selection) {
      return null;
    }

    const cursor = {};
    const start = encodeRelativePositionToBase64(selection.start);
    if (start) {
      cursor.start = start;
    }

    const end = encodeRelativePositionToBase64(selection.end);
    if (end) {
      cursor.end = end;
    }

    return Object.keys(cursor).length ? cursor : null;
  }

  #deserializeCursorPayload(cursorPayload) {
    if (!cursorPayload) {
      return null;
    }

    const cursor = {};

    if (cursorPayload.start) {
      const start = decodeRelativePositionFromBase64(cursorPayload.start);
      if (start) {
        cursor.start = start;
      }
    }

    if (cursorPayload.end) {
      const end = decodeRelativePositionFromBase64(cursorPayload.end);
      if (end) {
        cursor.end = end;
      }
    }

    return Object.keys(cursor).length ? cursor : null;
  }

  #temporarilyDisableSpellcheck() {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);

    if (!textarea) {
      return;
    }

    if (this.#spellcheckRestoreValue === null) {
      this.#spellcheckRestoreValue = textarea.spellcheck;
    }

    this.#spellcheckTextarea = textarea;
    textarea.spellcheck = false;

    if (this.#spellcheckTimeoutId) {
      clearTimeout(this.#spellcheckTimeoutId);
    }

    this.#spellcheckTimeoutId = setTimeout(() => {
      this.#spellcheckTimeoutId = null;
      this.#applySpellcheckRestore();
    }, SPELLCHECK_SUSPEND_DURATION_MS);
  }

  #applySpellcheckRestore() {
    if (
      this.#spellcheckTextarea?.isConnected &&
      this.#spellcheckRestoreValue !== null
    ) {
      this.#spellcheckTextarea.spellcheck = this.#spellcheckRestoreValue;
    }

    this.#spellcheckTextarea = null;
    this.#spellcheckRestoreValue = null;
  }

  #resetSpellcheckSuppression() {
    if (this.#spellcheckTimeoutId) {
      clearTimeout(this.#spellcheckTimeoutId);
      this.#spellcheckTimeoutId = null;
    }

    this.#applySpellcheckRestore();
  }

  #syncTextFromComposer() {
    if (
      !this.isRichMode ||
      !this.#composerReady ||
      !this.composer.model ||
      !this.text ||
      this.suppressComposerChange
    ) {
      return;
    }

    this.#syncingTextFromComposer = true;
    try {
      const current = this.text.toString();
      const next = this.composer.model.reply || "";

      if (current !== next) {
        this.doc.transact(() => applyDiff(this.text, current, next), this);
      }
    } finally {
      this.#syncingTextFromComposer = false;
    }
  }

  #sendUpdatesThrottled() {
    // Use throttle instead of debounce so updates sync periodically during
    // continuous typing, not just when typing stops. With immediate=true,
    // the first call executes immediately, then at most once per THROTTLE_SAVE ms.
    throttle(this, this.#sendUpdates, THROTTLE_SAVE, false);
  }

  async #flushPendingUpdates() {
    if (this.inFlightRequest) {
      await this.inFlightRequest;
    }

    if (this.isRichMode && this.doc && this.text) {
      // Cancel any pending debounced sync by running it immediately
      // This is critical to ensure Y.Text has the latest content before commit
      const didSync = this.#syncYTextFromXmlFragment();

      // If we synced, the transaction will have created a pending update
      // Give it a moment to be processed
      if (didSync && this.pendingUpdates.length === 0) {
        // Force capture any updates that the sync generated
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const hasUpdates =
      this.pendingUpdates.length > 0 ||
      (this.isRichMode && this.pendingAwarenessUpdate);

    if (hasUpdates) {
      await this.#sendUpdates(true);
    }

    if (this.inFlightRequest) {
      await this.inFlightRequest;
    }
  }

  async #sendUpdates(immediate = false) {
    const postId = this.currentPostId || this.#postId;

    if (this.isRichMode && this.doc) {
      this.#syncTextFromComposer();
    }

    const updatesToSend = [...this.pendingUpdates];
    const awarenessToSend = this.pendingAwarenessUpdate;

    // Check if we have anything to send
    const hasDocUpdates = updatesToSend.length > 0;
    const hasAwarenessUpdate = this.isRichMode && awarenessToSend;

    if (!this.doc || (!hasDocUpdates && !hasAwarenessUpdate) || !postId) {
      return;
    }

    if (this.ajaxInProgress) {
      if (!immediate) {
        this.#sendUpdatesThrottled();
        return;
      }

      if (this.inFlightRequest) {
        await this.inFlightRequest;
      }
    }

    const data = {
      client_id: this.messageBus.clientId,
    };

    // Add doc update if present
    if (hasDocUpdates) {
      const payload =
        updatesToSend.length === 1
          ? updatesToSend[0]
          : window.Y.mergeUpdates(updatesToSend);
      data.update = uint8ArrayToBase64(payload);
    }

    // Rich mode: include awareness update
    if (hasAwarenessUpdate) {
      data.awareness = uint8ArrayToBase64(awarenessToSend);
    }

    // Markdown mode: include cursor payload
    if (!this.isRichMode) {
      const cursorPayload = this.#buildCursorPayload();
      if (cursorPayload) {
        data.cursor = cursorPayload;
      }
    }

    this.pendingUpdates = [];
    this.pendingAwarenessUpdate = null;
    this.ajaxInProgress = true;

    try {
      this.inFlightRequest = ajax(`/shared_edits/p/${postId}`, {
        method: "PUT",
        data,
      });

      await this.inFlightRequest;
    } catch (e) {
      if (
        e.jqXHR?.status === 409 &&
        e.jqXHR?.responseJSON?.error === "state_recovered"
      ) {
        await this.#handleResync();
        return;
      }

      if (updatesToSend.length) {
        this.pendingUpdates = updatesToSend.concat(this.pendingUpdates);
      }

      if (awarenessToSend && !this.pendingAwarenessUpdate) {
        this.pendingAwarenessUpdate = awarenessToSend;
      }
      throw e;
    } finally {
      this.inFlightRequest = null;
      this.ajaxInProgress = false;
    }
  }
}
