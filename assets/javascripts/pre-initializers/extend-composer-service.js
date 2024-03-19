import { withPluginApi } from "discourse/lib/plugin-api";
import { observes, on } from "discourse-common/utils/decorators";
import {
  performSharedEdit,
  setupSharedEdit,
  teardownSharedEdit,
} from "../lib/shared-edits";

const SHARED_EDIT_ACTION = "sharedEdit";
const PLUGIN_ID = "discourse-shared-edits";

export default {
  name: "discourse-shared-edits-composer-service",

  initialize: (container) => {
    const siteSettings = container.lookup("service:site-settings");
    if (!siteSettings.shared_edits_enabled) {
      return;
    }

    withPluginApi("0.8.6", (api) => {
      api.modifyClass("service:composer", {
        pluginId: PLUGIN_ID,

        async open(opts) {
          await this._super(opts);

          if (opts.action === SHARED_EDIT_ACTION) {
            setupSharedEdit(this.model);
          }
        },

        collapse() {
          if (this.model.action === SHARED_EDIT_ACTION) {
            return this.close();
          }
          return this._super();
        },

        close() {
          if (this.model.action === SHARED_EDIT_ACTION) {
            teardownSharedEdit(this.model);
          }
          return this._super();
        },

        save() {
          if (this.model.action === SHARED_EDIT_ACTION) {
            return this.close();
          }
          return this._super.apply(this, arguments);
        },

        @on("init")
        _listenForClose() {
          this.appEvents.on("composer:close", () => this.close());
        },

        @observes("model.reply")
        _handleSharedEdit() {
          if (this.model.action === SHARED_EDIT_ACTION) {
            performSharedEdit(this.model);
          }
        },

        _saveDraft() {
          if (this.model.action === SHARED_EDIT_ACTION) {
            return;
          }
          return this._super();
        },
      });
    });
  },
};
