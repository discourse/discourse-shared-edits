# frozen_string_literal: true

module PageObjects
  module Components
    class SharedEditsComposer < PageObjects::Components::Composer
      def leave_shared_edit
        find("#{@composer_id} .leave-shared-edit .btn-primary").click
        self
      end
    end
  end
end
