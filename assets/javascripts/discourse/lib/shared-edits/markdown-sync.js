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

  // Callback for when selection ends with skipped updates
  onSelectionEnd = null;
  #isSelecting = false;
  #selectionListenersAttached = false;
  #skippedUpdatesDuringSelection = false;
  #pendingRelativeSelection = null;
  #spellcheckTimeoutId = null;
  #spellcheckRestoreValue = null;
  #spellcheckTextarea = null;

  // Callbacks
  #syncOrigin = null;
  #undoManager = null;

  #onTextareaMouseDown = () => {
    this.#isSelecting = true;
    this.#skippedUpdatesDuringSelection = false;
  };

  #onTextareaKeydown = (event) => {
    if (!this.#undoManager) {
      return;
    }

    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (isCtrl && !isShift && event.key.toLowerCase() === "z") {
      event.preventDefault();
      this.#undoManager.undo();
    }

    if (
      (isCtrl && isShift && event.key.toLowerCase() === "z") ||
      (isCtrl && !isShift && event.key.toLowerCase() === "y")
    ) {
      event.preventDefault();
      this.#undoManager.redo();
    }
  };

  #onTextareaMouseUp = () => {
    const hadSkippedUpdates = this.#skippedUpdatesDuringSelection;

    if (hadSkippedUpdates && this.#syncOrigin) {
      requestAnimationFrame(() => {
        const textareaSelection = this.getTextareaSelection();
        this.#isSelecting = false;
        this.#skippedUpdatesDuringSelection = false;
        this.onSelectionEnd?.(textareaSelection);
      });
    } else {
      this.#isSelecting = false;
      this.#skippedUpdatesDuringSelection = false;
    }
  };

  constructor(context) {
    setOwner(this, getOwner(context));
    // The context (service) is used as the origin for doc.transact()
    // so we can skip our own edits in handleTextChange
    this.#syncOrigin = context;
  }

  // Lifecycle

  attach(doc, text, undoManager) {
    this.#undoManager = undoManager;
    this.#attachSelectionListeners();

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (textarea && !this.cursorOverlay) {
      this.cursorOverlay = new CursorOverlay(textarea);
    }
  }

  detach() {
    this.#resetSpellcheckSuppression();
    this.#detachSelectionListeners();

    if (this.cursorOverlay) {
      this.cursorOverlay.destroy();
      this.cursorOverlay = null;
    }

    this.#undoManager = null;
  }

  // Selection management

  getTextareaSelection() {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) {
      return null;
    }
    return { start: textarea.selectionStart, end: textarea.selectionEnd };
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
      scrollTop: rel.scrollTop,
    };
  }

  // Remote text change handling

  handleTextChange(event, transaction, text, doc, suppressComposerChangeFn) {
    // Handle remote cursor updates
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

    this.cursorOverlay?.refresh();

    // Skip if this is our own edit
    if (transaction?.origin === this.#syncOrigin) {
      return;
    }

    // Skip if user is selecting - will sync after selection ends
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

    if (!adjustedSelection) {
      adjustedSelection = transformSelection(selection, event.delta || []);
    }

    const textValue = text.toString();
    suppressComposerChangeFn?.(() => {
      this.composer.model?.set("reply", textValue);
    });

    if (textarea) {
      const currentValue = textarea.value;
      if (currentValue === textValue) {
        return;
      }

      let appliedSurgically = false;

      if (event.delta) {
        let expectedOldLength = textValue.length;
        let insertLen = 0;
        let deleteLen = 0;

        for (const op of event.delta) {
          if (op.insert) {
            insertLen += typeof op.insert === "string" ? op.insert.length : 0;
          } else if (op.delete) {
            deleteLen += op.delete;
          }
        }
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
        this.#applyDiffToTextarea(textarea, currentValue, textValue);
      }

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
      adjustedSelection = this.#transformSelectionThroughDiff(
        oldText,
        newText,
        oldSelection
      );
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

  // Getters

  get isSelecting() {
    return this.#isSelecting;
  }

  setPendingRelativeSelection(selection) {
    this.#pendingRelativeSelection = selection;
  }
}
