import { withPluginApi } from "discourse/lib/plugin-api";
import { observes, on } from "discourse-common/utils/decorators";
import {
  performSharedEdit,
  setupSharedEdit,
  teardownSharedEdit,
} from "../lib/shared-edits";

const SHARED_EDIT_ACTION = "sharedEdit";

export default {
  name: "discourse-shared-edits-composer-service",

  initialize: (container) => {
    const siteSettings = container.lookup("service:site-settings");
    if (!siteSettings.shared_edits_enabled) {
      return;
    }

    withPluginApi("0.8.6", (api) => {
      api.modifyClass(
        "service:composer",
        (Superclass) =>
          class extends Superclass {
            async open(opts) {
              await super.open(...arguments);

              if (opts.action === SHARED_EDIT_ACTION) {
                setupSharedEdit(this.model);
              }
            }

            collapse() {
              if (this.get("model.action") === SHARED_EDIT_ACTION) {
                return this.close();
              }
              return super.collapse(...arguments);
            }

            close() {
              if (this.get("model.action") === SHARED_EDIT_ACTION) {
                teardownSharedEdit(this.model);
              }
              return super.close(...arguments);
            }

            save() {
              if (this.get("model.action") === SHARED_EDIT_ACTION) {
                return this.close();
              }
              return super.save(...arguments);
            }

            @on("init")
            _listenForClose() {
              this.appEvents.on("composer:close", () => this.close());
            }

            @observes("model.reply")
            _handleSharedEdit() {
              if (this.get("model.action") === SHARED_EDIT_ACTION) {
                performSharedEdit(this.model);
              }
            }

            _saveDraft() {
              if (this.get("model.action") === SHARED_EDIT_ACTION) {
                return;
              }
              return super._saveDraft(...arguments);
            }
          }
      );
    });
  },
};
