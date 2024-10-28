import { debounce } from "@ember/runloop";
import Service, { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import loadScript from "discourse/lib/load-script";

const THROTTLE_SAVE = 500;

let loadedTextUnicode = false;

function diff(before, after) {
  const diffLib = window.otLib.default.OtDiff.diff;
  const changes = diffLib(before, after);
  return compress(changes);
}

function compress(change) {
  const compressed = [];

  if (change.action !== "noop") {
    if (change.start > 0) {
      compressed.push(change.start);
    }

    switch (change.action) {
      case "replace":
        compressed.push({ d: change.remove });
        compressed.push(change.payload);
        break;
      case "insert":
        compressed.push(change.payload);
        break;
      case "delete":
        compressed.push({ d: change.remove });
        break;
    }
  }

  return compressed;
}

export default class SharedEditManager extends Service {
  @service composer;
  @service messageBus;

  ajaxInProgress = false;
  raw = null;
  version = null;

  async subscribe() {
    try {
      const data = await ajax(`/shared_edits/p/${this.#postId}`);

      if (!this.composer.model || this.isDestroying || this.isDestroyed) {
        return;
      }

      this.version = data.version;
      this.raw = data.raw;
      this.composer.model.set("reply", data.raw);

      this.addObserver("composer.model.reply", this, this.#update);
      this.messageBus.subscribe(`/shared_edits/${this.#postId}`, (message) => {
        if (
          message.client_id !== this.messageBus.clientId &&
          !this.ajaxInProgress
        ) {
          this.#applyRevisions([message]);
        }
      });
    } catch (e) {
      popupAjaxError(e);
    }
  }

  async commit() {
    try {
      this.removeObserver("composer.model.reply", this, this.#update);
      this.messageBus.unsubscribe(`/shared_edits/${this.#postId}`);
      this.raw = null;
      this.version = null;

      await ajax(`/shared_edits/p/${this.#postId}/commit`, {
        method: "PUT",
      });
    } catch (e) {
      popupAjaxError(e);
    }
  }

  async #update() {
    if (!loadedTextUnicode) {
      await loadScript(
        "/plugins/discourse-shared-edits/javascripts/text-unicode-dist.js"
      );
      loadedTextUnicode = true;
    }

    this.#sendDiffThrottled();
  }

  get #postId() {
    return this.composer.model?.post.id;
  }

  #sendDiffThrottled() {
    debounce(this, this.#sendDiff, THROTTLE_SAVE);
  }

  async #sendDiff() {
    if (!this.composer.model || !this.version) {
      return;
    }

    if (this.ajaxInProgress) {
      this.#sendDiffThrottled();
      return;
    }

    const changes = diff(this.raw, this.composer.model.reply);
    const submittedRaw = this.composer.model.reply;

    if (changes.length === 0) {
      return;
    }

    this.ajaxInProgress = true;

    try {
      const result = await ajax(`/shared_edits/p/${this.#postId}`, {
        method: "PUT",
        data: {
          revision: JSON.stringify(changes),
          version: this.version,
          client_id: this.messageBus.clientId,
        },
      });

      const inProgressChanges = diff(submittedRaw, this.composer.model.reply);
      this.#applyRevisions(result.revisions, inProgressChanges);
    } finally {
      this.ajaxInProgress = false;
    }
  }

  #applyRevisions(revs, inProgressChanges) {
    let newRaw = this.raw;
    let newVersion = this.version;
    let currentChanges =
      inProgressChanges || diff(this.raw, this.composer.model.reply);

    const otUnicode = window.otLib.default.OtUnicode;

    let newChanges = [];

    for (const revision of revs) {
      if (revision.version !== newVersion + 1) {
        continue;
      }

      const parsedRevision = JSON.parse(revision.revision);
      newRaw = otUnicode.apply(newRaw, parsedRevision);
      newVersion = revision.version;

      if (revision.client_id !== this.messageBus.clientId) {
        newChanges = otUnicode.compose(newChanges, parsedRevision);
        currentChanges = otUnicode.transform(
          currentChanges,
          parsedRevision,
          "left"
        );
      }
    }

    this.raw = newRaw;
    this.version = newVersion;

    if (currentChanges.length > 0) {
      newRaw = otUnicode.apply(newRaw, currentChanges);
    }

    if (newRaw !== this.composer.model.reply) {
      const input = document.querySelector(
        "#reply-control textarea.d-editor-input"
      );

      if (input.selectionStart || input.selectionStart === 0) {
        const selLength = input.selectionEnd - input.selectionStart;
        const position = otUnicode.transformPosition(
          input.selectionStart,
          newChanges
        );

        // still need to compensate for scrollHeight changes
        // but at least this is mostly stable
        const scrollTop = input.scrollTop;

        input.value = newRaw;
        input.selectionStart = position;
        input.selectionEnd = position + selLength;

        window.requestAnimationFrame(() => {
          input.scrollTop = scrollTop;
        });
      }

      this.composer.model.set("reply", newRaw);
    }
  }
}
