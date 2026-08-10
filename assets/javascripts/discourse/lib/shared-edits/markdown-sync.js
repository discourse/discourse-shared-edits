/**
 * Handles textarea synchronization for markdown mode:
 * - Selection preservation across remote edits
 * - Cursor overlay for remote users
 * - Spellcheck suppression during updates
 * - Undo/redo keyboard handling
 */
import { getOwner, setOwner } from "@ember/owner";
import { service } from "@ember/service";
import CursorOverlay from "../cursor-overlay";
import {
  decodeRelativePositionFromBase64url,
  encodeRelativePositionToBase64url,
  transformSelection,
} from "./encoding-utils";

const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";
const SPELLCHECK_SUSPEND_DURATION_MS = 1000;

export default class MarkdownSync {
  @service composer;

  cursorOverlay = null;

  // Callbacks for selection synchronization and cursor presence
  onSelectionEnd = null;
  onSelectionChange = null;
  #isSelecting = false;
  #detached = false;
  #selectionListenersAttached = false;
  #skippedUpdatesDuringSelection = false;
  #skippedSelectionDeltas = [];
  #pendingRelativeSelection = null;
  #text = null;
  #spellcheckTimeoutId = null;
  #spellcheckRestoreValue = null;
  #spellcheckTextarea = null;

  // Callbacks
  #syncOrigin = null;
  #undoManager = null;

