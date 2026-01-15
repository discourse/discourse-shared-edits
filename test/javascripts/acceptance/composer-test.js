import { click, visit, waitUntil } from "@ember/test-helpers";
import { test } from "qunit";
import { acceptance } from "discourse/tests/helpers/qunit-helpers";

acceptance(`Discourse Shared Edits | Composer`, function (needs) {
  let commitCalls;

  needs.user();

  needs.pretender((server, helper) => {
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

    server.get("/shared_edits/p/:id", () =>
      helper.response({
        state: "",
        raw: "the latest iteration of the post",
        version: 2,
        message_bus_last_id: 0,
      })
    );

    server.put("/shared_edits/p/:id", () => helper.response({ success: "OK" }));

    server.put("/shared_edits/p/:id/commit", () => {
      commitCalls.push(Date.now());
      return helper.response({ success: "OK" });
    });

    server.put("/shared_edits/p/:id/selection", () =>
      helper.response({ success: "OK" })
    );
  });

  async function openSharedEdit() {
    await visit("/t/internationalization-localization/280");
    await click(".show-more-actions");
    await click(".show-post-admin-menu");
    await click(".admin-toggle-shared-edits");
    await click(".shared-edit");
  }

  test("edit the first post", async function (assert) {
    await openSharedEdit();

    assert
      .dom(".d-editor-input")
      .hasValue(
        "the latest iteration of the post",
        "populates the input with the post text"
      );

    await click(".leave-shared-edit .btn-primary");
  });

  test("Done button commits and closes composer", async function (assert) {
    commitCalls.length = 0;

    await openSharedEdit();

    assert.dom("#reply-control.open").exists("Composer is open");

    await click(".leave-shared-edit .btn-primary");

    // Wait for commit to complete
    await waitUntil(() => commitCalls.length > 0, { timeout: 2000 });

    assert.strictEqual(commitCalls.length, 1, "Commit was called once");
    assert
      .dom("#reply-control.open")
      .doesNotExist("Composer is closed after Done");
  });

  test("creatingSharedEdit flag is set correctly", async function (assert) {
    await openSharedEdit();

    const composer = this.container.lookup("service:composer");

    assert.true(
      composer.model?.creatingSharedEdit,
      "creatingSharedEdit is true when in shared edit mode"
    );

    await click(".leave-shared-edit .btn-primary");
  });

  test("composer shows Done button in shared edit mode", async function (assert) {
    await openSharedEdit();

    assert
      .dom(".leave-shared-edit .btn-primary")
      .exists("Done button is visible");
    assert
      .dom(".leave-shared-edit .btn-primary")
      .hasText(/Done/i, "Button says Done");

    await click(".leave-shared-edit .btn-primary");
  });
});
