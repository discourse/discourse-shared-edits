import { click, visit } from "@ember/test-helpers";
import { test } from "qunit";
import { acceptance } from "discourse/tests/helpers/qunit-helpers";

// TODO (glimmer-post-menu) remove this file when the widget post menu code is removed from core
acceptance(
  "Discourse Shared Edits | Composer | Widget post menu",
  function (needs) {
    needs.user();

    needs.settings({
      glimmer_post_menu_mode: "disabled",
    });

    needs.pretender((server, helper) => {
      server.put("/shared_edits/p/398/enable.json", () =>
        helper.response({ success: "OK" })
      );

      server.get("/shared_edits/p/398", () =>
        helper.response({ raw: "the latest iteration of the post", version: 2 })
      );

      server.put("/shared_edits/p/398/commit", () =>
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
  }
);