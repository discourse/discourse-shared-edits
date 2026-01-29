/**
 * SharedEditManager - Orchestrator service for collaborative editing.
 *
 * This service coordinates the helper modules for shared editing:
 * - YjsDocument: Y.Doc lifecycle management
 * - NetworkManager: API calls and MessageBus
 * - MarkdownSync: Textarea synchronization
 * - RichModeSync: ProseMirror integration
 *
 * Public API:
 * - subscribe(postId, opts): Start editing a post
 * - finalizeSubscription(): Complete setup after composer opens
 * - commit(): Flush updates and close editing session
 * - syncFromComposerValue(value): Sync composer changes to Yjs
 */
import Service, { service } from "@ember/service";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { debugError, debugLog } from "../lib/shared-edits/debug";
import {
  applyDiff,
  base64ToUint8Array,
} from "../lib/shared-edits/encoding-utils";
import MarkdownSync from "../lib/shared-edits/markdown-sync";
import NetworkManager from "../lib/shared-edits/network-manager";
import RichModeSync from "../lib/shared-edits/rich-mode-sync";
import YjsDocument, {
  capturePM,
  clearPM,
  clearRichModeSerializers,
  ensureYjsProsemirrorLoaded,
  getMarkdownFromView,
  getPM,
  setCapturedMarkdown,
  setConvertToMarkdown,
  setProsemirrorViewGetter,
  triggerYjsLoad,
} from "../lib/shared-edits/yjs-document";

// Re-export for external consumers (initializers, prosemirror extension)
export {
  capturePM,
  clearPM,
  clearRichModeSerializers,
  ensureYjsProsemirrorLoaded,
  getMarkdownFromView,
  getPM,
  setConvertToMarkdown,
  setCapturedMarkdown,
  setProsemirrorViewGetter,
  triggerYjsLoad,
};

const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";

export default class SharedEditManager extends Service {
  @service composer;
  @service messageBus;
  @service siteSettings;

  // State
  currentPostId = null;
  suppressComposerChange = false;
  pendingComposerReply = null;

  // Helper instances
  #yjsDocument = null;
  #networkManager = null;
  #markdownSync = null;
  #richModeSync = null;

  // Internal state
  #composerReady = false;
  #composerObserverAttached = false;
  #richModeFailed = false;
  #closing = false;
  #commitPromise = null;
  #resyncInProgress = false;

  // Event handlers
  #handleDocUpdate = (update, origin) => {
    // Skip remote updates (already applied, don't need to send back)
    if (origin === "remote" || origin === "resync") {
      return;
    }

    // In markdown mode, only queue updates from the service or undo manager
    // In rich mode, queue all local updates (from ProseMirror y-sync plugin
    // and xmlSync for Y.Text sync from xmlFragment)
    if (!this.isRichMode) {
      if (origin !== this && origin !== this.#yjsDocument?.undoManager) {
        return;
      }
    }

