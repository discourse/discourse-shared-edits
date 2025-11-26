import { click, visit } from "@ember/test-helpers";
import { test } from "qunit";
import { acceptance } from "discourse/tests/helpers/qunit-helpers";

acceptance(`Discourse Shared Edits | Composer`, function (needs) {
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
        raw: "the latest iteration of the post",
        version: 2,
      })
    );

    server.put("/shared_edits/p/:id", () => helper.response({ success: "OK" }));

    server.put("/shared_edits/p/:id/commit", () =>
      helper.response({ success: "OK" })
    );
  });

  test("edit the first post", async function (assert) {
    await visit("/t/internationalization-localization/280");

    await click(".show-more-actions");
    await click(".show-post-admin-menu");
    await click(".admin-toggle-shared-edits");

    await click(".shared-edit");

    assert
      .dom(".d-editor-input")
      .hasValue(
        "the latest iteration of the post",
        "populates the input with the post text"
      );

    await click(".leave-shared-edit .btn-primary");
  });
});
