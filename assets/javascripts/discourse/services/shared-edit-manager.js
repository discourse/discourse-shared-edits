import { throttle } from "@ember/runloop";
import Service, { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import loadScript from "discourse/lib/load-script";
import CursorOverlay from "../lib/cursor-overlay";

const THROTTLE_SAVE = 350;
const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";
const SPELLCHECK_SUSPEND_DURATION_MS = 1000;

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
  /** @type {Promise<void>|null} - for eslint */
  inFlightRequest = null;
  #pendingRelativeSelection = null;
  #isSelecting = false;
  #selectionListenersAttached = false;
  #skippedUpdatesDuringSelection = false;
  #spellcheckTimeoutId = null;
  #spellcheckRestoreValue = null;
  #spellcheckTextarea = null;

  #onRemoteMessage = (message) => {
    if (message.action === "resync") {
      this.#handleResync();
      return;
    }

    if (!this.doc || message.client_id === this.messageBus.clientId) {
      return;
    }

    if (message.update) {
      this.#temporarilyDisableSpellcheck();
    }

    if (!this.#isSelecting) {
      this.#pendingRelativeSelection = this.#captureRelativeSelection();
    }

    const update = base64ToUint8Array(message.update);
    window.Y.applyUpdate(this.doc, update, {
      type: "remote",
      client_id: message.client_id,
      user_id: message.user_id,
      user_name: message.user_name,
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

  willDestroy() {
    this.#resetSpellcheckSuppression();
    super.willDestroy(...arguments);
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
      this.#setupDoc(data.state, data.raw);
    } catch (e) {
      popupAjaxError(e);
    }
  }

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

      // Subscribe starting from the message_bus_last_id returned with the state
      // to ensure we don't miss any messages that arrived between fetching
      // the state and subscribing
      this.messageBus.subscribe(
        `/shared_edits/${postId}`,
        this.#onRemoteMessage,
        data.message_bus_last_id ?? -1
      );
    } catch (e) {
      popupAjaxError(e);
    }
  }

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

    this.undoManager = new Y.UndoManager(this.text, {
      trackedOrigins: new Set([this]),
      captureTimeout: 500,
    });

    this.#attachSelectionListeners();

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (textarea) {
      this.cursorOverlay = new CursorOverlay(textarea);
    }

    this.suppressComposerChange = true;
    this.composer.model.set("reply", this.text.toString());
    this.suppressComposerChange = false;
  }

  #teardownDoc() {
    this.#resetSpellcheckSuppression();

    if (this.text && this.textObserver) {
      this.text.unobserve(this.textObserver);
    }

    if (this.doc) {
      this.doc.off("update", this.#handleDocUpdate);
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

    this.doc = null;
    this.text = null;
    this.textObserver = null;
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

  get #postId() {
    return this.composer.model?.post.id;
  }

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

  #handleTextChange(event, transaction) {
    // Update remote cursors based on text changes
    if (
      transaction.origin &&
      transaction.origin.type === "remote" &&
      this.cursorOverlay
    ) {
      const origin = transaction.origin;
      let index = 0;
      event.delta.forEach((op) => {
        if (op.retain) {
          index += op.retain;
        }
        if (op.insert) {
          const length = typeof op.insert === "string" ? op.insert.length : 1;
          index += length;
        }
      });

      // Create a relative position for the remote cursor so it sticks to this text
      const relativePosition = window.Y.createRelativePositionFromTypeIndex(
        this.text,
        index,
        -1
      );

      this.cursorOverlay.updateCursor(
        origin.client_id,
        origin,
        relativePosition,
        this.doc
      );
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

    if (this.pendingUpdates.length) {
      await this.#sendUpdates(true);
    }

    if (this.inFlightRequest) {
      await this.inFlightRequest;
    }
  }

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
