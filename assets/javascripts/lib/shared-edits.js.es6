import { ajax } from "discourse/lib/ajax";
import EmberObject from "@ember/object";
import { popupAjaxError } from "discourse/lib/ajax-error";
import loadScript from "discourse/lib/load-script";
import { throttle, next } from "@ember/runloop";

const THROTTLE_SAVE = 500;

export function setupSharedEdit(composer) {
  const manager = SharedEditManager.create();
  composer.set("sharedEditManager", manager);

  ajax(`/shared_edits/p/${composer.post.id}`)
    .then(data => {
      manager.set("version", data.version);
      manager.set("raw", data.raw);
      manager.set("composer", composer);
      composer.set("reply", data.raw);
      manager.subscribe();
    })
    .catch(popupAjaxError);
}

let loadedTextUnicode = false;

export function teardownSharedEdit(composer) {
  const post = composer.post;

  const manager = composer.sharedEditManager;
  if (manager) {
    manager.commit();
  }

  composer.messageBus.unsubscribe(`/shared_edits/${post.id}`);
  composer.set("sharedEditManager.composer", null);
  composer.set("sharedEditManager", null);
}

export function performSharedEdit(composer) {
  if (composer.sharedEditManager) {
    composer.sharedEditManager.performSharedEdit();
  }
}

function diff(before, after) {
  const diffLib = window.otLib.default.OtDiff.diff;
  const changes = diffLib(before, after);
  return compress(changes);
}

function compress(change) {
  let compressed = [];

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

const SharedEditManager = EmberObject.extend({
  raw: null,
  version: null,

  submittedChanges: null,
  pendingChanges: null,
  ajaxInProgress: false,

  commit() {
    ajax(`/shared_edits/p/${this.composer.post.id}/commit`, {
      method: "PUT"
    }).catch(popupAjaxError);
  },

  performSharedEdit() {
    if (loadedTextUnicode) {
      this.sendDiffThrottled();
    } else {
      loadScript(
        "/plugins/discourse-shared-edits/javascripts/text-unicode-dist.js"
      ).then(() => {
        loadedTextUnicode = true;
        this.sendDiffThrottled();
      });
    }
  },

  sendDiffThrottled() {
    throttle(this, "sendDiff", THROTTLE_SAVE, false);
  },

  sendDiff() {
    const composer = this.composer;
    if (!composer) {
      return;
    }

    if (this.ajaxInProgress) {
      this.sendDiffThrottled();
      return;
    }

    const changes = diff(this.raw, composer.reply);
    const submittedRaw = composer.reply;

    if (changes.length > 0) {
      this.ajaxInProgress = true;

      ajax(`/shared_edits/p/${composer.post.id}`, {
        method: "PUT",
        data: {
          revision: JSON.stringify(changes),
          version: this.version,
          client_id: composer.messageBus.clientId
        }
      })
        .then(result => {
          const inProgressChanges = diff(submittedRaw, composer.reply);
          this.applyRevisions(result.revisions, inProgressChanges);
        })
        .finally(() => {
          this.ajaxInProgress = false;
        });
    }
  },

  applyRevisions(revs, inProgressChanges) {
    let currentChanges =
      inProgressChanges || diff(this.raw, this.composer.reply);

    let newRaw = this.raw;
    let newVersion = this.version;

    const otUnicode = window.otLib.default.OtUnicode;

    let newChanges = [];

    revs.forEach(revision => {
      if (revision.version === newVersion + 1) {
        let parsedRevision = JSON.parse(revision.revision);
        newRaw = otUnicode.apply(newRaw, parsedRevision);
        newVersion = revision.version;

        if (revision.client_id !== this.composer.messageBus.clientId) {
          newChanges = otUnicode.compose(newChanges, parsedRevision);
          currentChanges = otUnicode.transform(
            currentChanges,
            parsedRevision,
            "left"
          );
        }
      }
    });

    this.set("raw", newRaw);
    this.set("version", newVersion);

    if (currentChanges.length > 0) {
      newRaw = otUnicode.apply(newRaw, currentChanges);
    }

    if (newRaw !== this.composer.reply) {
      const input = document.querySelector(
        "#reply-control textarea.d-editor-input"
      );

      if (input.selectionStart) {
        const selLength = input.selectionEnd - input.selectionStart;

        let position = otUnicode.transformPosition(
          input.selectionStart,
          newChanges
        );

        next(null, () => {
          input.selectionStart = position;
          input.selectionEnd = position + selLength;
        });
      }

      this.composer.set("reply", newRaw);
    }
  },

  subscribe() {
    const composer = this.composer;
    const post = composer.post;

    composer.messageBus.subscribe(`/shared_edits/${post.id}`, message => {
      if (
        message.client_id !== composer.messageBus.clientId &&
        !this.ajaxInProgress
      ) {
        this.applyRevisions([message]);
      }
    });
  }
});
