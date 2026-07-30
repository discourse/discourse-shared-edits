import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import { base64ToUint8Array } from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/encoding-utils";
import NetworkManager from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/network-manager";
import { SHARED_EDITS_ERRORS } from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/protocol";
import { ensureYjsLoaded } from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/yjs-document";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

module("Unit | Lib | shared-edits | network-manager", function (hooks) {
  setupTest(hooks);

  test("recovers corrupted state explicitly before refetching", async function (assert) {
    const requests = [];
    const recoveredState = {
      document_version: "replacement-document",
      message_bus_last_id: 42,
      state: "encoded-state",
      version: 2,
    };
    const request = (url, options) => {
      requests.push({ options, url });
      if (requests.length === 1) {
        return Promise.reject({
          jqXHR: {
            responseJSON: { error: SHARED_EDITS_ERRORS.NEEDS_RECOVERY_TEXT },
            status: 409,
          },
        });
      }
      return Promise.resolve(
        requests.length === 2 ? { success: "OK" } : recoveredState
      );
    };
    const manager = new NetworkManager(this, {
      getRecoveryText: () => "local composer text",
      request,
    });

    const result = await manager.fetchState(123);

    assert.strictEqual(
      result,
      recoveredState,
      "the recovered server state is returned"
    );
    assert.strictEqual(
      requests.length,
      3,
      "state is fetched again after recovery"
    );
    assert.strictEqual(
      requests[1].options.method,
      "PUT",
      "recovery is an explicit write"
    );
    assert.strictEqual(
      requests[1].options.data.recovery_text,
      "local composer text",
      "local text is supplied for recovery"
    );
    assert.strictEqual(manager.documentVersion, "replacement-document");
    manager.teardown();
  });

  test("sends cursor presence without a document update", async function (assert) {
    const requests = [];
    const manager = new NetworkManager(this.owner, {
      request: (url, options) => {
        requests.push({ options, url });
        return Promise.resolve({ success: "OK" });
      },
    });
    const cursor = { direction: "backward", end: "end", start: "start" };

    manager.queueCursorUpdate(cursor);
    await manager.sendUpdates(1, { getClientId: () => "client-1" });

    assert.deepEqual(requests[0].options.data.cursor, cursor, "cursor is sent");
    assert.false(
      Object.hasOwn(requests[0].options.data, "update"),
      "no document update is required"
    );
    manager.teardown();
  });

  test("cursor presence does not consume document state-vector recovery", async function (assert) {
    const requests = [];
    const manager = new NetworkManager(this.owner, {
      request: (url, options) => {
        requests.push({ options, url });
        return Promise.resolve({ success: "OK" });
      },
    });
    manager.skipNextStateVector = true;
    manager.queueCursorUpdate({ start: "cursor" });

    await manager.sendUpdates(1, { getClientId: () => "client-1" });

    assert.true(
      manager.skipNextStateVector,
      "cursor-only success preserves the document recovery flag"
    );
    manager.pendingUpdates.push(new Uint8Array([1]));
    await manager.sendUpdates(1, { getClientId: () => "client-1" });
    assert.false(
      manager.skipNextStateVector,
      "a document update consumes the recovery flag"
    );
    assert.false(
      Object.hasOwn(requests[1].options.data, "state_vector"),
      "the recovery document update omits its state vector"
    );
    manager.teardown();
  });

  test("discarding pending work cancels a queued send", async function (assert) {
    const requests = [];
    const manager = new NetworkManager(this.owner, {
      request: (url, options) => {
        requests.push({ options, url });
        return Promise.resolve({ success: "OK" });
      },
    });
    manager.pendingUpdates.push(new Uint8Array([1]));

    const send = manager.sendUpdates(1, { getClientId: () => "client-1" });
    manager.discardPendingUpdates();
    const result = await send;

    assert.true(result.discarded, "the stale batch is discarded");
    assert.deepEqual(requests, [], "no request is sent after invalidation");
    manager.teardown();
  });

  test("preserves updates queued while an earlier request is in flight", async function (assert) {
    const Y = await ensureYjsLoaded();
    const clientDoc = new Y.Doc();
    const clientText = clientDoc.getText("post");
    const createUpdate = (value) => {
      const stateVector = Y.encodeStateVector(clientDoc);
      clientText.insert(clientText.length, value);
      return Y.encodeStateAsUpdate(clientDoc, stateVector);
    };
    const updateA = createUpdate("A");
    const updateB = createUpdate("B");
    const updateC = createUpdate("C");
    const firstRequest = deferred();
    const requests = [];
    const request = (url, options) => {
      requests.push({ options, url });
      return requests.length === 1
        ? firstRequest.promise
        : Promise.resolve({ success: "OK" });
    };
    const manager = new NetworkManager(this.owner, { request });
    const options = { getClientId: () => "client-1" };

    manager.pendingUpdates.push(updateA);
    const sendA = manager.sendUpdates(1, options);
    while (requests.length === 0) {
      await Promise.resolve();
    }

    manager.pendingUpdates.push(updateB);
    const sendB = manager.sendUpdates(1, options);
    manager.pendingUpdates.push(updateC);

    firstRequest.resolve({ success: "OK" });
    await Promise.all([sendA, sendB]);

    const serverDoc = new Y.Doc();
    requests.forEach(({ options: requestOptions }) => {
      Y.applyUpdate(serverDoc, base64ToUint8Array(requestOptions.data.update));
    });

    assert.strictEqual(
      requests.length,
      2,
      "queued updates share the next request"
    );
    assert.strictEqual(
      serverDoc.getText("post").toString(),
      "ABC",
      "every queued operation reaches the server"
    );
    assert.deepEqual(manager.pendingUpdates, [], "the sent queue is empty");
    serverDoc.destroy();
    clientDoc.destroy();
    manager.teardown();
  });
});
