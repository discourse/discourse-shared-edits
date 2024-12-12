import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { withPluginApi } from "discourse/lib/plugin-api";
import { SAVE_ICONS, SAVE_LABELS } from "discourse/models/composer";
import { withSilencedDeprecations } from "discourse-common/lib/deprecated";
import SharedEditButton from "../components/shared-edit-button";

const SHARED_EDIT_ACTION = "sharedEdit";

function replaceButton(buttons, find, replace) {
  const idx = buttons.indexOf(find);
  if (idx !== -1) {
    buttons[idx] = replace;
  }
}

function initWithApi(api) {
  SAVE_LABELS[SHARED_EDIT_ACTION] = "composer.save_edit";
  SAVE_ICONS[SHARED_EDIT_ACTION] = "pencil-alt";

  customizePostMenu(api);

  const currentUser = api.getCurrentUser();

  api.addPostAdminMenuButton((attrs) => {
    if (!currentUser?.staff && currentUser?.trust_level < 4) {
      return;
    }

    return {
      icon: "far-pen-to-square",
      className: "admin-toggle-shared-edits",
      label: attrs.shared_edits_enabled
        ? "shared_edits.disable_shared_edits"
        : "shared_edits.enable_shared_edits",
      action: async (post) => {
        const url = `/shared_edits/p/${post.id}/${
          post.shared_edits_enabled ? "disable" : "enable"
        }.json`;

        try {
          await ajax(url, { type: "PUT" });
          post.set("shared_edits_enabled", !post.shared_edits_enabled);
        } catch (e) {
          popupAjaxError(e);
        }
      },
    };
  });

  api.includePostAttributes("shared_edits_enabled");

  api.addPostClassesCallback((attrs) => {
    if (attrs.shared_edits_enabled && attrs.canEdit) {
      return ["shared-edits-post"];
    }
  });

  api.modifyClass(
    "component:scrolling-post-stream",
    (Superclass) =>
      class extends Superclass {
        sharedEdit() {
          this.appEvents.trigger("shared-edit-on-post");
        }
      }
  );

  api.modifyClass(
    "model:composer",
    (Superclass) =>
      class extends Superclass {
        get creatingSharedEdit() {
          return this.get("action") === SHARED_EDIT_ACTION;
        }

        get editingPost() {
          return super.editingPost || this.creatingSharedEdit;
        }
      }
  );

  api.modifyClass(
    "controller:topic",
    (Superclass) =>
      class extends Superclass {
        init() {
          super.init(...arguments);

          this.appEvents.on(
            "shared-edit-on-post",
            this,
            this._handleSharedEditOnPost
          );
        }

        willDestroy() {
          super.willDestroy(...arguments);
          this.appEvents.off(
            "shared-edit-on-post",
            this,
            this._handleSharedEditOnPost
          );
        }

        _handleSharedEditOnPost(post) {
          const draftKey = post.get("topic.draft_key");
          const draftSequence = post.get("topic.draft_sequence");

          this.get("composer").open({
            post,
            action: SHARED_EDIT_ACTION,
            draftKey,
            draftSequence,
          });
        }
      }
  );
}

function customizePostMenu(api) {
  const transformerRegistered = api.registerValueTransformer(
    "post-menu-buttons",
    ({ value: dag, context: { post, buttonLabels, buttonKeys } }) => {
      if (!post.shared_edits_enabled || !post.canEdit) {
        return;
      }

      dag.replace(buttonKeys.EDIT, SharedEditButton, {
        after: [buttonKeys.SHOW_MORE, buttonKeys.REPLY],
      });
      dag.reposition(buttonKeys.REPLY, {
        after: buttonKeys.SHOW_MORE,
        before: buttonKeys.EDIT,
      });

      buttonLabels.hide(buttonKeys.REPLY);
    }
  );

  if (transformerRegistered) {
    // register the property as tracked to ensure the button is correctly updated
    api.addTrackedPostProperty("shared_edits_enabled");
  }

  const silencedKey =
    transformerRegistered && "discourse.post-menu-widget-overrides";

  withSilencedDeprecations(silencedKey, () => customizeWidgetPostMenu(api));
}

function customizeWidgetPostMenu(api) {
  api.addPostMenuButton("sharedEdit", (post) => {
    if (!post.shared_edits_enabled || !post.canEdit) {
      return;
    }

    const result = {
      action: SHARED_EDIT_ACTION,
      icon: "far-pen-to-square",
      title: "shared_edits.button_title",
      className: "shared-edit create fade-out",
      position: "last",
    };

    if (!post.mobileView) {
      result.label = "shared_edits.edit";
    }

    return result;
  });

  api.removePostMenuButton("edit", (attrs) => {
    return attrs.shared_edits_enabled && attrs.canEdit;
  });

  api.removePostMenuButton("wiki-edit", (attrs) => {
    return attrs.shared_edits_enabled && attrs.canEdit;
  });

  api.reopenWidget("post-menu", {
    menuItems() {
      const result = this._super(...arguments);

      // wiki handles the reply button on its own. If not a wiki and is shared-edit
      // remove the label from the reply button.
      if (
        this.attrs.shared_edits_enabled &&
        this.attrs.canEdit &&
        !this.attrs.wiki
      ) {
        replaceButton(result, "reply", "reply-small");
      }

      return result;
    },

    sharedEdit() {
      SharedEditButton.sharedEdit(this.findAncestorModel(), this.appEvents);
    },
  });
}

export default {
  name: "discourse-shared-edits",
  initialize: (container) => {
    const siteSettings = container.lookup("service:site-settings");
    if (!siteSettings.shared_edits_enabled) {
      return;
    }

    withPluginApi("0.8.6", initWithApi);
  },
};
