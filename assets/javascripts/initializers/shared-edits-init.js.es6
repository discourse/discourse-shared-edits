import { withPluginApi } from "discourse/lib/plugin-api";
import discourseComputed, {
  on,
  observes,
} from "discourse-common/utils/decorators";
import {
  setupSharedEdit,
  teardownSharedEdit,
  performSharedEdit,
} from "../lib/shared-edits";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { computed } from "@ember/object";
import { SAVE_LABELS, SAVE_ICONS } from "discourse/models/composer";

const SHARED_EDIT_ACTION = "sharedEdit";
const PLUGIN_ID = "discourse-shared-edits";

function initWithApi(api) {
  SAVE_LABELS[SHARED_EDIT_ACTION] = "composer.save_edit";
  SAVE_ICONS[SHARED_EDIT_ACTION] = "pencil-alt";

  api.includePostAttributes("shared_edits_enabled");

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

  api.reopenWidget("post-menu", {
    menuItems() {
      const result = this._super(...arguments);

      if (this.attrs.shared_edits_enabled) {
        this.attrs.wiki = false;

        if (result.includes("edit")) {
          result.splice(result.indexOf("edit"), 1);
        }
      }

      return result;
    },

    sharedEdit() {
      const post = this.findAncestorModel();
      this.appEvents.trigger("shared-edit-on-post", post);
    },
  });

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
          className: "admin-collude",
          label: attrs.shared_edits_enabled
            ? "shared_edits.disable_shared_edits"
            : "shared_edits.enable_shared_edits",
        })
      );

      return contents;
    },

    toggleSharedEdit() {
      const post = this.findAncestorModel();

      let url = `/shared_edits/p/${post.id}/${
        post.shared_edits_enabled ? "disable" : "enable"
      }.json`;

      ajax(url, { type: "PUT" })
        .then(() => {
          post.set(
            "shared_edits_enabled",
            post.shared_edits_enabled ? false : true
          );
          this.scheduleRerender();
        })
        .catch(popupAjaxError);
    },
  });

  api.modifyClass("component:scrolling-post-stream", {
    pluginId: PLUGIN_ID,

    sharedEdit() {
      this.appEvents.trigger("shared-edit-on-post");
    },
  });

  api.modifyClass("model:composer", {
    pluginId: PLUGIN_ID,

    creatingSharedEdit: computed.equal("action", SHARED_EDIT_ACTION),

    @discourseComputed("action")
    editingPost() {
      return this._super(...arguments) || this.creatingSharedEdit;
    },
  });

  api.modifyClass("component:composer-presence-display", {
    pluginId: PLUGIN_ID,

    _typing() {
      if (this.model.action === SHARED_EDIT_ACTION) {
        const lastKey = this.model.lastKeyPress;
        if (!lastKey || lastKey < Date.now() - 2000) {
          return;
        }
      }
      this._super(...arguments);
    },
  });

  api.modifyClass("component:composer-editor", {
    pluginId: PLUGIN_ID,

    @on("keyDown")
    _trackTyping() {
      if (this.composer.action === SHARED_EDIT_ACTION) {
        this.composer.set("lastKeyPress", Date.now());
      }
    },
  });

  api.modifyClass("controller:topic", {
    pluginId: PLUGIN_ID,

    init() {
      this._super(...arguments);

      this.appEvents.on("shared-edit-on-post", (post) => {
        const draftKey = post.get("topic.draft_key");
        const draftSequence = post.get("topic.draft_sequence");

        this.get("composer").open({
          post,
          action: SHARED_EDIT_ACTION,
          draftKey,
          draftSequence,
        });
      });
    },

    willDestroy() {
      this.appEvents.off("shared-edit-on-post", this);
      this._super(...arguments);
    },
  });

  api.modifyClass("controller:composer", {
    pluginId: PLUGIN_ID,

    open(opts) {
      const openResponse = this._super(opts);
      if (openResponse && openResponse.then) {
        return openResponse.then(() => {
          if (opts.action === SHARED_EDIT_ACTION) {
            setupSharedEdit(this.model);
          }
        });
      }
    },

    collapse() {
      if (this.get("model.action") === SHARED_EDIT_ACTION) {
        return this.close();
      }
      return this._super();
    },

    close() {
      if (this.get("model.action") === SHARED_EDIT_ACTION) {
        teardownSharedEdit(this.model);
      }
      return this._super();
    },

    save() {
      if (this.get("model.action") === SHARED_EDIT_ACTION) {
        return this.close();
      }
      return this._super.apply(this, arguments);
    },

    @on("init")
    _listenForClose() {
      this.appEvents.on("composer:close", () => {
        this.close();
      });
    },

    @observes("model.reply")
    _handleSharedEdit() {
      if (this.get("model.action") === SHARED_EDIT_ACTION) {
        performSharedEdit(this.model);
      }
    },

    _saveDraft() {
      if (this.get("model.action") === SHARED_EDIT_ACTION) {
        return;
      }
      return this._super();
    },
  });
}

export default {
  name: "discourse-shared-edits",
  initialize: () => {
    withPluginApi("0.8.6", initWithApi);
  },
};