    this.#networkManager?.queueUpdate(update);
  };

  #handleTextChange = (event, transaction) => {
    if (this.isRichMode) {
      return;
    }

    if (!this.#markdownSync) {
      return;
    }

    // Disable spellcheck during remote updates
    if (transaction?.origin?.type === "remote") {
      this.#markdownSync.temporarilyDisableSpellcheck();
    }

    // For local changes, capture relative selection before applying changes
    // For remote changes, we use transformSelection with the delta instead
    const isRemote = transaction?.origin?.type === "remote";
    if (!isRemote && !this.#markdownSync.isSelecting) {
      this.#markdownSync.setPendingRelativeSelection(
        this.#markdownSync.captureRelativeSelection(this.#yjsDocument?.text)
      );
    }

    this.#markdownSync.handleTextChange(
      event,
      transaction,
      this.#yjsDocument?.text,
      this.#yjsDocument?.doc,
      (fn) => {
        this.suppressComposerChange = true;
        fn();
        this.suppressComposerChange = false;
      }
    );
  };

  #handleAwarenessUpdate = (changes, origin) => {
    // Wrap in try-catch to prevent errors during teardown from propagating
    // as global errors. During cleanup, the awareness may emit events with
    // malformed data which we should silently ignore.
    try {
      if (
        this.#closing ||
        origin === "sync" ||
        !this.#richModeSync ||
        !this.#yjsDocument?.awareness
      ) {
        return;
      }

      // Guard against null/undefined changes object
      if (!changes || typeof changes !== "object") {
        return;
      }

      const { added, updated, removed } = changes;
      const clientIds = [
        ...(added || []),
        ...(updated || []),
        ...(removed || []),
      ];
      if (clientIds.length > 0) {
        const update = this.#richModeSync.encodeAwarenessUpdate(
          this.#yjsDocument.awareness,
          clientIds
        );
        if (update) {
          this.#networkManager?.queueAwarenessUpdate(update);
        }
      }
    } catch {
      // Silently ignore errors during teardown/cleanup
    }
  };

  #handleRemoteMessage = (message) => {
    if (this.#closing || !this.#yjsDocument?.doc) {
      return;
    }

    // Handle awareness updates in rich mode
    if (this.isRichMode && message.awarenessBinary && this.#richModeSync) {
      this.#richModeSync.applyAwarenessUpdate(
        this.#yjsDocument.awareness,
        message.awarenessBinary
      );
    }

    // Apply document update
    if (message.updateBinary) {
      if (this.isRichMode) {
        this.#yjsDocument.applyRemoteUpdate(message.updateBinary);
      } else {
        // Parse cursor for markdown mode
        const cursor = this.#markdownSync?.deserializeCursorPayload(
          message.cursor
        );
        this.#yjsDocument.applyRemoteUpdateWithOrigin(message.updateBinary, {
          type: "remote",
          client_id: message.client_id,
          user_id: message.user_id,
          username: message.username,
          cursor,
        });
      }

      // Notify network manager that a remote update was applied
      // This allows it to re-verify state hash sync
      this.#networkManager?.notifyRemoteUpdateApplied();
    }
  };

  #handleSyncAnomaly = () => {
    if (this.#closing) {
      return;
    }
    this.#handleResync();
  };

  #handleResync = async () => {
    if (this.#closing) {
      return;
    }

    // Guard against concurrent/duplicate resyncs
    if (this.#resyncInProgress) {
      return;
    }
    this.#resyncInProgress = true;

    const postId = this.currentPostId || this.#postId;
    if (!postId) {
      this.#resyncInProgress = false;
      return;
    }

    // Clear pending state before fetching new state
    if (this.#networkManager) {
      this.#networkManager.pendingUpdates = [];
      this.#networkManager.pendingAwarenessUpdate = null;
    }

    try {
      const data = await this.#networkManager?.fetchState(postId);
      if (!this.composer.model || this.isDestroying || this.isDestroyed) {
        return;
      }

      // In rich mode with an existing Y.Doc, apply the server state as an update
      // rather than creating a new Y.Doc. This preserves the ProseMirror binding.
      if (this.isRichMode && this.#yjsDocument?.doc) {
        try {
          const Y = window.SharedEditsYjs?.Y || window.Y;
          if (Y && data.state) {
            const serverUpdate = base64ToUint8Array(data.state);
            // Apply server state as update - CRDT will merge
            Y.applyUpdate(this.#yjsDocument.doc, serverUpdate, "resync");

            debugLog("Resync: applied server update to existing doc");
          }

          // Skip state vector validation for the next update after resync
          // because the client's doc now has merged state that the server doesn't know about
          if (this.#networkManager) {
            this.#networkManager.skipNextStateVector = true;
          }

          if (this.#richModeSync && this.#yjsDocument?.xmlFragment) {
            this.#richModeSync.syncYTextFromXmlFragment(
              this.#yjsDocument.xmlFragment,
              this.#yjsDocument.text,
              this.#yjsDocument.doc,
              { consumeMarkdown: true }
            );
          }

          this.pendingComposerReply =
            this.#yjsDocument?.getText() ?? data.raw ?? "";
          this.#composerReady = true; // Keep ready state so editing can continue

          this.#queueMissingUpdatesFromServerState(data.state);

          // Re-subscribe to MessageBus with new last_id
          this.#networkManager?.subscribe(
            postId,
            this.#networkManager.messageBusLastId ?? -1
          );
        } catch (updateError) {
          // If applying update fails, fall back to full setup
          debugError("Resync: failed to apply update, falling back:", updateError);
          await this.#setupDoc(data.state, data.raw);
          this.pendingComposerReply =
            this.#yjsDocument?.getText() ?? data.raw ?? "";
          this.#composerReady = false;
          await this.finalizeSubscription();
        }
      } else {
        // Markdown mode or no existing doc - full setup
        await this.#setupDoc(data.state, data.raw);

        let pendingText = this.#yjsDocument?.getText() ?? data.raw ?? "";
        const localText = this.composer?.model?.reply;
        if (typeof localText === "string" && localText !== pendingText) {
          this.#yjsDocument?.doc?.transact(
            () => applyDiff(this.#yjsDocument.text, pendingText, localText),
            this
          );
          pendingText = localText;
        }
        this.pendingComposerReply = pendingText;
        this.#composerReady = false;
        this.#queueMissingUpdatesFromServerState(data.state);
        await this.finalizeSubscription();
      }
    } catch (e) {
      popupAjaxError(e);
    } finally {
      this.#resyncInProgress = false;
    }
  };

  #handleRichModeError = () => {
    // Attempt final sync before giving up
    if (this.#richModeSync && this.#yjsDocument) {
      try {
        this.#richModeSync.flushXmlSync();
        this.#richModeSync.syncYTextFromXmlFragment(
          this.#yjsDocument.xmlFragment,
          this.#yjsDocument.text,
          this.#yjsDocument.doc,
          { consumeMarkdown: true }
        );
      } catch (e) {
        debugError("Final sync failed during rich mode error:", e);
      }
    }

    this.#richModeFailed = true;

    if (this.composer?.model?.action === "sharedEdit") {
      this.composer.close();
    } else {
      this.commit();
    }
  };

  willDestroy() {
    this.#cleanup();
    super.willDestroy(...arguments);
  }

  // Expose doc/text for external access (tests, prosemirror extension)
  get doc() {
    return this.#yjsDocument?.doc ?? null;
  }

  get text() {
    return this.#yjsDocument?.text ?? null;
  }

  get awareness() {
    return this.#yjsDocument?.awareness ?? null;
  }

  get xmlFragment() {
    return this.#yjsDocument?.xmlFragment ?? null;
  }

  get undoManager() {
    return this.#yjsDocument?.undoManager ?? null;
  }

  get cursorOverlay() {
    return this.#markdownSync?.cursorOverlay ?? null;
  }

  get ajaxInProgress() {
    return this.#networkManager?.ajaxInProgress ?? false;
  }

  get inFlightRequest() {
    return this.#networkManager?.inFlightRequest;
  }

  get messageBusLastId() {
    return this.#networkManager?.messageBusLastId;
  }

  get pendingUpdates() {
    return this.#networkManager?.pendingUpdates ?? [];
  }

  get isRichMode() {
    if (this.#richModeFailed) {
      return false;
    }
    return this.siteSettings.shared_edits_editor_mode === "rich";
  }

  // Public API

  async subscribe(postId, { preOpen = false } = {}) {
    let data;
    try {
      postId = postId || this.#postId;

      if (!postId) {
        return;
      }

      if (
        this.#networkManager?.ajaxInProgress &&
        this.currentPostId !== postId
      ) {
        return;
      }

      // Already subscribed to this post
      if (this.currentPostId === postId && this.#yjsDocument?.doc) {
        if (!preOpen) {
          await this.finalizeSubscription();
        }
        return {
          reply: this.pendingComposerReply ?? this.#yjsDocument?.getText(),
        };
      }

      this.#initializeHelpers();
      data = await this.#networkManager.fetchState(postId);
    } catch (e) {
      popupAjaxError(e);
      return;
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
      this.pendingComposerReply =
        this.#yjsDocument?.getText() ?? data.raw ?? "";
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
    if (
      !postId ||
      !this.#yjsDocument?.doc ||
      this.isDestroying ||
      this.isDestroyed
    ) {
      return;
    }

    if (!this.isRichMode) {
      await this.#waitForTextarea();
    }

    if (this.#syncComposerFromDoc()) {
      this.pendingComposerReply = null;
      this.#composerReady = true;
    }

    if (!this.isRichMode && this.#markdownSync) {
      this.#markdownSync.attach(
        this.#yjsDocument.doc,
        this.#yjsDocument.text,
        this.#yjsDocument.undoManager
      );
      this.#markdownSync.onSelectionEnd = () => {
        this.#markdownSync.syncTextareaAfterSelection(
          this.#yjsDocument.text,
          (fn) => {
            this.suppressComposerChange = true;
            fn();
            this.suppressComposerChange = false;
          }
        );
      };
    }

    this.#attachComposerObserver();
    this.#networkManager?.subscribe(
      postId,
      this.#networkManager.messageBusLastId ?? -1
    );
  }

  async commit() {
    // Re-entrancy guard: if already committing, return the same promise
    if (this.#commitPromise) {
      return this.#commitPromise;
    }

    const postId = this.currentPostId || this.#postId;

    if (!postId) {
      return;
    }

    this.#closing = true;

    this.#commitPromise = this.#doCommit(postId);
    try {
      return await this.#commitPromise;
    } finally {
      this.#commitPromise = null;
    }
  }

  async #doCommit(postId) {
    try {
      // Flush any debounced XML sync before flushing updates
      if (this.isRichMode && this.#richModeSync) {
        this.#richModeSync.flushXmlSync();
      }

      // Sync any pending rich mode changes
      if (this.isRichMode && this.#richModeSync && this.#yjsDocument) {
        const didSync = this.#richModeSync.syncYTextFromXmlFragment(
          this.#yjsDocument.xmlFragment,
          this.#yjsDocument.text,
          this.#yjsDocument.doc,
          { consumeMarkdown: true }
        );

        if (didSync && this.#networkManager?.pendingUpdates.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      const flushResult = await this.#networkManager?.flushPendingUpdates(
        postId,
        {
          isRichMode: this.isRichMode,
          cursorPayload: this.#markdownSync?.buildCursorPayload(
            this.#yjsDocument?.text
          ),
          getClientId: () => this.messageBus.clientId,
          allowBlankState: this.#shouldAllowBlankState(),
          getDoc: () => this.#yjsDocument?.doc,
        }
      );

      // If a resync happened during flush, abort commit - the state is stale
      if (flushResult?.resynced) {
        this.#closing = false;
        return;
      }

      this.#detachComposerObserver();
      this.#networkManager?.unsubscribe(postId);

      await this.#networkManager?.commitEdits(postId);

      this.#cleanup();
    } catch (e) {
      this.#closing = false;
      popupAjaxError(e);
    }
  }

  syncFromComposerValue(nextValue) {
    if (
      this.isRichMode ||
      !this.#composerReady ||
      !this.#yjsDocument?.text ||
      !this.#yjsDocument?.doc ||
      this.suppressComposerChange
    ) {
      return;
    }

    const next = nextValue ?? "";
    const current = this.#yjsDocument.text.toString();

    if (current === next) {
      return;
    }

    this.#yjsDocument.doc.transact(
      () => applyDiff(this.#yjsDocument.text, current, next),
      this
    );
  }

  // Private orchestration

  #initializeHelpers() {
    // Clean up any existing helpers
    this.#cleanup();

    this.#yjsDocument = new YjsDocument(this);

    this.#networkManager = new NetworkManager(this, {
      onRemoteMessage: this.#handleRemoteMessage,
      onResync: this.#handleResync,
      getRecoveryText: () => {
        if (this.isRichMode) {
          // Prefer live ProseMirror serialization for recovery text.
          const markdown = getMarkdownFromView({ consumeCapture: true });
          if (markdown !== null) {
            return markdown;
          }

          if (
            this.#richModeSync &&
            this.#yjsDocument?.xmlFragment &&
            this.#yjsDocument?.text &&
            this.#yjsDocument?.doc
          ) {
            this.#richModeSync.syncYTextFromXmlFragment(
              this.#yjsDocument.xmlFragment,
              this.#yjsDocument.text,
              this.#yjsDocument.doc,
              { consumeMarkdown: true }
            );
          }

          // Fall back to Y.Text after forcing a sync from the view/XML fragment.
          return this.#yjsDocument?.text?.toString() ?? null;
        }
        return this.composer.model?.reply ?? null;
      },
    });
    this.#networkManager.onSendUpdates = () => this.#sendUpdates();

    if (this.isRichMode) {
      this.#richModeSync = new RichModeSync(this, {
        onError: this.#handleRichModeError,
        onSyncAnomaly: this.#handleSyncAnomaly,
      });
    } else {
      this.#markdownSync = new MarkdownSync(this);
    }
  }

  async #setupDoc(state, raw) {
    const callbacks = {
      onDocUpdate: this.#handleDocUpdate,
      onTextObserve: this.#handleTextChange,
      onRichModeFailed: () => {
        this.#richModeFailed = true;
        // Clean up rich mode sync and create markdown sync instead
        if (this.#richModeSync) {
          this.#richModeSync.teardown(null, null);
          this.#richModeSync = null;
        }
        if (!this.#markdownSync) {
          this.#markdownSync = new MarkdownSync(this);
        }
      },
      undoOrigin: this,
    };

    // Note: Awareness handler is registered via setupAwarenessHandler below
    // to ensure proper cleanup (single registration point).

    await this.#yjsDocument.setup(state, raw, callbacks);

    // Rich mode additional setup
    if (
      this.isRichMode &&
      this.#richModeSync &&
      this.#yjsDocument.xmlFragment
    ) {
      const hasXmlContent = this.#yjsDocument.xmlFragment.length > 0;

      this.#richModeSync.setupYjsState(
        this.#yjsDocument.xmlFragment,
        this.#yjsDocument.awareness,
        !hasXmlContent
      );

      this.#richModeSync.setupXmlFragmentObserver(
        this.#yjsDocument.xmlFragment,
        () => this.#syncYTextFromXmlFragment()
      );

      this.#richModeSync.setupAwarenessHandler(
        this.#yjsDocument.awareness,
        this.#handleAwarenessUpdate
      );
    }
  }

  #syncYTextFromXmlFragment() {
    if (
      !this.#richModeSync ||
      !this.#yjsDocument ||
      this.isDestroying ||
      this.isDestroyed
    ) {
      return false;
    }

    return this.#richModeSync.syncYTextFromXmlFragment(
      this.#yjsDocument.xmlFragment,
      this.#yjsDocument.text,
      this.#yjsDocument.doc
    );
  }

  #queueMissingUpdatesFromServerState(serverState) {
    if (!serverState || !this.#yjsDocument?.doc || !this.#networkManager) {
      return;
    }

    const Y = window.SharedEditsYjs?.Y || window.Y;
    if (
      !Y?.Doc ||
      !Y?.applyUpdate ||
      !Y?.encodeStateVector ||
      !Y?.encodeStateAsUpdate
    ) {
      return;
    }

    let serverDoc;
    try {
      serverDoc = new Y.Doc();
      const serverUpdate = base64ToUint8Array(serverState);
      if (serverUpdate?.length) {
        Y.applyUpdate(serverDoc, serverUpdate, "remote");
      }

      const serverVector = Y.encodeStateVector(serverDoc);
      const missingUpdate = Y.encodeStateAsUpdate(
        this.#yjsDocument.doc,
        serverVector
      );

      if (missingUpdate?.length) {
        this.#networkManager.queueUpdate(missingUpdate);
      }
    } catch (e) {
      debugError("Failed to queue missing updates:", e);
    } finally {
      serverDoc?.destroy?.();
    }
  }

  #cleanup() {
    this.#markdownSync?.detach();
    this.#richModeSync?.teardown(
      this.#yjsDocument?.xmlFragment,
      this.#yjsDocument?.awareness
    );
    this.#yjsDocument?.teardown();
    this.#networkManager?.teardown();

    this.#detachComposerObserver();

    this.#yjsDocument = null;
    this.#networkManager = null;
    this.#markdownSync = null;
    this.#richModeSync = null;
    this.currentPostId = null;
    this.pendingComposerReply = null;
    this.#composerReady = false;
    this.#richModeFailed = false;
    this.#closing = false;
    this.#commitPromise = null;
    this.#resyncInProgress = false;
    this.suppressComposerChange = false;
  }

  // Test support: force cleanup of all state without committing
  // Use this in test teardown to prevent state leakage between tests
  resetForTests() {
    if (this.currentPostId) {
      this.#networkManager?.unsubscribe(this.currentPostId);
    }
    this.#cleanup();
  }

  async #sendUpdates() {
    if (this.#closing || this.isDestroying || this.isDestroyed) {
      return;
    }

    const postId = this.currentPostId || this.#postId;
    if (!postId || !this.#yjsDocument?.doc) {
      return;
    }

    // In rich mode, sync Y.Text from xmlFragment BEFORE sending updates
    // This ensures the server gets the correct text state
    if (
      this.isRichMode &&
      this.#richModeSync &&
      this.#yjsDocument?.xmlFragment
    ) {
      this.#richModeSync.syncYTextFromXmlFragment(
        this.#yjsDocument.xmlFragment,
        this.#yjsDocument.text,
        this.#yjsDocument.doc
      );
    }

    try {
      await this.#networkManager?.sendUpdates(postId, {
        isRichMode: this.isRichMode,
        cursorPayload: this.#markdownSync?.buildCursorPayload(
          this.#yjsDocument?.text
        ),
        getClientId: () => this.messageBus.clientId,
        allowBlankState: this.#shouldAllowBlankState(),
        getDoc: () => this.#yjsDocument?.doc,
      });
    } catch (e) {
      // Errors are handled in NetworkManager, but log for debugging
      debugError("Failed to send updates:", e);
    }
  }

  // Composer integration

  #syncComposerFromDoc() {
    if (!this.composer.model || !this.#yjsDocument?.text) {
      return false;
    }

    const next = this.pendingComposerReply ?? this.#yjsDocument.text.toString();
    if (this.composer.model.reply === next) {
      return true;
    }

    this.suppressComposerChange = true;
    this.composer.model.set("reply", next);
    this.suppressComposerChange = false;
    return true;
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

  #onComposerChange() {
    if (!this.composer.model) {
      return;
    }

    this.syncFromComposerValue(this.composer.model.reply || "");
  }

  #shouldAllowBlankState() {
    const text = this.#yjsDocument?.text;
    if (!text || typeof text.toString !== "function") {
      return false;
    }

    return text.toString().length === 0;
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

  get #postId() {
    return this.composer.model?.post?.id;
  }
}
