/**
 * Manages network operations for shared edits: API calls, MessageBus subscriptions,
 * and update batching/throttling.
 */
import { getOwner, setOwner } from "@ember/owner";
import { cancel, throttle } from "@ember/runloop";
import { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { debugError, debugLog, debugWarn } from "./debug";
import { base64ToUint8Array, uint8ArrayToBase64 } from "./encoding-utils";
import { computeStateHash, triggerYjsLoad } from "./yjs-document";

const THROTTLE_SAVE = 500;
const MESSAGE_BUS_CHANNEL_PREFIX = "/shared_edits";
const MAX_PENDING_UPDATES = 100;
const MAX_RETRY_ATTEMPTS = 3;
const STATE_HASH_SYNC_TIMEOUT = 5000; // 5 seconds to reach target hash

function messageBusChannel(postId) {
  return `${MESSAGE_BUS_CHANNEL_PREFIX}/${postId}`;
}

export default class NetworkManager {
  @service messageBus;

  pendingUpdates = [];
  pendingAwarenessUpdate = null;
  ajaxInProgress = false;
  inFlightRequest = null;
  messageBusLastId = null;
  skipNextStateVector = false; // Skip state vector validation after resync

  // State hash sync tracking
  #targetStateHash = null;
  #hashSyncTimeoutId = null;
  #getDoc = null;
  #lastVerifiedHash = null; // Cache to avoid redundant hash computation

  #sendUpdatesThrottleId = null;
  #messageBusPostId = null;
  #messageBusLastSubscribedId = null;
  #onRemoteMessage = null;
  #onResync = null;
  #getRecoveryText = null;
  #retryCount = 0;

  #handleRemoteMessage = (message) => {
    if (message.action === "resync") {
      this.#lastVerifiedHash = null; // Invalidate cache on resync
      this.#onResync?.();
      return;
    }

    if (message.client_id === this.messageBus.clientId) {
      return;
    }

    // Parse update from base64 if present
    const parsedMessage = { ...message };
    if (message.update) {
      parsedMessage.updateBinary = base64ToUint8Array(message.update);
      this.#lastVerifiedHash = null; // Invalidate cache when doc changes
    }
    if (message.awareness) {
      parsedMessage.awarenessBinary = base64ToUint8Array(message.awareness);
    }

    this.#onRemoteMessage?.(parsedMessage);
  };

  constructor(context, { onRemoteMessage, onResync, getRecoveryText } = {}) {
    setOwner(this, getOwner(context));
    this.#onRemoteMessage = onRemoteMessage;
    this.#onResync = onResync;
    this.#getRecoveryText = getRecoveryText;
  }

  // API calls

  async fetchState(postId) {
    const data = await ajax(`/shared_edits/p/${postId}.json`);
    this.messageBusLastId = data.message_bus_last_id ?? -1;
    return data;
  }

  async commitEdits(postId) {
    await ajax(`/shared_edits/p/${postId}/commit.json`, { method: "PUT" });
  }

  // Update management

  queueUpdate(update) {
    this.pendingUpdates.push(update);
    this.#lastVerifiedHash = null; // Invalidate cache when doc changes
    this.#sendUpdatesThrottled();
  }

  queueAwarenessUpdate(update) {
    this.pendingAwarenessUpdate = update;
    this.#sendUpdatesThrottled();
  }

  #sendUpdatesThrottled() {
    this.#sendUpdatesThrottleId = throttle(
      this,
      this.#triggerSendUpdates,
      THROTTLE_SAVE,
      false
    );
  }

  #triggerSendUpdates() {
    this.onSendUpdates?.();
  }

  // Called by the orchestrator service to actually send updates
  // Returns { resynced: true } if a 409 state_recovered triggered a resync
  async sendUpdates(
    postId,
    { cursorPayload, isRichMode, getClientId, allowBlankState, getDoc } = {}
  ) {
    const updatesToSend = [...this.pendingUpdates];
    const awarenessToSend = this.pendingAwarenessUpdate;

    const hasDocUpdates = updatesToSend.length > 0;
    const hasAwarenessUpdate = isRichMode && awarenessToSend;

    if ((!hasDocUpdates && !hasAwarenessUpdate) || !postId) {
      return { resynced: false };
    }

    if (this.ajaxInProgress) {
      if (this.inFlightRequest) {
        await this.inFlightRequest;
      }
    }

    const data = {
      client_id: getClientId?.() || this.messageBus.clientId,
    };

    if (allowBlankState) {
      data.allow_blank_state = true;
    }

    this.pendingUpdates = [];
    this.pendingAwarenessUpdate = null;

    let sentUpdates = [];

    if (hasDocUpdates) {
      const { payload, deferredUpdates } =
        await this.#prepareUpdatePayload(updatesToSend);
      const queuedDuringMerge = this.pendingUpdates;
      this.pendingUpdates = deferredUpdates.concat(queuedDuringMerge);
      sentUpdates = updatesToSend.slice(
        0,
        updatesToSend.length - deferredUpdates.length
      );
      if (payload) {
        data.update = uint8ArrayToBase64(payload);

        // Include state vector for server-side validation (unless skipped after resync)
        if (!this.skipNextStateVector) {
          const doc = getDoc?.();
          if (doc) {
            const Y = window.SharedEditsYjs?.Y || window.Y;
            if (Y?.encodeStateVector) {
              data.state_vector = uint8ArrayToBase64(Y.encodeStateVector(doc));
            }
          }
        }
      }
    }

    if (hasAwarenessUpdate) {
      data.awareness = uint8ArrayToBase64(awarenessToSend);
    }

    if (!isRichMode && cursorPayload) {
      data.cursor = cursorPayload;
    }

    this.ajaxInProgress = true;

    try {
      this.inFlightRequest = ajax(`/shared_edits/p/${postId}.json`, {
        method: "PUT",
        data,
      });

      const response = await this.inFlightRequest;
      this.#retryCount = 0;
      this.skipNextStateVector = false; // Reset after successful update

      // Store getDoc for hash verification
      this.#getDoc = getDoc;

      // Process state_hash from server response for sync verification
      if (response?.state_hash) {
        this.#processServerStateHash(response.state_hash, getDoc);
      }

      return { resynced: false };
    } catch (e) {
      // Handle corruption that needs client text for recovery
      if (
        e.jqXHR?.status === 409 &&
        e.jqXHR?.responseJSON?.error === "needs_recovery_text"
      ) {
        const recoveryText = this.#getRecoveryText?.();
        if (recoveryText != null) {
          debugLog("Corruption detected, sending recovery text");
          try {
            const retryResult = await ajax(`/shared_edits/p/${postId}.json`, {
              method: "PUT",
              data: {
                client_id: data.client_id,
                recovery_text: recoveryText,
              },
            });
            debugLog("Recovery successful, version:", retryResult.version);
            this.#retryCount = 0;
            // Trigger resync to reinitialize local Y.Doc with the server's fresh state
            // This ensures the local doc matches exactly what the server accepted
            this.#onResync?.();
            return { resynced: true, recovered: true };
          } catch (retryError) {
            debugError("Recovery with client text failed:", retryError);
          }
        }
      }

      if (
        e.jqXHR?.status === 409 &&
        e.jqXHR?.responseJSON?.error === "state_recovered"
      ) {
        this.#retryCount = 0;
        this.#onResync?.();
        return { resynced: true };
      }

      // Handle state divergence - client is behind server
      if (
        e.jqXHR?.status === 409 &&
        e.jqXHR?.responseJSON?.error === "state_diverged" &&
        e.jqXHR?.responseJSON?.missing_update
      ) {
        const doc = getDoc?.();
        if (doc) {
          const Y = window.SharedEditsYjs?.Y || window.Y;
          if (Y?.applyUpdate) {
            debugLog("State diverged, applying missing update");
            const missingUpdate = base64ToUint8Array(
              e.jqXHR.responseJSON.missing_update
            );
            Y.applyUpdate(doc, missingUpdate, "remote");

            // Re-queue the failed updates to try again with the now-synced state
            if (sentUpdates.length && this.#retryCount <= MAX_RETRY_ATTEMPTS) {
              const combined = sentUpdates.concat(this.pendingUpdates);
              this.pendingUpdates = combined.slice(0, MAX_PENDING_UPDATES);
              this.#retryCount++;
              // Trigger immediate retry
              this.#sendUpdatesThrottled();
              return { resynced: false, appliedMissingUpdate: true };
            }
          }
        }
        // If we couldn't apply the missing update, trigger full resync
        this.#retryCount = 0;
        this.#onResync?.();
        return { resynced: true };
      }

      this.#retryCount++;

      // Re-queue failed updates with bounded retry
      if (sentUpdates.length && this.#retryCount <= MAX_RETRY_ATTEMPTS) {
        const combined = sentUpdates.concat(this.pendingUpdates);
        this.pendingUpdates = combined.slice(0, MAX_PENDING_UPDATES);
      } else if (this.#retryCount > MAX_RETRY_ATTEMPTS) {
        debugError("Max retries exceeded, triggering resync");
        this.#retryCount = 0;
        this.#onResync?.();
        return { resynced: true };
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

  async flushPendingUpdates(postId, options = {}) {
    if (this.inFlightRequest) {
      await this.inFlightRequest;
    }

    const hasUpdates =
      this.pendingUpdates.length > 0 ||
      (options.isRichMode && this.pendingAwarenessUpdate);

    let result = { resynced: false };
    if (hasUpdates) {
      result = (await this.sendUpdates(postId, options)) || { resynced: false };
    }

    if (this.inFlightRequest) {
      await this.inFlightRequest;
    }

    return result;
  }

  // MessageBus subscription

  subscribe(postId, lastId) {
    if (!postId) {
      return;
    }

    const needsResubscribe =
      this.#messageBusPostId !== postId ||
      this.#messageBusLastSubscribedId !== lastId;

    if (!needsResubscribe) {
      return;
    }

    if (this.#messageBusPostId) {
      this.messageBus.unsubscribe(messageBusChannel(this.#messageBusPostId));
    }

    this.messageBus.subscribe(
      messageBusChannel(postId),
      this.#handleRemoteMessage,
      lastId
    );
    this.#messageBusPostId = postId;
    this.#messageBusLastSubscribedId = lastId;
  }

  unsubscribe(postId) {
    if (postId) {
      this.messageBus.unsubscribe(messageBusChannel(postId));
    }
    if (this.#messageBusPostId) {
      this.messageBus.unsubscribe(messageBusChannel(this.#messageBusPostId));
    }
    this.#messageBusPostId = null;
    this.#messageBusLastSubscribedId = null;
  }

  teardown() {
    if (this.#sendUpdatesThrottleId) {
      cancel(this.#sendUpdatesThrottleId);
      this.#sendUpdatesThrottleId = null;
    }
    this.#clearHashSyncTimeout();
    this.unsubscribe();
    this.pendingUpdates = [];
    this.pendingAwarenessUpdate = null;
    this.ajaxInProgress = false;
    this.inFlightRequest = null;
    this.messageBusLastId = null;
    this.skipNextStateVector = false;
    this.#targetStateHash = null;
    this.#lastVerifiedHash = null;
    this.#getDoc = null;
  }

  // State hash sync methods

  #processServerStateHash(serverHash, getDoc) {
    if (!serverHash) {
      return;
    }

    this.#targetStateHash = serverHash;

    // Compute local hash asynchronously and verify
    this.#verifyStateHash(getDoc);
  }

  async #verifyStateHash(getDoc) {
    const doc = getDoc?.();
    if (!doc || !this.#targetStateHash) {
      return;
    }

    // Skip recomputation if we already verified this target hash
    if (this.#lastVerifiedHash === this.#targetStateHash) {
      this.#clearHashSyncTimeout();
      this.#targetStateHash = null;
      return;
    }

    const localHash = await computeStateHash(doc);
    if (!localHash) {
      return;
    }

    if (localHash === this.#targetStateHash) {
      // Hashes match - we're synced
      this.#lastVerifiedHash = localHash;
      this.#clearHashSyncTimeout();
      this.#targetStateHash = null;
      return;
    }

    // Hashes don't match - start forwarding timeout if not already running
    if (!this.#hashSyncTimeoutId) {
      debugLog(
        "State hash mismatch, waiting for MessageBus updates.",
        `Local: ${localHash.slice(0, 8)}..., Target: ${this.#targetStateHash.slice(0, 8)}...`
      );
      this.#startHashSyncTimeout();
    }
  }

  #startHashSyncTimeout() {
    this.#clearHashSyncTimeout();
    this.#hashSyncTimeoutId = setTimeout(() => {
      this.#hashSyncTimeoutId = null;
      this.#handleHashSyncTimeout();
    }, STATE_HASH_SYNC_TIMEOUT);
  }

  #clearHashSyncTimeout() {
    if (this.#hashSyncTimeoutId) {
      clearTimeout(this.#hashSyncTimeoutId);
      this.#hashSyncTimeoutId = null;
    }
  }

  async #handleHashSyncTimeout() {
    if (!this.#targetStateHash || !this.#getDoc) {
      return;
    }

    // Check one more time if we've synced
    const doc = this.#getDoc();
    if (doc) {
      const localHash = await computeStateHash(doc);
      if (localHash === this.#targetStateHash) {
        // We synced in time
        this.#targetStateHash = null;
        return;
      }

      debugWarn(
        "State hash sync timeout - local state diverged from server.",
        `Local: ${localHash?.slice(0, 8) || "null"}..., Target: ${this.#targetStateHash.slice(0, 8)}... Triggering resync.`
      );
    }

    // Still mismatched after timeout - trigger full resync
    this.#targetStateHash = null;
    this.#onResync?.();
  }

  // Called when a remote message is applied to re-verify hash
  async notifyRemoteUpdateApplied() {
    if (this.#targetStateHash && this.#getDoc) {
      await this.#verifyStateHash(this.#getDoc);
    }
  }

  async #prepareUpdatePayload(updates) {
    if (updates.length <= 1) {
      return { payload: updates[0] || null, deferredUpdates: [] };
    }

    let merger = window.SharedEditsYjs?.Y || window.Y;

    if (!merger?.mergeUpdates) {
      try {
        await triggerYjsLoad();
        merger = window.SharedEditsYjs?.Y || window.Y;
      } catch (e) {
        debugWarn("Failed to load Yjs while merging updates:", e);
      }
    }

    if (merger?.mergeUpdates) {
      return { payload: merger.mergeUpdates(updates), deferredUpdates: [] };
    }

    debugWarn("Unable to merge shared edit updates; sending sequentially.");
    return { payload: updates[0], deferredUpdates: updates.slice(1) };
  }
}
