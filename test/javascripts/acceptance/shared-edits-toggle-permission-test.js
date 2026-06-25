import { click, visit } from "@ember/test-helpers";
import { test } from "qunit";
import { acceptance } from "discourse/tests/helpers/qunit-helpers";

acceptance("Discourse Shared Edits | Toggle permissions", function (needs) {
  needs.user({ can_toggle_shared_edits: false });
  needs.settings({ shared_edits_enabled: true });

  test("hides the post admin toggle action", async function (assert) {
    await visit("/t/internationalization-localization/280");
    await click(".show-more-actions");
    await click(".show-post-admin-menu");

    assert
      .dom(".admin-toggle-shared-edits")
      .doesNotExist("the shared edits toggle action is hidden");
  });
});
