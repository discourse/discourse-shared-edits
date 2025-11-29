import { click, visit, waitUntil } from "@ember/test-helpers";
import { test } from "qunit";
import {
  acceptance,
  publishToMessageBus,
} from "discourse/tests/helpers/qunit-helpers";

acceptance(`Discourse Shared Edits | Cursors & Selection`, function (needs) {
  needs.user();
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

    server.get("/shared_edits/p/:id", () =>
      helper.response({
        state: "",
        raw: "content",
        version: 1,
        message_bus_last_id: 0,
      })
    );

    server.put("/shared_edits/p/:id", () => helper.response({ success: "OK" }));
    server.put("/shared_edits/p/:id/selection", () =>
      helper.response({ success: "OK" })
    );
    server.put("/shared_edits/p/:id/commit", () =>
      helper.response({ success: "OK" })
    );
  });

  test("displays remote cursor when remote update is received", async function (assert) {
    await visit("/t/internationalization-localization/280");
    await click(".show-more-actions");
    await click(".show-post-admin-menu");
    await click(".admin-toggle-shared-edits");
    await click(".shared-edit");

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

    // Simulate remote message
    await publishToMessageBus("/shared_edits/398", {
      client_id: "remote-client-1",
      user_id: 123,
      user_name: "remoteuser",
      update: base64Update,
    });

    // The update should trigger the text observer -> CursorOverlay.updateCursor -> Render

    // Wait for UI update
    await waitUntil(() => document.querySelector(".shared-edits-cursor"));

    assert.dom(".shared-edits-cursor").exists("Remote cursor element created");
    assert
      .dom(".shared-edits-cursor__label")
      .hasText("remoteuser", "Cursor label shows username");
  });
});
