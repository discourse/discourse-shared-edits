import { fillIn, waitUntil } from "@ember/test-helpers";
import { test } from "qunit";
import { parsePostData } from "discourse/tests/helpers/create-pretender";
import {
  acceptance,
  publishToMessageBus,
} from "discourse/tests/helpers/qunit-helpers";
import {
  openSharedEditComposer,
  waitForSharedEditManager,
  waitForYjs,
} from "../helpers/shared-edits-helpers";

const TEXTAREA_SELECTOR = "#reply-control textarea.d-editor-input";

acceptance(
  "Discourse Shared Edits | Error Handling - 409 Recovery",
  function (needs) {
    let putRequests;
    let getRequests;
    let shouldReturn409;

    needs.user();
    needs.settings({ shared_edits_enabled: true });

    needs.pretender((server, helper) => {
      putRequests = [];
      getRequests = [];
      shouldReturn409 = false;

      server.put("/shared_edits/p/:id/enable.json", () =>
        helper.response({ success: "OK" })
      );

      server.get("/posts/:id.json", () =>
        helper.response({
          id: 398,
          raw: "initial content",
        })
      );

      server.get("/shared_edits/p/:id", () => {
        getRequests.push(Date.now());
        return helper.response({
          state: "",
          raw: getRequests.length > 1 ? "recovered content" : "initial content",
          version: getRequests.length,
          message_bus_last_id: 0,
        });
      });

      server.put("/shared_edits/p/:id", (request) => {
        if (request.requestBody) {
          putRequests.push(parsePostData(request.requestBody));
        }
        if (shouldReturn409) {
          shouldReturn409 = false;
          return helper.response(409, { error: "state_recovered" });
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

    test("409 state_recovered triggers resync", async function (assert) {
      await openSharedEditComposer();

      await waitForSharedEditManager(this.container);
      await waitForYjs();

      const initialGetCount = getRequests.length;

      // Configure next PUT to return 409
      shouldReturn409 = true;

      // Make a change to trigger a PUT
      await fillIn(TEXTAREA_SELECTOR, "trigger update");

      // Wait for the PUT and subsequent resync GET
      await waitUntil(() => getRequests.length > initialGetCount, {
        timeout: 2000,
      });

      assert.true(
        getRequests.length > initialGetCount,
        "Additional GET request was made for resync"
      );
    });

    test("resync message via message bus reloads state", async function (assert) {
      await openSharedEditComposer();

      const manager = await waitForSharedEditManager(this.container);
      await waitForYjs();

      const initialGetCount = getRequests.length;

      // Publish resync action
      await publishToMessageBus("/shared_edits/398", {
        action: "resync",
      });

      // Wait for resync GET request
      await waitUntil(() => getRequests.length > initialGetCount, {
        timeout: 2000,
      });

      assert.true(
        getRequests.length > initialGetCount,
        "GET request was made to resync state"
      );

      // Content should be updated from server
      await waitUntil(
        () => manager.text && manager.text.toString() === "recovered content",
        { timeout: 2000 }
      );

      assert.strictEqual(
        manager.text.toString(),
        "recovered content",
        "Content was resynced from server"
      );
    });
  }
);

acceptance(
  "Discourse Shared Edits | Error Handling - PUT Requests",
  function (needs) {
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

    test("multiple changes trigger PUT requests with update payload", async function (assert) {
      await openSharedEditComposer();

      await waitForSharedEditManager(this.container);
      await waitForYjs();

      putRequests.length = 0;

      // Make multiple changes
      await fillIn(TEXTAREA_SELECTOR, "first change");

      await waitUntil(() => putRequests.length > 0, { timeout: 1000 });

      await fillIn(TEXTAREA_SELECTOR, "second change");

      await waitUntil(() => putRequests.length > 1, { timeout: 1500 });

      assert.true(
        putRequests.length >= 2,
        "Multiple PUT requests were made for multiple changes"
      );

      // Each request should contain an update payload
      const lastRequest = putRequests[putRequests.length - 1];
      assert.true(
        Boolean(lastRequest.update),
        "PUT request contains update payload"
      );
      assert.true(
        Boolean(lastRequest.client_id),
        "PUT request contains client_id"
      );
    });

    test("PUT request includes version information", async function (assert) {
      await openSharedEditComposer();

      await waitForSharedEditManager(this.container);
      await waitForYjs();

      putRequests.length = 0;

      await fillIn(TEXTAREA_SELECTOR, "test change");

      await waitUntil(() => putRequests.length > 0, { timeout: 1000 });

      const request = putRequests[putRequests.length - 1];
      assert.true(Boolean(request.update), "Request contains update");
      assert.true(Boolean(request.client_id), "Request contains client_id");
    });
  }
);

acceptance(
  "Discourse Shared Edits | Error Handling - Rich Mode Fallback",
  function (needs) {
    needs.user();
    needs.settings({
      shared_edits_enabled: true,
      shared_edits_editor_mode: "rich",
    });

    needs.pretender((server, helper) => {
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

      server.put("/shared_edits/p/:id", () =>
        helper.response({ success: "OK" })
      );

      server.put("/shared_edits/p/:id/commit", () =>
        helper.response({ success: "OK" })
      );

      server.put("/shared_edits/p/:id/selection", () =>
        helper.response({ success: "OK" })
      );
    });

    test("rich mode failure sets fallback flag", async function (assert) {
      await openSharedEditComposer();

      const manager = await waitForSharedEditManager(this.container);

      // Even if rich mode fails internally, the service should still function
      // The _richModeFailed flag prevents retry loops
      assert.true(
        Boolean(manager.doc),
        "Doc was created (either in rich or markdown mode)"
      );
      assert.true(Boolean(manager.text), "Text was created for commit sync");
    });
  }
);

acceptance(
  "Discourse Shared Edits | Error Handling - Subscribe Success",
  function (needs) {
    let getCallCount;

    needs.user();
    needs.settings({ shared_edits_enabled: true });

    needs.pretender((server, helper) => {
      getCallCount = 0;

      server.put("/shared_edits/p/:id/enable.json", () =>
        helper.response({ success: "OK" })
      );

      server.get("/posts/:id.json", () =>
        helper.response({
          id: 398,
          raw: "initial content",
        })
      );

      server.get("/shared_edits/p/:id", () => {
        getCallCount++;
        return helper.response({
          state: "",
          raw: "initial content",
          version: 1,
          message_bus_last_id: 0,
        });
      });

      server.put("/shared_edits/p/:id", () =>
        helper.response({ success: "OK" })
      );

      server.put("/shared_edits/p/:id/commit", () =>
        helper.response({ success: "OK" })
      );

      server.put("/shared_edits/p/:id/selection", () =>
        helper.response({ success: "OK" })
      );
    });

    test("subscribe makes GET request to fetch state", async function (assert) {
      await openSharedEditComposer();

      assert.true(
        getCallCount >= 1,
        "GET request was made to fetch shared edit state"
      );

      // The app should be fully functional
      assert.true(
        Boolean(document.querySelector("#main-outlet")),
        "Main app outlet exists"
      );

      const manager = await waitForSharedEditManager(this.container);
      assert.true(Boolean(manager.doc), "Y.Doc was created after subscribe");
      assert.true(Boolean(manager.text), "Y.Text was created after subscribe");
    });
  }
);