  #onTextareaMouseDown = () => {
    this.#isSelecting = true;
    this.#skippedUpdatesDuringSelection = false;
    this.#skippedSelectionDeltas = [];
  };

  #onTextareaKeydown = (event) => {
    if (!this.#undoManager) {
      return;
    }

    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (isCtrl && !isShift && event.key.toLowerCase() === "z") {
      event.preventDefault();
      this.#pendingRelativeSelection = this.captureRelativeSelection(
        this.#text
      );
      this.#undoManager.undo();
    }

    if (
      (isCtrl && isShift && event.key.toLowerCase() === "z") ||
      (isCtrl && !isShift && event.key.toLowerCase() === "y")
    ) {
      event.preventDefault();
      this.#pendingRelativeSelection = this.captureRelativeSelection(
        this.#text
      );
      this.#undoManager.redo();
    }
  };

  #onTextareaSelectionChange = () => {
    this.#pendingRelativeSelection = null;
    this.onSelectionChange?.();
  };

  #onTextareaMouseUp = () => {
    const hadSkippedUpdates = this.#skippedUpdatesDuringSelection;

    if (hadSkippedUpdates && this.#syncOrigin) {
      requestAnimationFrame(() => {
        if (this.#detached) {
          return;
        }
        const textareaSelection = this.getTextareaSelection();
        this.#isSelecting = false;
        this.#skippedUpdatesDuringSelection = false;
        this.onSelectionEnd?.(textareaSelection);
        this.#onTextareaSelectionChange();
      });
      return;
    }

    this.#isSelecting = false;
    this.#skippedUpdatesDuringSelection = false;
    this.#onTextareaSelectionChange();
  };

  constructor(context) {
    setOwner(this, getOwner(context));
    // The context (service) is used as the origin for doc.transact()
    // so we can skip our own edits in handleTextChange
    this.#syncOrigin = context;
  }

  // Lifecycle

  attach(doc, text, undoManager) {
    this.#detached = false;
    this.#text = text;
    this.#undoManager = undoManager;
    this.#attachSelectionListeners();

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (textarea && !this.cursorOverlay) {
      this.cursorOverlay = new CursorOverlay(textarea);
    }
  }

  detach() {
    this.#detached = true;
    this.onSelectionEnd = null;
    this.onSelectionChange = null;
    this.#resetSpellcheckSuppression();
    this.#detachSelectionListeners();

    if (this.cursorOverlay) {
      this.cursorOverlay.destroy();
      this.cursorOverlay = null;
    }

    this.#undoManager = null;
    this.#text = null;
    this.#pendingRelativeSelection = null;
    this.#skippedSelectionDeltas = [];
  }

  // Selection management

  getTextareaSelection() {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) {
      return null;
    }
    return {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      direction: textarea.selectionDirection,
    };
  }

  captureRelativeSelection(text) {
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
        text,
        textarea.selectionStart,
        0
      ),
      end: Y.createRelativePositionFromTypeIndex(
        text,
        textarea.selectionEnd,
        0
      ),
      direction: textarea.selectionDirection,
      scrollTop: textarea.scrollTop,
    };
  }

  absoluteSelectionFromRelative(rel, doc, text) {
    if (!rel) {
      return null;
    }

    const Y = window.Y;

    const startAbs = Y.createAbsolutePositionFromRelativePosition(
      rel.start,
      doc
    );
    const endAbs = Y.createAbsolutePositionFromRelativePosition(rel.end, doc);

    if (
      !startAbs ||
      !endAbs ||
      startAbs.type !== text ||
      endAbs.type !== text
    ) {
      return null;
    }

    return {
      start: startAbs.index,
      end: endAbs.index,
      direction: rel.direction,
      scrollTop: rel.scrollTop,
    };
  }

  handleRemoteCursor(cursor, origin, doc, text, delta = []) {
    if (!this.cursorOverlay || !origin || !doc) {
      return;
    }

    let relativePosition =
      cursor?.direction === "backward"
        ? cursor.start
        : cursor?.end || cursor?.start;

    if (!relativePosition && text) {
      let index = 0;
      delta.forEach((operation) => {
        if (operation.retain) {
          index += operation.retain;
        }
        if (operation.insert) {
          index +=
            typeof operation.insert === "string" ? operation.insert.length : 1;
        }
      });
      relativePosition = window.Y.createRelativePositionFromTypeIndex(
        text,
        index,
        -1
      );
    }

    if (relativePosition) {
      this.cursorOverlay.updateCursor(
        origin.client_id,
        origin,
        relativePosition,
        doc
      );
    }
  }

  // Remote text change handling

  handleTextChange(event, transaction, text, doc, suppressComposerChangeFn) {
    // Handle remote cursor updates
    if (transaction.origin?.type === "remote") {
      this.handleRemoteCursor(
        transaction.origin.cursor,
        transaction.origin,
        doc,
        text,
        event.delta || []
      );
    }

    this.cursorOverlay?.refresh();

    // Skip if this is our own edit
    if (transaction?.origin === this.#syncOrigin) {
      return;
    }

    // Skip if user is selecting - will sync after selection ends
    if (this.#isSelecting) {
      this.#skippedUpdatesDuringSelection = true;
      if (event.delta?.length) {
        this.#skippedSelectionDeltas.push(event.delta);
      }
      return;
    }

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    const selection =
      textarea && typeof textarea.selectionStart === "number"
        ? {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
            direction: textarea.selectionDirection,
          }
        : null;

    let adjustedSelection = null;
    let scrollTop = textarea?.scrollTop;

    if (this.#pendingRelativeSelection) {
      adjustedSelection = this.absoluteSelectionFromRelative(
        this.#pendingRelativeSelection,
        doc,
        text
      );
      if (scrollTop === undefined || scrollTop === null) {
        scrollTop = this.#pendingRelativeSelection?.scrollTop;
      }
      this.#pendingRelativeSelection = null;
    }

    const textValue = text.toString();
    const currentValue = textarea?.value;

    if (!adjustedSelection && selection && currentValue !== undefined) {
      adjustedSelection = this.#transformSelectionThroughDiff(
        currentValue,
        textValue,
        selection
      );
    }

    suppressComposerChangeFn?.(() => {
      this.composer.model?.set("reply", textValue);
    });

    if (!textarea || currentValue === textValue) {
      return;
    }

    this.#applyDiffToTextarea(textarea, currentValue, textValue);

    this.cursorOverlay?.refresh();

    if (adjustedSelection) {
      textarea.setSelectionRange(
        adjustedSelection.start,
        adjustedSelection.end,
        adjustedSelection.direction || "none"
      );
    }

    if (scrollTop !== undefined && textarea.scrollTop !== scrollTop) {
      window.requestAnimationFrame(() => {
        textarea.scrollTop = scrollTop;
      });
    }
  }

  #applyDiffToTextarea(textarea, oldText, newText) {
    let prefixLen = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
      prefixLen++;
    }

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

  syncTextareaAfterSelection(text, suppressComposerChangeFn) {
    const oldSelection = this.getTextareaSelection();
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea || !text) {
      return;
    }

    const oldText = textarea.value;
    const newText = text.toString();
    const scrollTop = textarea.scrollTop;

    let adjustedSelection = null;

    if (oldSelection && oldText !== newText) {
      adjustedSelection = this.#skippedSelectionDeltas.reduce(
        (selection, delta) => transformSelection(selection, delta),
        oldSelection
      );
      if (this.#skippedSelectionDeltas.length === 0) {
        adjustedSelection = this.#transformSelectionThroughDiff(
          oldText,
          newText,
          oldSelection
        );
      }
    } else if (oldSelection) {
      adjustedSelection = oldSelection;
    }

    suppressComposerChangeFn?.(() => {
      this.composer.model?.set("reply", newText);
    });

    if (oldText !== newText) {
      this.#applyDiffToTextarea(textarea, oldText, newText);
    }

    if (adjustedSelection) {
      const maxPos = newText.length;
      textarea.setSelectionRange(
        Math.min(Math.max(0, adjustedSelection.start), maxPos),
        Math.min(Math.max(0, adjustedSelection.end), maxPos),
        adjustedSelection.direction || "none"
      );
    }

    if (scrollTop !== undefined) {
      window.requestAnimationFrame(() => {
        textarea.scrollTop = scrollTop;
      });
    }
    this.#skippedSelectionDeltas = [];
  }

  #transformSelectionThroughDiff(oldText, newText, selection) {
    let prefixLen = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
      prefixLen++;
    }

    let suffixLen = 0;
    while (
      suffixLen < oldText.length - prefixLen &&
      suffixLen < newText.length - prefixLen &&
      oldText[oldText.length - 1 - suffixLen] ===
        newText[newText.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const oldChangeEnd = oldText.length - suffixLen;
    const newChangeEnd = newText.length - suffixLen;

    const transformPos = (pos) => {
      if (pos <= prefixLen) {
        return pos;
      } else if (pos >= oldChangeEnd) {
        return pos + (newChangeEnd - oldChangeEnd);
      } else {
        return newChangeEnd;
      }
    };

    return {
      start: transformPos(selection.start),
      end: transformPos(selection.end),
      direction: selection.direction,
    };
  }

  // Cursor payload for network

  buildCursorPayload(text) {
    if (!text) {
      return null;
    }

    const selection = this.captureRelativeSelection(text);
    if (!selection) {
      return null;
    }

    const cursor = {};
    const start = encodeRelativePositionToBase64url(selection.start);
    if (start) {
      cursor.start = start;
    }

    const end = encodeRelativePositionToBase64url(selection.end);
    if (end) {
      cursor.end = end;
    }

    if (selection.direction && selection.direction !== "none") {
      cursor.direction = selection.direction;
    }

    return Object.keys(cursor).length ? cursor : null;
  }

  deserializeCursorPayload(cursorPayload) {
    if (!cursorPayload) {
      return null;
    }

    const cursor = {};

    if (cursorPayload.start) {
      const start = decodeRelativePositionFromBase64url(cursorPayload.start);
      if (start) {
        cursor.start = start;
      }
    }

    if (cursorPayload.end) {
      const end = decodeRelativePositionFromBase64url(cursorPayload.end);
      if (end) {
        cursor.end = end;
      }
    }

    if (cursorPayload.direction) {
      cursor.direction = cursorPayload.direction;
    }

    return Object.keys(cursor).length ? cursor : null;
  }

  // Spellcheck suppression during remote updates

  temporarilyDisableSpellcheck() {
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

  // Selection event listeners

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
    textarea.addEventListener("keyup", this.#onTextareaSelectionChange);
    textarea.addEventListener("select", this.#onTextareaSelectionChange);
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
      textarea.removeEventListener("keyup", this.#onTextareaSelectionChange);
      textarea.removeEventListener("select", this.#onTextareaSelectionChange);
    }
    document.removeEventListener("mouseup", this.#onTextareaMouseUp);
    this.#selectionListenersAttached = false;
    this.#isSelecting = false;
  }

  // Getters

  get isSelecting() {
    return this.#isSelecting;
  }

  setPendingRelativeSelection(selection) {
    this.#pendingRelativeSelection = selection;
  }
}
