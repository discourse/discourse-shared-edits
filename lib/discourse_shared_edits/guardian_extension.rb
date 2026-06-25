# frozen_string_literal: true

module DiscourseSharedEdits
  module GuardianExtension
    extend ActiveSupport::Concern

    def can_toggle_shared_edits?
      SiteSetting.shared_edits_enabled && authenticated? &&
        @user.in_any_groups?(SiteSetting.shared_edits_toggle_allowed_groups_map)
    end
  end
end
