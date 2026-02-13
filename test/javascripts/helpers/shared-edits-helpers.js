import { click, getContext, visit, waitUntil } from "@ember/test-helpers";
import { publishToMessageBus } from "discourse/tests/helpers/qunit-helpers";
import { resetYjsModuleState } from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/yjs-document";
import { resetProsemirrorExtensionState } from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits-prosemirror-extension";

const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";

// Reset shared edits module state - call this from acceptance test hooks
export function resetSharedEditsState(container) {
  resetYjsModuleState();
  resetProsemirrorExtensionState();

  // Also reset the service if we have access to the container
  if (container) {
    try {
      const manager = container.lookup("service:shared-edit-manager");
      if (manager && !manager.isDestroying && !manager.isDestroyed) {
        manager.resetForTests();
      }
    } catch {
      // Service might not be available - that's fine
    }
  }
}

// Open shared edit composer for topic 280
export async function openSharedEditComposer() {
  // Reset module state before each test to prevent state leakage
  // Try to get the container from test context to reset service state
  const context = getContext();
  const container = context?.owner;
  resetSharedEditsState(container);

  await visit("/t/internationalization-localization/280");
  await click(".show-more-actions");
  await click(".show-post-admin-menu");
  await click(".admin-toggle-shared-edits");
  await click(".shared-edit");
}

// Wait for SharedEditManager service to be ready with doc initialized
export async function waitForSharedEditManager(container) {
  const manager = container.lookup("service:shared-edit-manager");
  await waitUntil(() => manager.doc && manager.text);
  return manager;
}

// Wait for Yjs to be loaded globally
export async function waitForYjs() {
  await waitUntil(() => window.Y);
  return window.Y;
}

// Create a Yjs update by inserting text into a doc
export function createYjsInsertUpdate(Y, initialContent, insertText, atIndex) {
  const doc = new Y.Doc();
  const text = doc.getText("post");
  if (initialContent) {
    text.insert(0, initialContent);
  }
  const prevState = Y.encodeStateVector(doc);
  text.insert(atIndex ?? text.length, insertText);
  return Y.encodeStateAsUpdate(doc, prevState);
}

// Create a full Yjs state from content
export function createYjsState(Y, content) {
  const doc = new Y.Doc();
  const text = doc.getText("post");
  text.insert(0, content);
  return Y.encodeStateAsUpdate(doc);
}

// Simulate a remote edit via message bus
export async function simulateRemoteEdit(postId, updateBase64, options = {}) {
  await publishToMessageBus(`/shared_edits/${postId}`, {
    client_id: options.clientId || "remote-client",
    user_id: options.userId || 999,
    username: options.username || "remote_user",
    update: updateBase64,
    cursor: options.cursor,
    awareness: options.awareness,
  });
}

// Simulate a resync action via message bus
export async function simulateResync(postId) {
  await publishToMessageBus(`/shared_edits/${postId}`, {
    action: "resync",
  });
}

// Base64 encoding helpers
export function uint8ArrayToBase64(uint8) {
  let binary = "";
  uint8.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export function base64ToUint8Array(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// Base64url encoding (URL-safe)
export function uint8ArrayToBase64url(uint8) {
  return uint8ArrayToBase64(uint8)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64urlToUint8Array(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return base64ToUint8Array(base64);
}

// Get the composer textarea element
export function getTextarea() {
  return document.querySelector(TEXTAREA_SELECTOR);
}

// Standard pretender route setup
export function setupSharedEditsPretender(server, helper, options = {}) {
  const requestBodies = options.requestBodies || [];
  const commitCalls = options.commitCalls || [];

  server.put("/shared_edits/p/:id/enable.json", () =>
    helper.response({ success: "OK" })
  );

  server.get("/posts/:id.json", () =>
    helper.response({
      id: 398,
      raw: options.initialRaw || "initial post content",
    })
  );

  server.get("/shared_edits/p/:id", () =>
    helper.response({
      state: options.initialState || "",
      raw: options.initialRaw || "initial post content",
      version: options.initialVersion || 1,
      message_bus_last_id: options.messageBusLastId || 0,
    })
  );

  server.put("/shared_edits/p/:id", (request) => {
    if (options.onPut) {
      const result = options.onPut(request);
      if (result) {
        return result;
      }
    }
    if (request.requestBody) {
      const {
        parsePostData,
      } = require("discourse/tests/helpers/create-pretender");
      requestBodies.push(parsePostData(request.requestBody));
    }
    return helper.response({ success: "OK" });
  });

  server.put("/shared_edits/p/:id/commit.json", () => {
    commitCalls.push(Date.now());
    return helper.response({ success: "OK" });
  });

  server.put("/shared_edits/p/:id/selection", () =>
    helper.response({ success: "OK" })
  );

  return { requestBodies, commitCalls };
}
