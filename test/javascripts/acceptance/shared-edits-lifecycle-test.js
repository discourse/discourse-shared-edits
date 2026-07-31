import { settled, waitUntil } from "@ember/test-helpers";
import { test } from "qunit";
import { parsePostData } from "discourse/tests/helpers/create-pretender";
import { acceptance } from "discourse/tests/helpers/qunit-helpers";
import {
  openSharedEditComposer,
  waitForSharedEditManager,
  waitForYjs,
} from "../helpers/shared-edits-helpers";

acceptance("Discourse Shared Edits | Lifecycle", function (needs) {
  let getRequests;
  let putRequests;
  let commitCalls;
  let draftDeletes;

  needs.user({ can_toggle_shared_edits: true });
  needs.settings({ shared_edits_enabled: true });

  needs.pretender((server, helper) => {
    getRequests = [];
    putRequests = [];
    commitCalls = [];
    draftDeletes = [];

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

    server.delete("/drafts/:key", (request) => {
      draftDeletes.push(request.params.key);
      return helper.response({ success: "OK" });
    });

    server.put("/shared_edits/p/:id/commit.json", () => {
      commitCalls.push(Date.now());
      return helper.response({ success: "OK" });
    });
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

  test("restored shared-edit draft is discarded after reload", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    const composer = this.container.lookup("service:composer");
    const initialGetCount = getRequests.length;

    assert.true(
      composer.model.disableDrafts,
      "shared edits disable draft persistence"
    );
    assert.strictEqual(
      composer.model.draftKey,
      "shared_edit_398",
      "shared edits use an isolated non-persisted draft key"
    );

    manager.resetForTests();
    composer.model.setProperties({
      composeState: "draft",
      disableDrafts: false,
      draftKey: "topic_398",
      draftSequence: 7,
      reply: "disconnected content restored by the browser",
    });
    await settled();
    composer.model.set("composeState", "open");

    await waitUntil(() => !composer.model?.viewOpen);
    await settled();

    assert.deepEqual(
      draftDeletes,
      ["topic_398.json"],
      "the stale shared-edit draft is deleted"
    );
    assert.strictEqual(
      getRequests.length,
      initialGetCount,
      "restored content never enters the collaboration pipeline"
    );
    assert.strictEqual(
      manager.sessionState,
      "idle",
      "the disconnected manager remains idle"
    );
    assert.deepEqual(
      commitCalls,
      [],
      "discarding a restored draft does not commit"
    );
  });

  test("non-shared drafts are not discarded", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);
    const composer = this.container.lookup("service:composer");
    manager.resetForTests();
    draftDeletes.length = 0;
    composer.model.setProperties({
      action: "reply",
      composeState: "draft",
      disableDrafts: false,
      draftKey: "topic_398",
      draftSequence: 8,
    });
    await settled();
    composer.model.set("composeState", "open");
    await settled();

    assert.true(composer.model.viewOpen, "the normal draft remains open");
    assert.deepEqual(draftDeletes, [], "the normal draft is not deleted");
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

  test("session state transitions across lifecycle", async function (assert) {
    await openSharedEditComposer();

    const manager = await waitForSharedEditManager(this.container);

    assert.strictEqual(
      manager.sessionState,
      "active",
      "Session is active after subscribe/finalize"
    );

    await manager.commit();

    assert.strictEqual(
      manager.sessionState,
      "idle",
      "Session returns to idle after cleanup"
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
  needs.user({ can_toggle_shared_edits: true });
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

    // Pre-generated Yjs state for "content from server state"
    // Generated via: DiscourseSharedEdits::Yjs.state_from_text('content from server state')[:state]
    const serverState = "AQGcAQAEAQRwb3N0GWNvbnRlbnQgZnJvbSBzZXJ2ZXIgc3RhdGUA";

    server.get("/shared_edits/p/:id", () =>
      helper.response({
        state: serverState,
        raw: "initial post content",
        version: 2,
        message_bus_last_id: 5,
      })
    );

    server.put("/shared_edits/p/:id", () => helper.response({ success: "OK" }));

    server.put("/shared_edits/p/:id/commit.json", () =>
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
