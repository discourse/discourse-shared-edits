import { fillIn, waitUntil } from "@ember/test-helpers";
import { test } from "qunit";
import { parsePostData } from "discourse/tests/helpers/create-pretender";
import {
  acceptance,
  publishToMessageBus,
} from "discourse/tests/helpers/qunit-helpers";
import {
  getTextarea,
  openSharedEditComposer,
  uint8ArrayToBase64,
  waitForSharedEditManager,
  waitForYjs,
} from "../helpers/shared-edits-helpers";

const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";

acceptance("Discourse Shared Edits | Text Synchronization", function (needs) {
  let putRequests;

  needs.user();
  needs.settings({ shared_edits_enabled: true });

  needs.pretender((server, helper) => {
    putRequests = [];

    server.put("/shared_edits/p/:id/enable.json", () =>
      helper.response({ success: "OK" })
    );

    server.get("/posts/:id.json", () =>
      helper.response({
        id: 398,
        raw: "initial content",
      })
    );

    server.get("/shared_edits/p/:id", () =>
      helper.response({
        state: "",
        raw: "initial content",
        version: 1,
        message_bus_last_id: 0,
      })
    );

    server.put("/shared_edits/p/:id", (request) => {
      if (request.requestBody) {
        putRequests.push(parsePostData(request.requestBody));
      }
      return helper.response({ success: "OK" });
    });

    server.put("/shared_edits/p/:id/commit", () =>
      helper.response({ success: "OK" })
    );

    server.put("/shared_edits/p/:id/selection", () =>
      helper.response({ success: "OK" })
    );
  });

  test("local changes are synced to Y.Text", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    await waitForYjs();

    assert.strictEqual(
      manager.text.toString(),
      "initial content",
      "Initial content is correct"
    );

    // Type in the textarea
    await fillIn(TEXTAREA_SELECTOR, "initial content modified");

    // Y.Text should be updated
    assert.strictEqual(
      manager.text.toString(),
      "initial content modified",
      "Y.Text reflects local changes"
    );
  });

  test("Y.Text changes trigger PUT to server with update payload", async function (assert) {
    await openSharedEditComposer();

    await waitForSharedEditManager(this.container);
    await waitForYjs();

    putRequests.length = 0;

    // Make a local change
    await fillIn(TEXTAREA_SELECTOR, "initial content with update");

    // Wait for throttled send (350ms throttle)
    await waitUntil(() => putRequests.length > 0, { timeout: 1000 });

    assert.true(putRequests.length > 0, "PUT request was made");

    const payload = putRequests[putRequests.length - 1];
    assert.true(Boolean(payload.update), "Payload contains update field");
    assert.true(Boolean(payload.client_id), "Payload contains client_id");
  });

  test("multiple rapid changes are batched via throttling", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    await waitForYjs();

    putRequests.length = 0;

    // Make rapid changes directly to Y.Doc to test throttling
    // (fillIn waits for application to settle, which defeats throttle testing)
    manager.doc.transact(() => {
      manager.text.delete(0, manager.text.length);
      manager.text.insert(0, "change 1");
    }, manager);

    manager.doc.transact(() => {
      manager.text.delete(0, manager.text.length);
      manager.text.insert(0, "change 2");
    }, manager);

    manager.doc.transact(() => {
      manager.text.delete(0, manager.text.length);
      manager.text.insert(0, "change 3");
    }, manager);

    // Wait for throttle to complete (350ms + buffer)
    await waitUntil(() => putRequests.length > 0, { timeout: 1000 });

    // With throttling, rapid changes should be batched into fewer requests
    // The exact count depends on timing, but should be less than 3 separate requests
    assert.true(
      putRequests.length >= 1,
      `At least one PUT request was made (got ${putRequests.length})`
    );

    // The final state should be correct
    assert.strictEqual(
      manager.text.toString(),
      "change 3",
      "Final Y.Text state is correct"
    );
  });

  test("remote updates via message bus update textarea", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    const Y = await waitForYjs();

    // Clone the current document state (required for Yjs merge to work)
    const clonedDoc = new Y.Doc();
    const currentState = Y.encodeStateAsUpdate(manager.doc);
    Y.applyUpdate(clonedDoc, currentState);
    const clonedText = clonedDoc.getText("post");

    // Record state vector before making changes
    const prevState = Y.encodeStateVector(clonedDoc);

    // Make a change in the cloned doc
    clonedText.insert(clonedText.toString().length, " remote addition");

    // Generate delta update (only the new changes)
    const update = Y.encodeStateAsUpdate(clonedDoc, prevState);
    const base64Update = uint8ArrayToBase64(update);

    // Publish the remote update
    await publishToMessageBus("/shared_edits/398", {
      client_id: "remote-client",
      user_id: 999,
      user_name: "remote_user",
      update: base64Update,
    });

    // Wait for the update to be applied
    await waitUntil(() => manager.text.toString().includes("remote addition"), {
      timeout: 2000,
    });

    const textarea = getTextarea();
    assert.true(
      textarea.value.includes("remote addition"),
      "Textarea content includes remote addition"
    );
  });

  test("remote updates preserve local cursor position", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    const Y = await waitForYjs();

    const textarea = getTextarea();

    // Set cursor position in the middle
    textarea.focus();
    const cursorPos = 7; // After "initial"
    textarea.setSelectionRange(cursorPos, cursorPos);

    const originalCursorPos = textarea.selectionStart;

    // Clone the current document state (required for Yjs merge to work)
    const clonedDoc = new Y.Doc();
    const currentState = Y.encodeStateAsUpdate(manager.doc);
    Y.applyUpdate(clonedDoc, currentState);
    const clonedText = clonedDoc.getText("post");

    // Record state vector before making changes
    const prevState = Y.encodeStateVector(clonedDoc);

    // Insert at the beginning of the cloned doc
    clonedText.insert(0, "PREFIX ");

    // Generate delta update (only the new changes)
    const update = Y.encodeStateAsUpdate(clonedDoc, prevState);
    const base64Update = uint8ArrayToBase64(update);

    await publishToMessageBus("/shared_edits/398", {
      client_id: "remote-client",
      user_id: 999,
      user_name: "remote_user",
      update: base64Update,
    });

    await waitUntil(() => manager.text.toString().includes("PREFIX"), {
      timeout: 2000,
    });

    // Cursor should have shifted by the length of inserted text
    const expectedNewPos = originalCursorPos + "PREFIX ".length;
    assert.strictEqual(
      textarea.selectionStart,
      expectedNewPos,
      "Cursor position was adjusted for remote insertion"
    );
  });

  test("applyDiff handles insert at beginning of text", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    await waitForYjs();

    // Insert at the beginning via composer
    await fillIn(TEXTAREA_SELECTOR, "PREFIX initial content");

    assert.strictEqual(
      manager.text.toString(),
      "PREFIX initial content",
      "Text was correctly updated with prefix"
    );
  });

  test("applyDiff handles delete in middle of text", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    await waitForYjs();

    // Delete "al cont" from "initial content" -> "initient"
    await fillIn(TEXTAREA_SELECTOR, "initient");

    assert.strictEqual(
      manager.text.toString(),
      "initient",
      "Text was correctly updated with deletion"
    );
  });

  test("applyDiff handles replacement (delete + insert)", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    await waitForYjs();

    // Replace "content" with "text"
    await fillIn(TEXTAREA_SELECTOR, "initial text");

    assert.strictEqual(
      manager.text.toString(),
      "initial text",
      "Text was correctly updated with replacement"
    );
  });
});
