# frozen_string_literal: true

module PageObjects
  module Pages
    class SharedEditsTopic < PageObjects::Pages::Topic
      def toggle_shared_edits_for(post)
        expand_post_actions(post)
        expand_post_admin_actions(post)
        find(".admin-toggle-shared-edits").click
        self
      end

      def click_shared_edit_button(post)
        within_post(post) { find(".shared-edit").click }
        self
      end
    end
  end
end
