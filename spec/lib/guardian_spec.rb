# frozen_string_literal: true

RSpec.describe Guardian do
  fab!(:moderator)
  fab!(:admin)
  fab!(:user)
  fab!(:tl4_user) { Fabricate(:user, trust_level: TrustLevel[4], refresh_auto_groups: true) }
  fab!(:group)

  describe "#can_toggle_shared_edits?" do
    context "when shared edits are enabled" do
      before { SiteSetting.shared_edits_enabled = true }

      it "allows the default groups" do
        aggregate_failures do
          expect(Guardian.new(admin)).to be_can_toggle_shared_edits
          expect(Guardian.new(moderator)).to be_can_toggle_shared_edits
          expect(Guardian.new(tl4_user)).to be_can_toggle_shared_edits
        end
      end

      it "disallows users outside the configured groups" do
        expect(Guardian.new(user)).not_to be_can_toggle_shared_edits
      end

      it "disallows anonymous users" do
        expect(Guardian.new).not_to be_can_toggle_shared_edits
      end

      it "uses the configured groups" do
        SiteSetting.shared_edits_toggle_allowed_groups = group.id.to_s
        group.add(user)
        user.reload

        aggregate_failures do
          expect(Guardian.new(user)).to be_can_toggle_shared_edits
          expect(Guardian.new(admin)).not_to be_can_toggle_shared_edits
          expect(Guardian.new(tl4_user)).not_to be_can_toggle_shared_edits
        end
      end
    end

    context "when shared edits are disabled" do
      before { SiteSetting.shared_edits_enabled = false }

      it "disallows users in configured groups" do
        aggregate_failures do
          expect(Guardian.new(admin)).not_to be_can_toggle_shared_edits
          expect(Guardian.new(moderator)).not_to be_can_toggle_shared_edits
          expect(Guardian.new(tl4_user)).not_to be_can_toggle_shared_edits
        end
      end
    end
  end
end
