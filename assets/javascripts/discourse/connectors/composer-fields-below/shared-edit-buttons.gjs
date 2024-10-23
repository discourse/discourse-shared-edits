import Component from "@glimmer/component";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";
import icon from "discourse-common/helpers/d-icon";
import i18n from "discourse-common/helpers/i18n";

export default class SharedEditButtons extends Component {
  @service site;

  @action
  endSharedEdit() {
    this.appEvents.trigger("composer:close");
  }

  <template>
    {{#if @outletArgs.model.creatingSharedEdit}}
      <div class="leave-shared-edit">
        {{#if this.site.mobileView}}
          <a
            {{on "click" this.endSharedEdit}}
            href
            title={{i18n "shared_edits.done"}}
            tabindex="6"
          >
            {{icon "times"}}
          </a>
        {{else}}
          <a
            {{on "click" this.endSharedEdit}}
            href
            tabindex="6"
            class="btn btn-primary"
          >
            {{i18n "shared_edits.done"}}
          </a>
        {{/if}}
      </div>
    {{/if}}
  </template>
}
