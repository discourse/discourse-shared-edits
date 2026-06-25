# frozen_string_literal: true

RSpec.describe CurrentUserSerializer do
  fab!(:user)
  fab!(:group)

  before do
    SiteSetting.shared_edits_enabled = true
    SiteSetting.shared_edits_toggle_allowed_groups = group.id.to_s
  end

  describe "#can_toggle_shared_edits" do
    it "serializes the current user's toggle permission" do
      json = described_class.new(user, scope: Guardian.new(user), root: false).as_json
      expect(json[:can_toggle_shared_edits]).to eq(false)

      group.add(user)
      reloaded_user = User.find(user.id)

      json =
        described_class.new(reloaded_user, scope: Guardian.new(reloaded_user), root: false).as_json
      expect(json[:can_toggle_shared_edits]).to eq(true)
    end
  end
end
