import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { withPluginApi } from "discourse/lib/plugin-api";
import { SAVE_ICONS, SAVE_LABELS } from "discourse/models/composer";

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

  const currentUser = api.getCurrentUser();

  if (api.addPostAdminMenuButton) {
    api.addPostAdminMenuButton((attrs) => {
      if (!currentUser?.staff && currentUser?.trust_level < 4) {
        return;
      }

      return {
        icon: "far-edit",
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
  } else {
    api.reopenWidget("post-admin-menu", {
      html(attrs) {
        const contents = this._super(...arguments);

        if (!this.currentUser.staff || !contents.children) {
          return contents;
        }

        contents.children.push(
          this.attach("post-admin-menu-button", {
            action: "toggleSharedEdit",
            icon: "far-edit",
            className: "admin-toggle-shared-edits",
            label: attrs.shared_edits_enabled
              ? "shared_edits.disable_shared_edits"
              : "shared_edits.enable_shared_edits",
          })
        );

        return contents;
      },

      async toggleSharedEdit() {
        const post = this.findAncestorModel();

        try {
          await ajax(
            `/shared_edits/p/${post.id}/${
              post.shared_edits_enabled ? "disable" : "enable"
            }.json`,
            { type: "PUT" }
          );
          post.set("shared_edits_enabled", !post.shared_edits_enabled);
          this.scheduleRerender();
        } catch (e) {
          popupAjaxError(e);
        }
      },
    });
  }

  api.includePostAttributes("shared_edits_enabled");

  api.addPostClassesCallback((attrs) => {
    if (attrs.shared_edits_enabled && attrs.canEdit) {
      return ["shared-edits-post"];
    }
  });

  api.addPostMenuButton("sharedEdit", (post) => {
    if (!post.shared_edits_enabled || !post.canEdit) {
      return;
    }

    const result = {
      action: SHARED_EDIT_ACTION,
      icon: "far-edit",
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
      const post = this.findAncestorModel();
      this.appEvents.trigger("shared-edit-on-post", post);
    },
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
    "component:composer-editor",
    (Superclass) =>
      class extends Superclass {
        keyDown() {
          super.keyDown?.(...arguments);
          if (this.composer.action === SHARED_EDIT_ACTION) {
            this.composer.set("lastKeyPress", Date.now());
          }
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
