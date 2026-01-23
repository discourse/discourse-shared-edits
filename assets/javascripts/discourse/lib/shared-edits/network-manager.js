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

const THROTTLE_SAVE = 350;
const MESSAGE_BUS_CHANNEL_PREFIX = "/shared_edits";

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

  #sendUpdatesThrottleId = null;
  #messageBusPostId = null;
  #messageBusLastSubscribedId = null;
  #onRemoteMessage = null;
  #onResync = null;

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

  constructor(context, { onRemoteMessage, onResync } = {}) {
    setOwner(this, getOwner(context));
    this.#onRemoteMessage = onRemoteMessage;
    this.#onResync = onResync;
  }

  // API calls

  async fetchState(postId) {
    const data = await ajax(`/shared_edits/p/${postId}`);
    this.messageBusLastId = data.message_bus_last_id ?? -1;
    return data;
  }

  async commitEdits(postId) {
    await ajax(`/shared_edits/p/${postId}/commit`, { method: "PUT" });
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
    { cursorPayload, isRichMode, getClientId, allowBlankState } = {}
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
      this.inFlightRequest = ajax(`/shared_edits/p/${postId}`, {
        method: "PUT",
        data,
      });

      await this.inFlightRequest;
      return { resynced: false };
    } catch (e) {
      if (
        e.jqXHR?.status === 409 &&
        e.jqXHR?.responseJSON?.error === "state_recovered"
      ) {
        this.#onResync?.();
        return { resynced: true };
      }

      // Re-queue failed updates
      if (sentUpdates.length) {
        this.pendingUpdates = sentUpdates.concat(this.pendingUpdates);
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
