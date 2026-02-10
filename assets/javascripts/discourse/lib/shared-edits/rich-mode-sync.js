/**
 * Handles ProseMirror integration for rich mode:
 * - Yjs state setup for ProseMirror
 * - Awareness updates
 * - XML fragment to text synchronization
 * - Error handling and fallback
 */
import { getOwner, setOwner } from "@ember/owner";
import { cancel, debounce } from "@ember/runloop";
import { service } from "@ember/service";
import { i18n } from "discourse-i18n";
import {
  clearSharedEditYjsState,
  setSharedEditYjsState,
} from "../shared-edits-prosemirror-extension";
import { debugError, debugWarn } from "./debug";
import { applyDiff } from "./encoding-utils";
import { getMarkdownFromView } from "./yjs-document";

export default class RichModeSync {
  @service dialog;

  #syncDebounceId = null;
  #xmlFragmentObserver = null;
  #awarenessUpdateHandler = null;
  #onSyncAnomaly = null;

  // Callbacks
  #onError = null;
  #onXmlFragmentChange = null;
  // Error handling
  #handleRichModeFailure = (error) => {
    if (this._richModeFailed || this._handlingRichModeFailure) {
      return;
    }

    this._richModeFailed = true;
    this._handlingRichModeFailure = true;

    debugError("Rich mode collaboration failed:", error);
    this.dialog.alert(i18n("shared_edits.errors.rich_mode_failed"));

    this.#onError?.(error);

    this._handlingRichModeFailure = false;
  };
  _richModeFailed = false;
  _handlingRichModeFailure = false;

  constructor(context, { onError, onSyncAnomaly } = {}) {
    setOwner(this, getOwner(context));
    this.#onError = onError;
    this.#onSyncAnomaly = onSyncAnomaly;
  }

  // Setup

  setupYjsState(xmlFragment, awareness, seedXmlFromView) {
    setSharedEditYjsState({
      xmlFragment,
      awareness,
      seedXmlFromView,
      onError: this.#handleRichModeFailure,
    });
  }

  setupXmlFragmentObserver(xmlFragment, onXmlFragmentChange) {
    this.#onXmlFragmentChange = onXmlFragmentChange;
    this.#xmlFragmentObserver = () => {
      this.#syncDebounceId = debounce(this, this.#triggerXmlFragmentSync, 500);
    };
    xmlFragment.observeDeep(this.#xmlFragmentObserver);
  }

  #triggerXmlFragmentSync() {
    this.#onXmlFragmentChange?.();
  }

  flushXmlSync() {
    if (this.#syncDebounceId) {
      cancel(this.#syncDebounceId);
      this.#syncDebounceId = null;
      this.#triggerXmlFragmentSync();
    }
  }

  setupAwarenessHandler(awareness, onAwarenessUpdate) {
    this.#awarenessUpdateHandler = onAwarenessUpdate;
    awareness.on("update", this.#awarenessUpdateHandler);
  }

  // Sync Y.Text from xmlFragment

  syncYTextFromXmlFragment(
    xmlFragment,
    text,
    doc,
    { consumeMarkdown = false } = {}
  ) {
    if (!xmlFragment || xmlFragment.length === 0 || !text || !doc) {
      return false;
    }

    let newText = getMarkdownFromView({ consumeCapture: consumeMarkdown });
    if (newText === null) {
      // ProseMirror serialization unavailable - this is a degraded state
      // Log a warning and attempt the lossy fallback only as last resort
      debugWarn(
        "ProseMirror markdown serialization unavailable,",
        "falling back to lossy XML text extraction"
      );
      newText = this.#extractTextFromXmlFragment(xmlFragment);
    }

    if (typeof newText !== "string") {
      debugError(
        "Rich mode sync failed: newText is not a string",
        typeof newText
      );
      this.#onSyncAnomaly?.({
        reason: "invalid_newtext_type",
        type: typeof newText,
      });
      return false;
    }

    const currentText = text.toString();

    const newTextTrimmed = newText?.trim() || "";
    const currentTrimmed = currentText?.trim() || "";
    const fragmentHasContent =
      xmlFragment?.length > 0 &&
      this.#extractTextFromXmlFragment(xmlFragment).trim().length > 0;

    if (
      fragmentHasContent &&
      currentTrimmed.length > 0 &&
      newTextTrimmed.length === 0
    ) {
      debugError(
        "Rich mode sync produced blank markdown despite populated document. Skipping update."
      );
      this.#onSyncAnomaly?.({
        reason: "empty_serialization",
        currentLength: currentText.length,
      });
      return false;
    }

    // Preserve trailing newline from Y.Text if present
    // ProseMirror/markdown serializers often strip trailing newlines,
    // but we want to preserve them for consistency with the source document
    const currentEndsWithNewline = currentText.endsWith("\n");
    const newEndsWithNewline = newText.endsWith("\n");
    if (currentEndsWithNewline && !newEndsWithNewline) {
      newText = newText + "\n";
    }

    if (newText === currentText) {
      return false;
    }

    doc.transact(() => {
      applyDiff(text, currentText, newText);
    }, "xmlSync");

    return true;
  }

  #extractTextFromXmlFragment(fragment) {
    let text = "";

    const processNode = (node) => {
      if (typeof node === "string") {
        text += node;
      } else if (node.toString && !node.nodeName) {
        const str = node.toString();
        if (str) {
          text += str;
        }
      } else if (node.forEach) {
        node.forEach(processNode);
      }
    };

    fragment.forEach((child) => {
      processNode(child);
      text += "\n";
    });

    // Keep one trailing newline to match markdown format, strip extras
    return text.replace(/\n{2,}$/, "\n");
  }

  // Awareness update encoding

  encodeAwarenessUpdate(awareness, clientIds) {
    const SharedEditsYjs = window.SharedEditsYjs;
    if (!SharedEditsYjs?.encodeAwarenessUpdate) {
      return null;
    }
    if (clientIds.length > 0) {
      return SharedEditsYjs.encodeAwarenessUpdate(awareness, clientIds);
    }
    return null;
  }

  applyAwarenessUpdate(awareness, awarenessBinary) {
    const SharedEditsYjs = window.SharedEditsYjs;
    if (!SharedEditsYjs?.applyAwarenessUpdate) {
      return;
    }
    SharedEditsYjs.applyAwarenessUpdate(awareness, awarenessBinary, "sync");
  }

  get richModeFailed() {
    return this._richModeFailed;
  }

  // Cleanup

  teardown(xmlFragment, awareness) {
    clearSharedEditYjsState();

    if (this.#syncDebounceId) {
      cancel(this.#syncDebounceId);
      this.#syncDebounceId = null;
    }

    if (xmlFragment && this.#xmlFragmentObserver) {
      xmlFragment.unobserveDeep(this.#xmlFragmentObserver);
      this.#xmlFragmentObserver = null;
    }

    if (awareness && this.#awarenessUpdateHandler) {
      awareness.off("update", this.#awarenessUpdateHandler);
      this.#awarenessUpdateHandler = null;
    }

    this.#onXmlFragmentChange = null;
    this._handlingRichModeFailure = false;
    this._richModeFailed = false;
  }
}
