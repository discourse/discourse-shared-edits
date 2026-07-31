import { service } from "@ember/service";
import { withPluginApi } from "discourse/lib/plugin-api";
import { debugWarn } from "../lib/shared-edits/debug";

const SHARED_EDIT_ACTION = "sharedEdit";

export default {
  name: "discourse-shared-edits-composer-service",
  before: "inject-discourse-objects",

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

            discardingRestoredSharedEdit = false;
            openingSharedEditPostId = null;

            init() {
              super.init(...arguments);
              this.appEvents.on(
                "composer:opened",
                this,
                this.discardRestoredSharedEdit
              );
            }

            willDestroy() {
              this.appEvents.off(
                "composer:opened",
                this,
                this.discardRestoredSharedEdit
              );
              super.willDestroy(...arguments);
            }

            async discardRestoredSharedEdit() {
              const model = this.model;
              if (
                model?.action !== SHARED_EDIT_ACTION ||
                !model.viewOpen ||
                !model.post?.id ||
                this.openingSharedEditPostId === model.post.id ||
                this.sharedEditManager.currentPostId === model.post.id ||
                this.discardingRestoredSharedEdit
              ) {
                return;
              }

              this.discardingRestoredSharedEdit = true;
              model.set("disableDrafts", true);
              this.sharedEditManager.suppressComposerChange = true;
              try {
                await this.destroyDraft();
              } catch (error) {
                debugWarn("Failed to delete restored shared-edit draft", error);
              } finally {
                try {
                  await super.close();
                } catch (error) {
                  debugWarn(
                    "Failed to close restored shared-edit composer",
                    error
                  );
                } finally {
                  this.sharedEditManager.suppressComposerChange = false;
                  this.discardingRestoredSharedEdit = false;
                }
              }
            }

            async open(opts) {
              if (opts.action !== SHARED_EDIT_ACTION || !opts.post?.id) {
                return await super.open(...arguments);
              }

              const postId = opts.post.id;
              const sharedEditOptions = {
                ...opts,
                disableDrafts: true,
                draftKey: `shared_edit_${postId}`,
                draftSequence: 0,
              };
              this.openingSharedEditPostId = postId;
              try {
                const subscription = await this.sharedEditManager.subscribe(
                  postId,
                  {
                    preOpen: true,
                  }
                );
                if (!subscription) {
                  return;
                }
                if (subscription.reply !== undefined) {
                  sharedEditOptions.reply = subscription.reply;
                }

                await super.open(sharedEditOptions);
                this.model?.set("disableDrafts", true);
                await this.sharedEditManager.finalizeSubscription();
              } finally {
                if (this.openingSharedEditPostId === postId) {
                  this.openingSharedEditPostId = null;
                }
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

              // Suppress composer observer during close to prevent Y.Text from being
              // wiped when model.reply is cleared
              if (wasSharedEdit) {
                this.sharedEditManager.suppressComposerChange = true;
              }
              try {
                const result = await super.close(...arguments);
                if (wasSharedEdit) {
                  await this.sharedEditManager.commit();
                }
                return result;
              } finally {
                if (wasSharedEdit) {
                  this.sharedEditManager.suppressComposerChange = false;
                }
              }
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
