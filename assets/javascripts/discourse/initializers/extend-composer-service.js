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

    withPluginApi((api) => {
      api.modifyClass(
        "service:composer",
        (Superclass) =>
          class extends Superclass {
            @service sharedEditManager;

            async open(opts) {
              if (opts.action === SHARED_EDIT_ACTION && opts.post?.id) {
                const subscription = await this.sharedEditManager.subscribe(
                  opts.post.id,
                  { preOpen: true }
                );
                if (subscription?.reply !== undefined) {
                  opts.reply = subscription.reply;
                }
              }

              await super.open(...arguments);

              if (opts.action === SHARED_EDIT_ACTION && opts.post?.id) {
                await this.sharedEditManager.finalizeSubscription();
              }
            }

            collapse() {
              if (this.model?.action === SHARED_EDIT_ACTION) {
                return this.close();
              }
              return super.collapse(...arguments);
            }

            async close() {
              const wasSharedEdit = this.model?.action === SHARED_EDIT_ACTION;
              const result = await super.close(...arguments);
              if (wasSharedEdit) {
                await this.sharedEditManager.commit();
              }
              return result;
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
