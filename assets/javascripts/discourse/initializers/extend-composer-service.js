import { withPluginApi } from "discourse/lib/plugin-api";
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
            init() {
              super.init(...arguments);
              this.addObserver("model.reply", this, this._handleSharedEdit);
            }

            willDestroy() {
              super.willDestroy(...arguments);
              this.removeObserver("model.reply", this, this._handleSharedEdit);
            }

            _handleSharedEdit() {
              if (this.model?.action === SHARED_EDIT_ACTION) {
                performSharedEdit(this.model);
              }
            }

            async open(opts) {
              await super.open(...arguments);

              if (opts.action === SHARED_EDIT_ACTION) {
                setupSharedEdit(this.model);
              }
            }

            collapse() {
              if (this.model?.action === SHARED_EDIT_ACTION) {
                return this.close();
              }
              return super.collapse(...arguments);
            }

            close() {
              if (this.model?.action === SHARED_EDIT_ACTION) {
                teardownSharedEdit(this.model);
              }
              return super.close(...arguments);
            }

            save() {
              if (this.model?.action === SHARED_EDIT_ACTION) {
                return this.close();
              }
              return super.save(...arguments);
            }

            _saveDraft() {
              if (this.model?.action === SHARED_EDIT_ACTION) {
                return;
              }
              return super._saveDraft(...arguments);
            }
          }
      );
    });
  },
};
