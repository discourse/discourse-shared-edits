import { click, fillIn, visit, waitUntil } from "@ember/test-helpers";
import { test } from "qunit";
import { parsePostData } from "discourse/tests/helpers/create-pretender";
import {
  acceptance,
  publishToMessageBus,
} from "discourse/tests/helpers/qunit-helpers";

const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";

function uint8ArrayToBase64(uint8) {
  return btoa(String.fromCharCode.apply(null, uint8));
}

function base64ToUint8Array(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

acceptance(`Discourse Shared Edits | Cursors & Selection`, function (needs) {
  let updateRequestBodies;

  needs.user();
  needs.pretender((server, helper) => {
    updateRequestBodies = [];

    server.put("/shared_edits/p/:id/enable.json", () =>
      helper.response({ success: "OK" })
    );

    server.get("/posts/:id.json", () =>
      helper.response({
        id: 398,
        raw: "initial post content",
      })
    );

    server.get("/shared_edits/p/:id", () =>
      helper.response({
        state: "",
        raw: "content",
        version: 1,
        message_bus_last_id: 0,
      })
    );

    server.put("/shared_edits/p/:id", (request) => {
      const body = request.requestBody
        ? parsePostData(request.requestBody)
        : {};
      updateRequestBodies.push(body);
      return helper.response({ success: "OK" });
    });
    server.put("/shared_edits/p/:id/selection", () =>
      helper.response({ success: "OK" })
    );
    server.put("/shared_edits/p/:id/commit", () =>
      helper.response({ success: "OK" })
    );
  });

  async function openSharedEditComposer() {
    await visit("/t/internationalization-localization/280");
    await click(".show-more-actions");
    await click(".show-post-admin-menu");
    await click(".admin-toggle-shared-edits");
    await click(".shared-edit");
  }

  test("displays remote cursor when remote update is received", async function (assert) {
    updateRequestBodies.length = 0;

    await openSharedEditComposer();

    assert
      .dom(".shared-edits-cursor-overlay")
      .exists("Cursor overlay container created");

    // Wait for Yjs to be loaded by the application
    await waitUntil(() => window.Y);
    const Y = window.Y;

    // Create a valid Yjs update
    const doc = new Y.Doc();
    const text = doc.getText("post");
    text.insert(0, " remote edit");
    const update = Y.encodeStateAsUpdate(doc);
    // Convert Uint8Array to base64
    const base64Update = btoa(String.fromCharCode.apply(null, update));

    const cursorPosition = Y.createRelativePositionFromTypeIndex(text, 0, 0);
    const cursorBase64 = uint8ArrayToBase64(
      Y.encodeRelativePosition(cursorPosition)
    );

    // Simulate remote message
    await publishToMessageBus("/shared_edits/398", {
      client_id: "remote-client-1",
      user_id: 123,
      user_name: "remoteuser",
      update: base64Update,
      cursor: { start: cursorBase64 },
    });

    // The update should trigger the text observer -> CursorOverlay.updateCursor -> Render

    // Wait for UI update
    await waitUntil(() => document.querySelector(".shared-edits-cursor"));

    assert.dom(".shared-edits-cursor").exists("Remote cursor element created");
    assert
      .dom(".shared-edits-cursor__label")
      .hasText("remoteuser", "Cursor label shows username");
  });

  test("sends cursor metadata with outgoing updates", async function (assert) {
    updateRequestBodies.length = 0;

    await openSharedEditComposer();

    await waitUntil(() => window.Y);

    await fillIn(TEXTAREA_SELECTOR, "content updated");
    updateRequestBodies.length = 0;

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    textarea.setRangeText("!", 2, 2, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    await waitUntil(() => updateRequestBodies.length > 0);

    const payload = updateRequestBodies[updateRequestBodies.length - 1];
    assert.true(Boolean(payload.cursor), "cursor payload sent");
    assert.strictEqual(
      typeof payload.cursor.start,
      "string",
      "cursor payload includes encoded start"
    );

    const sharedEditManager = this.container.lookup(
      "service:shared-edit-manager"
    );
    await waitUntil(() => sharedEditManager.doc);

    const decoded = window.Y.decodeRelativePosition(
      base64ToUint8Array(payload.cursor.start)
    );
    const absolute = window.Y.createAbsolutePositionFromRelativePosition(
      decoded,
      sharedEditManager.doc
    );

    assert.strictEqual(
      absolute.index,
      3,
      "serialized cursor reflects local selection"
    );
  });

  test("applies cursor metadata from remote updates", async function (assert) {
    updateRequestBodies.length = 0;

    await openSharedEditComposer();

    const sharedEditManager = this.container.lookup(
      "service:shared-edit-manager"
    );

    await waitUntil(
      () => window.Y && sharedEditManager.doc && sharedEditManager.cursorOverlay
    );

    const clonedDoc = new window.Y.Doc();
    const currentState = window.Y.encodeStateAsUpdate(sharedEditManager.doc);
    window.Y.applyUpdate(clonedDoc, currentState);
    const clonedText = clonedDoc.getText("post");
    const previousStateVector = window.Y.encodeStateVector(clonedDoc);

    const newContent = " remote insert";
    clonedText.insert(clonedText.toString().length, newContent);

    const updateDelta = window.Y.encodeStateAsUpdate(
      clonedDoc,
      previousStateVector
    );
    const cursorRelative = window.Y.createRelativePositionFromTypeIndex(
      clonedText,
      0,
      0
    );

    const cursorBase64 = uint8ArrayToBase64(
      window.Y.encodeRelativePosition(cursorRelative)
    );
    const updateBase64 = uint8ArrayToBase64(updateDelta);

    await publishToMessageBus("/shared_edits/398", {
      client_id: "remote-client-2",
      user_id: 456,
      user_name: "cursor-metadata",
      update: updateBase64,
      cursor: { start: cursorBase64 },
    });

    await waitUntil(() => {
      const overlayCursor =
        sharedEditManager.cursorOverlay?.cursors.get("remote-client-2");
      if (!overlayCursor) {
        return false;
      }

      const absolute = window.Y.createAbsolutePositionFromRelativePosition(
        overlayCursor.relativePosition,
        sharedEditManager.doc
      );
      return absolute && absolute.type === sharedEditManager.text;
    });

    const overlayCursor =
      sharedEditManager.cursorOverlay.cursors.get("remote-client-2");
    const absolute = window.Y.createAbsolutePositionFromRelativePosition(
      overlayCursor.relativePosition,
      sharedEditManager.doc
    );

    assert.strictEqual(
      absolute.index,
      0,
      "remote cursor respects transmitted relative position"
    );
  });
});
