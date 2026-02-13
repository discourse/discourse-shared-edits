import Component from "@glimmer/component";
import { action } from "@ember/object";
import { service } from "@ember/service";
import DButton from "discourse/components/d-button";

export default class SharedEditButtons extends Component {
  @service composer;

  @action
  endSharedEdit() {
    this.composer.close();
  }

  <template>
    {{#if @outletArgs.model.creatingSharedEdit}}
      <div class="leave-shared-edit">
        <DButton
          @action={{this.endSharedEdit}}
          @label="shared_edits.done"
          class="btn-primary"
        />
      </div>
    {{/if}}
  </template>
}
