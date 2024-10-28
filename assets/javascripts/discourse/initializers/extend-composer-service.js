import { service } from "@ember/service";
import { withPluginApi } from "discourse/lib/plugin-api";

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
            @service sharedEditManager;

            async open(opts) {
              await super.open(...arguments);

              if (opts.action === SHARED_EDIT_ACTION) {
                await this.sharedEditManager.subscribe();
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
                this.sharedEditManager.commit();
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
