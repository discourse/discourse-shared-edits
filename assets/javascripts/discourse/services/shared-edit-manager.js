import { throttle } from "@ember/runloop";
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

  #onRemoteMessage = (message) => {
    if (message.action === "resync") {
      this.#handleResync();
      return;
    }

    if (!this.doc || message.client_id === this.messageBus.clientId) {
      return;
    }

    if (!this.#isSelecting) {
      this.#pendingRelativeSelection = this.#captureRelativeSelection();
    }

    const update = base64ToUint8Array(message.update);
    window.Y.applyUpdate(this.doc, update, "remote");
  };

  #handleDocUpdate = (update, origin) => {
    if (origin !== this) {
      return;
    }

    this.pendingUpdates.push(update);
    this.#sendUpdatesThrottled();
  };

  #onTextareaMouseDown = () => {
    this.#isSelecting = true;
    this.#skippedUpdatesDuringSelection = false;
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

    this.#attachSelectionListeners();

    this.suppressComposerChange = true;
    this.composer.model.set("reply", this.text.toString());
    this.suppressComposerChange = false;
  }

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

  #sendUpdatesThrottled() {
    // Use throttle instead of debounce so updates sync periodically during
    // continuous typing, not just when typing stops. With immediate=true,
    // the first call executes immediately, then at most once per THROTTLE_SAVE ms.
    throttle(this, this.#sendUpdates, THROTTLE_SAVE, true);
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
