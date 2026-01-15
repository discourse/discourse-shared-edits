/**
 * Manages network operations for shared edits: API calls, MessageBus subscriptions,
 * and update batching/throttling.
 */
import { getOwner, setOwner } from "@ember/owner";
import { cancel, throttle } from "@ember/runloop";
import { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { base64ToUint8Array, uint8ArrayToBase64 } from "./encoding-utils";

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
  async sendUpdates(postId, { cursorPayload, isRichMode, getClientId } = {}) {
    const updatesToSend = [...this.pendingUpdates];
    const awarenessToSend = this.pendingAwarenessUpdate;

    const hasDocUpdates = updatesToSend.length > 0;
    const hasAwarenessUpdate = isRichMode && awarenessToSend;

    if ((!hasDocUpdates && !hasAwarenessUpdate) || !postId) {
      return;
    }

    if (this.ajaxInProgress) {
      if (this.inFlightRequest) {
        await this.inFlightRequest;
      }
    }

    const data = {
      client_id: getClientId?.() || this.messageBus.clientId,
    };

    if (hasDocUpdates) {
      const payload =
        updatesToSend.length === 1
          ? updatesToSend[0]
          : window.Y.mergeUpdates(updatesToSend);
      data.update = uint8ArrayToBase64(payload);
    }

    if (hasAwarenessUpdate) {
      data.awareness = uint8ArrayToBase64(awarenessToSend);
    }

    if (!isRichMode && cursorPayload) {
      data.cursor = cursorPayload;
    }

    this.pendingUpdates = [];
    this.pendingAwarenessUpdate = null;
    this.ajaxInProgress = true;

    try {
      this.inFlightRequest = ajax(`/shared_edits/p/${postId}`, {
        method: "PUT",
        data,
      });

      await this.inFlightRequest;
    } catch (e) {
      if (
        e.jqXHR?.status === 409 &&
        e.jqXHR?.responseJSON?.error === "state_recovered"
      ) {
        this.#onResync?.();
        return;
      }

      // Re-queue failed updates
      if (updatesToSend.length) {
        this.pendingUpdates = updatesToSend.concat(this.pendingUpdates);
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

    if (hasUpdates) {
      await this.sendUpdates(postId, options);
    }

    if (this.inFlightRequest) {
      await this.inFlightRequest;
    }
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
}
