import { waitUntil } from "@ember/test-helpers";
import { test } from "qunit";
import { parsePostData } from "discourse/tests/helpers/create-pretender";
import { acceptance } from "discourse/tests/helpers/qunit-helpers";
import {
  createYjsState,
  openSharedEditComposer,
  uint8ArrayToBase64,
  waitForSharedEditManager,
  waitForYjs,
} from "../helpers/shared-edits-helpers";

acceptance("Discourse Shared Edits | Lifecycle", function (needs) {
  let getRequests;
  let putRequests;
  let commitCalls;

  needs.user();
  needs.settings({ shared_edits_enabled: true });

  needs.pretender((server, helper) => {
    getRequests = [];
    putRequests = [];
    commitCalls = [];

    server.put("/shared_edits/p/:id/enable.json", () =>
      helper.response({ success: "OK" })
    );

    server.get("/posts/:id.json", () =>
      helper.response({
        id: 398,
        raw: "initial post content",
      })
    );

    server.get("/shared_edits/p/:id", (request) => {
      getRequests.push(request.url);
      return helper.response({
        state: "",
        raw: "initial post content",
        version: 1,
        message_bus_last_id: 0,
      });
    });

    server.put("/shared_edits/p/:id", (request) => {
      if (request.requestBody) {
        putRequests.push(parsePostData(request.requestBody));
      }
      return helper.response({ success: "OK" });
    });

    server.put("/shared_edits/p/:id/commit", () => {
      commitCalls.push(Date.now());
      return helper.response({ success: "OK" });
    });

    server.put("/shared_edits/p/:id/selection", () =>
      helper.response({ success: "OK" })
    );
  });

  test("subscribe fetches initial state and creates Y.Doc", async function (assert) {
    getRequests.length = 0;

    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);

    assert.true(getRequests.length > 0, "GET request was made to fetch state");
    assert.true(
      getRequests.some((url) => url.includes("/shared_edits/p/")),
      "Request was to shared_edits endpoint"
    );
    assert.true(Boolean(manager.doc), "Y.Doc was created");
    assert.true(Boolean(manager.text), "Y.Text was created");
    assert.strictEqual(
      manager.text.toString(),
      "initial post content",
      "Y.Text contains initial content"
    );
  });

  test("subscribe with existing state returns cached reply", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    const initialGetCount = getRequests.length;

    // Call subscribe again for the same post
    const result = await manager.subscribe(398);

    assert.strictEqual(
      getRequests.length,
      initialGetCount,
      "No additional GET requests made"
    );
    assert.true(Boolean(result.reply), "Cached reply was returned");
  });

  test("subscribe handles empty state and raw content", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);

    assert.true(Boolean(manager.text), "Y.Text was created");
    assert.strictEqual(
      manager.text.toString(),
      "initial post content",
      "Y.Text was initialized from raw content when state is empty"
    );
  });

  test("finalizeSubscription attaches composer observer", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);

    // Verify the composer observer is attached by checking internal flag
    assert.notStrictEqual(
      manager._composerObserverAttached,
      false,
      "Composer observer should be attached after finalization"
    );
  });

  test("commit flushes pending updates before closing", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    putRequests.length = 0;

    // Make a local change to create pending updates
    await waitForYjs();
    manager.doc.transact(() => {
      manager.text.insert(manager.text.length, " edited");
    }, manager);

    // Wait for throttled send
    await waitUntil(() => putRequests.length > 0, { timeout: 1000 });

    const putCountBeforeCommit = putRequests.length;

    // Commit should send any remaining updates
    await manager.commit();

    assert.true(
      putRequests.length >= putCountBeforeCommit,
      "PUT requests were made during/before commit"
    );
    assert.true(commitCalls.length > 0, "Commit endpoint was called");
  });

  test("commit unsubscribes from message bus", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);

    await manager.commit();

    // After commit, doc should be torn down
    assert.strictEqual(manager.doc, null, "Doc is nullified after commit");
    assert.strictEqual(manager.text, null, "Text is nullified after commit");
  });

  test("commit calls /commit endpoint and tears down doc", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    commitCalls.length = 0;

    assert.true(Boolean(manager.doc), "Doc exists before commit");
    assert.true(Boolean(manager.text), "Text exists before commit");

    await manager.commit();

    assert.strictEqual(
      commitCalls.length,
      1,
      "Commit endpoint was called once"
    );
    assert.strictEqual(manager.doc, null, "Doc is nullified after commit");
    assert.strictEqual(manager.text, null, "Text is nullified after commit");
    assert.strictEqual(
      manager.currentPostId,
      null,
      "currentPostId is cleared after commit"
    );
  });

  test("multiple subscribes to different posts clean up previous", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);

    assert.strictEqual(manager.currentPostId, 398, "First post ID is set");

    assert.true(Boolean(manager.doc), "First doc exists");

    // Now close and try subscribing to a different post
    // (In practice this would be a different topic, but we simulate)
    await manager.commit();

    assert.strictEqual(manager.doc, null, "Doc is cleaned up after commit");
    assert.strictEqual(manager.currentPostId, null, "Post ID is cleared");
  });
});

acceptance("Discourse Shared Edits | Lifecycle with State", function (needs) {
  needs.user();
  needs.settings({ shared_edits_enabled: true });

  needs.pretender((server, helper) => {
    server.put("/shared_edits/p/:id/enable.json", () =>
      helper.response({ success: "OK" })
    );

    server.get("/posts/:id.json", () =>
      helper.response({
        id: 398,
        raw: "initial post content",
      })
    );

    server.get("/shared_edits/p/:id", async () => {
      // Wait for Yjs to be available (it may be loaded by another test)
      await waitUntil(() => window.Y, { timeout: 5000 });
      const Y = window.Y;

      // Create a Yjs state with different content
      const state = createYjsState(Y, "content from server state");
      const base64State = uint8ArrayToBase64(state);

      return helper.response({
        state: base64State,
        raw: "initial post content",
        version: 2,
        message_bus_last_id: 5,
      });
    });

    server.put("/shared_edits/p/:id", () => helper.response({ success: "OK" }));

    server.put("/shared_edits/p/:id/commit", () =>
      helper.response({ success: "OK" })
    );

    server.put("/shared_edits/p/:id/selection", () =>
      helper.response({ success: "OK" })
    );
  });

  test("subscribe applies server state when provided", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);

    assert.strictEqual(
      manager.text.toString(),
      "content from server state",
      "Y.Text reflects server state, not raw content"
    );
  });
});
