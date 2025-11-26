import { debounce } from "@ember/runloop";
import Service, { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import loadScript from "discourse/lib/load-script";

const THROTTLE_SAVE = 350;
const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";

let yjsPromise;

async function ensureYjsLoaded() {
  if (!yjsPromise) {
    yjsPromise = loadScript(
      "/plugins/discourse-shared-edits/javascripts/yjs-dist.js"
    ).then(() => window.Y);
  }

  return yjsPromise;
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

/**
 * Coordinates collaborative post editing with Yjs and the Discourse message bus.
 * @class SharedEditManager
 */
export default class SharedEditManager extends Service {
  @service composer;
  @service messageBus;

  ajaxInProgress = false;
  doc = null;
  text = null;
  currentPostId = null;
  pendingUpdates = [];
  suppressComposerChange = false;
  textObserver = null;
  inFlightRequest = null;
  #pendingRelativeSelection = null;
  #isSelecting = false;
  #selectionListenersAttached = false;
  #skippedUpdatesDuringSelection = false;

  /**
   * Apply updates received from the message bus.
   * @param {{client_id: string, update: string, action?: string, version?: number}} message
   * @returns {void}
   */
  #onRemoteMessage = (message) => {
    // Handle resync command from server (e.g., after recovery)
    if (message.action === "resync") {
      this.#handleResync();
      return;
    }

    if (!this.doc || message.client_id === this.messageBus.clientId) {
      return;
    }

    // Only capture relative selection if not actively selecting.
    // During selection, we use #selectionStartRelative captured on mousedown.
    if (!this.#isSelecting) {
      this.#pendingRelativeSelection = this.#captureRelativeSelection();
    }

    const update = base64ToUint8Array(message.update);
    window.Y.applyUpdate(this.doc, update, "remote");
  };

  /**
   * Queue outbound updates generated locally so they can be batched to the server.
   * @param {Uint8Array} update
   * @param {unknown} origin
   * @returns {void}
   */
  #handleDocUpdate = (update, origin) => {
    if (origin !== this) {
      return;
    }

    this.pendingUpdates.push(update);
    this.#sendUpdatesThrottled();
  };

  /**
   * Handle mousedown on textarea - user may be starting a selection drag.
   * @returns {void}
   */
  #onTextareaMouseDown = () => {
    this.#isSelecting = true;
    this.#skippedUpdatesDuringSelection = false;
  };

  /**
   * Handle mouseup - user finished selecting. Sync textarea if updates were skipped.
   * @returns {void}
   */
  #onTextareaMouseUp = () => {
    const wasSelecting = this.#isSelecting;
    const hadSkippedUpdates = this.#skippedUpdatesDuringSelection;
    const textareaSelection = this.#getTextareaSelection();

    this.#isSelecting = false;
    this.#skippedUpdatesDuringSelection = false;

    // If we skipped updates while selecting, sync the textarea now
    if (wasSelecting && hadSkippedUpdates) {
      this.#syncTextareaAfterSelection(textareaSelection);
    }
  };

  /**
   * Get current textarea selection.
   * @returns {{start: number, end: number}|null}
   */
  #getTextareaSelection() {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) {
      return null;
    }
    return { start: textarea.selectionStart, end: textarea.selectionEnd };
  }

  /**
   * Sync textarea content after selection is complete, preserving selection position.
   * @param {{start: number, end: number}|null} oldSelection - Selection in old content coordinates
   * @returns {void}
   */
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

    textarea.value = newText;

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

  /**
   * Transform selection coordinates from old text to new text based on diff.
   * @param {string} oldText
   * @param {string} newText
   * @param {{start: number, end: number}} selection
   * @returns {{start: number, end: number}}
   */
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

  /**
   * Handle a resync command by reloading the document state from the server.
   * @returns {Promise<void>}
   */
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
      this.#setupDoc(data.state, data.raw);
    } catch (e) {
      popupAjaxError(e);
    }
  }

  /**
   * Start syncing the current composer with the shared Yjs document for the post.
   * @returns {Promise<void>}
   */
  async subscribe() {
    try {
      const postId = this.#postId;

      if (!postId) {
        return;
      }

      const data = await ajax(`/shared_edits/p/${postId}`);

      if (!this.composer.model || this.isDestroying || this.isDestroyed) {
        return;
      }

      this.currentPostId = postId;
      this.#setupDoc(data.state, data.raw);

      this.addObserver("composer.model.reply", this, this.#onComposerChange);
      this.messageBus.subscribe(
        `/shared_edits/${postId}`,
        this.#onRemoteMessage
      );
    } catch (e) {
      popupAjaxError(e);
    }
  }

  /**
   * Finalize the shared edit session and persist the composed content back to the post.
   * @returns {Promise<void>}
   */
  async commit() {
    const postId = this.currentPostId || this.#postId;

    if (!postId) {
      return;
    }

    try {
      await this.#flushPendingUpdates();

      this.removeObserver("composer.model.reply", this, this.#onComposerChange);
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

  /**
   * Prepare a Yjs document for the session using the latest server state.
   * @param {string} state base64 encoded Yjs update representing current state
   * @param {string} raw fallback raw post text for empty states
   * @returns {void}
   */
  async #setupDoc(state, raw) {
    this.#teardownDoc();

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

    this.#attachSelectionListeners();

    this.suppressComposerChange = true;
    this.composer.model.set("reply", this.text.toString());
    this.suppressComposerChange = false;
  }

  /**
   * Remove observers and clear the current Yjs document.
   * @returns {void}
   */
  #teardownDoc() {
    if (this.text && this.textObserver) {
      this.text.unobserve(this.textObserver);
    }

    if (this.doc) {
      this.doc.off("update", this.#handleDocUpdate);
    }

    this.#detachSelectionListeners();

    this.doc = null;
    this.text = null;
    this.textObserver = null;
  }

  /**
   * Attach listeners to track active selection state on the textarea.
   * @returns {void}
   */
  #attachSelectionListeners() {
    if (this.#selectionListenersAttached) {
      return;
    }

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) {
      return;
    }

    textarea.addEventListener("mousedown", this.#onTextareaMouseDown);
    // Use document for mouseup to catch releases outside the textarea
    document.addEventListener("mouseup", this.#onTextareaMouseUp);
    this.#selectionListenersAttached = true;
  }

  /**
   * Remove selection tracking listeners.
   * @returns {void}
   */
  #detachSelectionListeners() {
    if (!this.#selectionListenersAttached) {
      return;
    }

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (textarea) {
      textarea.removeEventListener("mousedown", this.#onTextareaMouseDown);
    }
    document.removeEventListener("mouseup", this.#onTextareaMouseUp);
    this.#selectionListenersAttached = false;
    this.#isSelecting = false;
  }

  /**
   * @returns {number|undefined} id of the post currently being edited
   */
  get #postId() {
    return this.composer.model?.post.id;
  }

  /**
   * Reflect composer text changes into the shared Yjs document.
   * @returns {void}
   */
  #onComposerChange() {
    if (!this.composer.model || !this.text || this.suppressComposerChange) {
      return;
    }

    const current = this.text.toString();
    const next = this.composer.model.reply || "";

    if (current === next) {
      return;
    }

    this.doc.transact(() => applyDiff(this.text, current, next), this);
  }

  /**
   * Update composer text and selection when the shared document changes.
   * @param {import("yjs").YTextEvent} event
   * @param {import("yjs").Transaction} transaction
   * @returns {void}
   */
  #handleTextChange(event, transaction) {
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
      textarea.value = text;

      if (adjustedSelection) {
        textarea.selectionStart = adjustedSelection.start;
        textarea.selectionEnd = adjustedSelection.end;
      }

      if (scrollTop !== undefined) {
        window.requestAnimationFrame(() => {
          textarea.scrollTop = scrollTop;
        });
      }
    }
  }

  /**
   * Capture the current selection as Yjs relative positions so it survives remote updates.
   * @returns {{ start: import("yjs").RelativePosition, end: import("yjs").RelativePosition, scrollTop?: number }|null}
   */
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

  /**
   * Convert previously captured relative selection back to absolute indexes.
   * @param {{ start: import("yjs").RelativePosition, end: import("yjs").RelativePosition, scrollTop?: number }|null} rel
   * @returns {{ start: number, end: number, scrollTop?: number }|null}
   */
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

  /**
   * Debounced enqueue of outbound updates to reduce request volume.
   * @returns {void}
   */
  #sendUpdatesThrottled() {
    debounce(this, this.#sendUpdates, THROTTLE_SAVE);
  }

  /**
   * Immediately send any queued updates before shutting down the session.
   * @returns {Promise<void>}
   */
  async #flushPendingUpdates() {
    if (this.inFlightRequest) {
      await this.inFlightRequest;
    }

    if (this.pendingUpdates.length) {
      await this.#sendUpdates(true);
    }

    if (this.inFlightRequest) {
      await this.inFlightRequest;
    }
  }

  /**
   * Send merged Yjs updates to the server.
   * @param {boolean} immediate
   * @returns {Promise<void>}
   */
  async #sendUpdates(immediate = false) {
    const postId = this.currentPostId || this.#postId;

    if (!this.doc || this.pendingUpdates.length === 0 || !postId) {
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

    const payload =
      this.pendingUpdates.length === 1
        ? this.pendingUpdates[0]
        : window.Y.mergeUpdates(this.pendingUpdates);

    this.pendingUpdates = [];
    this.ajaxInProgress = true;

    try {
      this.inFlightRequest = ajax(`/shared_edits/p/${postId}`, {
        method: "PUT",
        data: {
          update: uint8ArrayToBase64(payload),
          client_id: this.messageBus.clientId,
        },
      });

      await this.inFlightRequest;
    } catch (e) {
      // Handle state recovery response (409 Conflict)
      if (
        e.jqXHR?.status === 409 &&
        e.jqXHR?.responseJSON?.error === "state_recovered"
      ) {
        await this.#handleResync();
        return;
      }
      throw e;
    } finally {
      this.inFlightRequest = null;
      this.ajaxInProgress = false;
    }
  }
}
