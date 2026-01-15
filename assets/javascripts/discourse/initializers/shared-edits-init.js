import { action } from "@ember/object";
import { service } from "@ember/service";
import { htmlSafe } from "@ember/template";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { USER_OPTION_COMPOSITION_MODES } from "discourse/lib/constants";
import { iconHTML } from "discourse/lib/icon-library";
import { withPluginApi } from "discourse/lib/plugin-api";
import {
  registerCustomizationCallback,
  SAVE_ICONS,
  SAVE_LABELS,
} from "discourse/models/composer";
import SharedEditButton from "../components/shared-edit-button";
import sharedEditsProsemirrorExtension from "../lib/shared-edits-prosemirror-extension";

const SHARED_EDIT_ACTION = "sharedEdit";

// WeakRef to siteSettings service to avoid memory leaks while allowing
// transformers to access current settings without stale references
let _siteSettingsRef = null;

function getSiteSettings() {
  // Return the current siteSettings from the WeakRef, or null if GC'd
  return _siteSettingsRef?.deref?.() ?? _siteSettingsRef;
}

function formatSharedEditActionTitle(model) {
  if (model.action !== SHARED_EDIT_ACTION) {
    return;
  }

  const opts = model.replyOptions;
  if (!opts?.userAvatar || !opts?.userLink || !opts?.postLink) {
    return;
  }

  return htmlSafe(`
    ${iconHTML("far-pen-to-square", { title: "shared_edits.composer_title" })}
    <a class="post-link" href="${opts.postLink.href}">${opts.postLink.anchor}</a>
    ${opts.userAvatar}
    <span class="username">${opts.userLink.anchor}</span>
  `);
}

function initWithApi(api) {
  SAVE_LABELS[SHARED_EDIT_ACTION] = "composer.save_edit";
  SAVE_ICONS[SHARED_EDIT_ACTION] = "pencil";

  registerCustomizationCallback({
    actionTitle: formatSharedEditActionTitle,
  });

  // Force editor mode based on shared_edits_editor_mode setting
  // When in shared edit mode, use the configured editor mode (markdown or rich)
  api.registerValueTransformer(
    "composer-force-editor-mode",
    ({ value, context }) => {
      if (context.model?.action === SHARED_EDIT_ACTION) {
        // Get current siteSettings to avoid stale references
        const siteSettings = getSiteSettings();
        // Use rich mode if the setting is "rich", otherwise force markdown
        if (siteSettings?.shared_edits_editor_mode === "rich") {
          return USER_OPTION_COMPOSITION_MODES.richEditor;
        }
        return USER_OPTION_COMPOSITION_MODES.markdown;
      }
      return value;
    }
  );

  // Register ProseMirror extension for rich text collaborative editing
  // This adds y-prosemirror plugins when Yjs state is available
  api.registerRichEditorExtension(sharedEditsProsemirrorExtension);

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

  api.addTrackedPostProperties("shared_edits_enabled");

  api.addPostClassesCallback((attrs) => {
    if (attrs.shared_edits_enabled && attrs.canEdit) {
      return ["shared-edits-post"];
    }
  });

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

        async _handleSharedEditOnPost(post) {
          const draftKey = post.get("topic.draft_key");
          const draftSequence = post.get("topic.draft_sequence");

          let raw;
          try {
            const result = await ajax(`/posts/${post.id}.json`);
            raw = result.raw;
          } catch (e) {
            popupAjaxError(e);
            return;
          }

          this.get("composer").open({
            post,
            action: SHARED_EDIT_ACTION,
            draftKey,
            draftSequence,
            reply: raw,
          });
        }
      }
  );

  api.modifyClass(
    "component:d-editor",
    (Superclass) =>
      class extends Superclass {
        @service composer;
        @service sharedEditManager;

        @action
        onChange(event) {
          super.onChange(event);

          if (this.composer?.model?.action !== SHARED_EDIT_ACTION) {
            return;
          }

          this.sharedEditManager?.syncFromComposerValue?.(
            event?.target?.value ?? ""
          );
        }
      }
  );

  api.modifyClass(
    "component:composer-messages",
    (Superclass) =>
      class extends Superclass {
        async _findMessages() {
          if (this.composer?.action === SHARED_EDIT_ACTION) {
            this.set("checkedMessages", true);
            return;
          }

          return super._findMessages(...arguments);
        }
      }
  );
}

function customizePostMenu(api) {
  api.registerValueTransformer(
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

  // register the property as tracked to ensure the button is correctly updated
  api.addTrackedPostProperties("shared_edits_enabled");
}

export default {
  name: "discourse-shared-edits",
  initialize: (container) => {
    const siteSettings = container.lookup("service:site-settings");
    if (!siteSettings.shared_edits_enabled) {
      return;
    }

    // Store siteSettings reference for use in transformer
    // Use WeakRef if available to allow GC, otherwise fall back to direct reference
    // This prevents memory leaks while keeping transformers working
    if (typeof globalThis.WeakRef !== "undefined") {
      _siteSettingsRef = new globalThis.WeakRef(siteSettings);
    } else {
      _siteSettingsRef = siteSettings;
    }

    withPluginApi(initWithApi);
  },
};
