/**
 * Manages network operations for shared edits: API calls, MessageBus subscriptions,
 * and update batching/throttling.
 */
import { getOwner, setOwner } from "@ember/owner";
import { cancel, throttle } from "@ember/runloop";
import { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { base64ToUint8Array, uint8ArrayToBase64 } from "./encoding-utils";
import { triggerYjsLoad } from "./yjs-document";

const THROTTLE_SAVE = 500;
const MESSAGE_BUS_CHANNEL_PREFIX = "/shared_edits";
const MAX_PENDING_UPDATES = 100;
const MAX_RETRY_ATTEMPTS = 3;

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

  #sendUpdatesThrottleId = null;
  #messageBusPostId = null;
  #messageBusLastSubscribedId = null;
  #onRemoteMessage = null;
  #onResync = null;
  #getRecoveryText = null;
  #retryCount = 0;

  #handleRemoteMessage = (message) => {
    if (message.action === "resync") {
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

      await this.inFlightRequest;
      this.#retryCount = 0;
      this.skipNextStateVector = false; // Reset after successful update
      return { resynced: false };
    } catch (e) {
      // Handle corruption that needs client text for recovery
      if (
        e.jqXHR?.status === 409 &&
        e.jqXHR?.responseJSON?.error === "needs_recovery_text"
      ) {
        const recoveryText = this.#getRecoveryText?.();
        if (recoveryText != null) {
          // eslint-disable-next-line no-console
          console.log(
            "[SharedEdits] Corruption detected, sending recovery text"
          );
          try {
            const retryResult = await ajax(`/shared_edits/p/${postId}.json`, {
              method: "PUT",
              data: {
                client_id: data.client_id,
                recovery_text: recoveryText,
              },
            });
            // eslint-disable-next-line no-console
            console.log(
              "[SharedEdits] Recovery successful, version:",
              retryResult.version
            );
            this.#retryCount = 0;
            // Trigger resync to reinitialize local Y.Doc with the server's fresh state
            // This ensures the local doc matches exactly what the server accepted
            this.#onResync?.();
            return { resynced: true, recovered: true };
          } catch (retryError) {
            // eslint-disable-next-line no-console
            console.error(
              "[SharedEdits] Recovery with client text failed:",
              retryError
            );
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
            // eslint-disable-next-line no-console
            console.log(
              "[SharedEdits] State diverged, applying missing update"
            );
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
        // eslint-disable-next-line no-console
        console.error("[SharedEdits] Max retries exceeded, triggering resync");
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
    this.unsubscribe();
    this.pendingUpdates = [];
    this.pendingAwarenessUpdate = null;
    this.ajaxInProgress = false;
    this.inFlightRequest = null;
    this.messageBusLastId = null;
    this.skipNextStateVector = false;
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
        // eslint-disable-next-line no-console
        console.warn(
          "[SharedEdits] Failed to load Yjs while merging updates:",
          e
        );
      }
    }

    if (merger?.mergeUpdates) {
      return { payload: merger.mergeUpdates(updates), deferredUpdates: [] };
    }

    // eslint-disable-next-line no-console
    console.warn(
      "[SharedEdits] Unable to merge shared edit updates; sending sequentially."
    );
    return { payload: updates[0], deferredUpdates: updates.slice(1) };
  }
}
