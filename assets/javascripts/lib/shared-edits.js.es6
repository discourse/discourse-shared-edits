import { ajax } from "discourse/lib/ajax";
import EmberObject from "@ember/object";
import { popupAjaxError } from "discourse/lib/ajax-error";

export function setupSharedEdit(composer) {
  const manager = SharedEditManager.create();
  composer.set("sharedEditManager", manager);

  ajax(`/shared_edits/p/${composer.get("post.id")}`)
    .then(data => {
      manager.set("version", data.version);
      manager.set("raw", data.raw);
      manager.set("composer", composer);
      composer.set("reply", data.raw);
      manager.subscribe();
    })
    .catch(popupAjaxError);
}

export function teardownSharedEdit(composer) {}

export function performSharedEdit(composer) {}

const SharedEditManager = EmberObject.extend({
  subscribe() {
    //composer.messageBus.subscribe(`/`)
  }
});
