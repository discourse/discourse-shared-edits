# frozen_string_literal: true

RSpec.describe Guardian do
  fab!(:moderator)
  fab!(:admin)
  fab!(:user)

  describe "#can_toggle_shared_edits?" do
    context "when shared_edits_enabled is true" do
      before { SiteSetting.shared_edits_enabled = true }

      it "disallows shared edits from anon" do
        expect(Guardian.new.can_toggle_shared_edits?).to eq(false)
      end

      it "disallows shared edits for tl3 users" do
        user.trust_level = 3
        expect(Guardian.new(user).can_toggle_shared_edits?).to eq(false)
      end

      it "disallows shared edits for regular users" do
        expect(Guardian.new(user).can_toggle_shared_edits?).to eq(false)
      end

      it "allows shared edits for moderators" do
        expect(Guardian.new(moderator).can_toggle_shared_edits?).to eq(true)
      end

      it "allows shared edits for admins" do
        expect(Guardian.new(admin).can_toggle_shared_edits?).to eq(true)
      end

      it "allows shared edits for tl4" do
        user.trust_level = 4
        expect(Guardian.new(user).can_toggle_shared_edits?).to eq(true)
      end
    end

    context "when shared_edits_enabled is false" do
      before { SiteSetting.shared_edits_enabled = false }

      it "disallows shared edits for admins" do
        expect(Guardian.new(admin).can_toggle_shared_edits?).to eq(false)
      end

      it "disallows shared edits for moderators" do
        expect(Guardian.new(moderator).can_toggle_shared_edits?).to eq(false)
      end

      it "disallows shared edits for tl4" do
        user.trust_level = 4
        expect(Guardian.new(user).can_toggle_shared_edits?).to eq(false)
      end
    end
  end
end
