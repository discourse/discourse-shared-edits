import Component from "@glimmer/component";
import { action } from "@ember/object";
import { service } from "@ember/service";
import DButton from "discourse/components/d-button";
import concatClass from "discourse/helpers/concat-class";

export default class SharedEditButton extends Component {
  static shouldRender(args) {
    return args.post.can_edit;
  }

  // TODO (glimmer-post-menu): Remove this static method and move the code into the button action after the widget code is removed
  static sharedEdit(post, appEvents) {
    appEvents.trigger("shared-edit-on-post", post);
  }

  @service appEvents;
  @service site;

  get showLabel() {
    return this.args.showLabel ?? this.site.desktopView;
  }

  @action
  sharedEdit() {
    SharedEditButton.sharedEdit(this.args.post, this.appEvents);
  }

  <template>
    <DButton
      class={{concatClass
        "post-action-menu__shared-edit"
        "shared-edit"
        "create fade-out"
      }}
      ...attributes
      @action={{this.sharedEdit}}
      @icon="far-edit"
      @label={{if this.showLabel "post.controls.edit_action"}}
      @title="shared_edits.button_title"
    />
  </template>
}
