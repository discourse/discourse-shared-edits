# frozen_string_literal: true

require "rails_helper"
require_dependency Rails.root.join(
                     "plugins",
                     "discourse-shared-edits",
                     "lib",
                     "discourse_shared_edits",
                     "yjs",
                   )
require_dependency Rails.root.join(
                     "plugins",
                     "discourse-shared-edits",
                     "lib",
                     "discourse_shared_edits",
                     "state_validator",
                   )
require_dependency Rails.root.join(
                     "plugins",
                     "discourse-shared-edits",
                     "app",
                     "models",
                     "shared_edit_revision",
                   )
require_dependency Rails.root.join(
                     "plugins",
                     "discourse-shared-edits",
                     "db",
                     "migrate",
                     "20200721001123_migrate_shared_edits",
                   )
require_dependency Rails.root.join(
                     "plugins",
                     "discourse-shared-edits",
                     "db",
                     "migrate",
                     "20251124000123_resize_shared_edit_columns",
                   )

RSpec.describe DiscourseSharedEdits::StateValidator do
  before do
    unless ActiveRecord::Base.connection.data_source_exists?(:shared_edit_revisions)
      MigrateSharedEdits.new.up
      ResizeSharedEditColumns.new.up
    end
  end

  describe ".validate_state" do
    it "returns valid for a properly encoded state" do
      state = DiscourseSharedEdits::Yjs.state_from_text("Hello world")[:state]
      result = described_class.validate_state(state)

      expect(result[:valid]).to eq(true)
      expect(result[:text]).to eq("Hello world")
      expect(result[:error]).to be_nil
    end

    it "returns invalid for nil state" do
      result = described_class.validate_state(nil)

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("State is nil")
    end

    it "returns invalid for empty state" do
      result = described_class.validate_state("")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("State is empty")
    end

    it "returns invalid for malformed base64" do
      result = described_class.validate_state("not-valid-base64!!!")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to include("Invalid base64")
    end

    it "returns invalid for corrupted Yjs state" do
      # Valid base64 but not a valid Yjs document
      corrupted = Base64.strict_encode64("random garbage data that is not yjs")
      result = described_class.validate_state(corrupted)

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to include("Yjs extraction failed")
    end

    it "handles unicode content correctly" do
      state = DiscourseSharedEdits::Yjs.state_from_text("Hello 🌍 世界")[:state]
      result = described_class.validate_state(state)

      expect(result[:valid]).to eq(true)
      expect(result[:text]).to eq("Hello 🌍 世界")
    end

    it "handles very large content" do
      large_text = "x" * 100_000
      state = DiscourseSharedEdits::Yjs.state_from_text(large_text)[:state]
      result = described_class.validate_state(state)

      expect(result[:valid]).to eq(true)
      expect(result[:text].length).to eq(100_000)
    end
  end

  describe ".validate_update" do
    it "returns valid for a properly encoded update" do
      old_text = "Hello"
      new_text = "Hello world"
      update = DiscourseSharedEdits::Yjs.update_from_text_change(old_text, new_text)

      result = described_class.validate_update(update)

      expect(result[:valid]).to eq(true)
      expect(result[:error]).to be_nil
    end

    it "returns invalid for nil update" do
      result = described_class.validate_update(nil)

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("Update is nil")
    end

    it "returns invalid for empty update" do
      result = described_class.validate_update("")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("Update is empty")
    end

    it "returns invalid for malformed base64" do
      result = described_class.validate_update("not-valid-base64!!!")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to include("Invalid base64")
    end
  end

  describe ".health_check" do
    fab!(:post) { Fabricate(:post, raw: "Original content") }

    it "returns not_initialized when no revisions exist" do
      report = described_class.health_check(post.id)

      expect(report[:state]).to eq(:not_initialized)
      expect(report[:healthy]).to eq(true)
    end

    it "returns healthy for properly initialized state" do
      SharedEditRevision.init!(post)

      report = described_class.health_check(post.id)

      expect(report[:state]).to eq(:initialized)
      expect(report[:healthy]).to eq(true)
      expect(report[:errors]).to be_empty
      expect(report[:current_text]).to eq(post.raw)
    end

    it "detects corrupted state" do
      SharedEditRevision.init!(post)
      revision = SharedEditRevision.find_by(post_id: post.id)
      revision.update_column(:raw, Base64.strict_encode64("corrupted data"))

      report = described_class.health_check(post.id)

      expect(report[:healthy]).to eq(false)
      expect(report[:errors]).not_to be_empty
      expect(report[:errors].first).to include("corrupted")
    end

    it "detects nil state in revision" do
      SharedEditRevision.init!(post)
      revision = SharedEditRevision.find_by(post_id: post.id)
      revision.update_column(:raw, nil)

      report = described_class.health_check(post.id)

      expect(report[:healthy]).to eq(false)
      expect(report[:errors]).to include("Latest revision has nil state")
    end

    it "reports version gaps as informational" do
      SharedEditRevision.init!(post)

      # Manually create a revision with a version gap
      state = DiscourseSharedEdits::Yjs.state_from_text("v5 content")[:state]
      SharedEditRevision.create!(
        post_id: post.id,
        client_id: "test",
        user_id: Discourse.system_user.id,
        version: 5, # Gap from version 1
        revision: "",
        raw: state,
      )

      report = described_class.health_check(post.id)

      # Version gaps are informational, not warnings - they don't affect functionality
      expect(report[:healthy]).to eq(true)
      expect(report[:version_gaps]).to be_present
      expect(report[:version_gaps].first[:expected]).to eq(2)
      expect(report[:version_gaps].first[:got]).to eq(5)
    end
  end

  describe ".recover_from_post_raw" do
    fab!(:post) { Fabricate(:post, raw: "Recovery test content") }

    it "recovers from corrupted state" do
      SharedEditRevision.init!(post)
      revision = SharedEditRevision.find_by(post_id: post.id)
      revision.update_column(:raw, Base64.strict_encode64("corrupted"))

      result = described_class.recover_from_post_raw(post.id)

      expect(result[:success]).to eq(true)
      expect(result[:message]).to include("recovered")
      expect(result[:new_version]).to eq(1)

      # Verify the new state is valid
      new_revision = SharedEditRevision.find_by(post_id: post.id)
      text = DiscourseSharedEdits::Yjs.text_from_state(new_revision.raw)
      expect(text).to eq(post.raw)
    end

    it "refuses to recover healthy state without force" do
      SharedEditRevision.init!(post)

      result = described_class.recover_from_post_raw(post.id)

      expect(result[:success]).to eq(false)
      expect(result[:message]).to include("healthy")
    end

    it "recovers healthy state with force" do
      SharedEditRevision.init!(post)

      result = described_class.recover_from_post_raw(post.id, force: true)

      expect(result[:success]).to eq(true)
    end

    it "returns error for non-existent post" do
      result = described_class.recover_from_post_raw(999_999)

      expect(result[:success]).to eq(false)
      expect(result[:message]).to eq("Post not found")
    end

    it "deletes all existing revisions during recovery" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)

      # Add more revisions
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, "Modified content")
      SharedEditRevision.revise!(
        post_id: post.id,
        user_id: user.id,
        client_id: "test",
        update: update,
      )

      expect(SharedEditRevision.where(post_id: post.id).count).to eq(2)

      # Corrupt the state
      SharedEditRevision
        .where(post_id: post.id)
        .order("version desc")
        .first
        .update_column(:raw, Base64.strict_encode64("corrupted"))

      result = described_class.recover_from_post_raw(post.id)

      expect(result[:success]).to eq(true)
      expect(SharedEditRevision.where(post_id: post.id).count).to eq(1)
    end
  end

  describe ".safe_apply_update" do
    fab!(:post)

    it "applies valid update successfully" do
      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      update = DiscourseSharedEdits::Yjs.update_from_state(initial_state, "Hello world")

      result = described_class.safe_apply_update(post.id, initial_state, update)

      expect(result[:text]).to eq("Hello world")
      expect(result[:state]).to be_present
    end

    it "raises StateCorruptionError for invalid update" do
      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]

      expect {
        described_class.safe_apply_update(post.id, initial_state, "not-valid-base64!!!")
      }.to raise_error(DiscourseSharedEdits::StateValidator::StateCorruptionError)
    end

    it "raises StateCorruptionError for nil update" do
      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]

      expect { described_class.safe_apply_update(post.id, initial_state, nil) }.to raise_error(
        DiscourseSharedEdits::StateValidator::StateCorruptionError,
      )
    end

    it "raises StateCorruptionError when result exceeds max_post_length" do
      SiteSetting.max_post_length = 100

      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      long_text = "x" * 200
      update = DiscourseSharedEdits::Yjs.update_from_state(initial_state, long_text)

      expect { described_class.safe_apply_update(post.id, initial_state, update) }.to raise_error(
        DiscourseSharedEdits::StateValidator::StateCorruptionError,
        /exceeds maximum allowed/,
      )
    end

    it "allows updates within max_post_length" do
      SiteSetting.max_post_length = 100

      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      valid_text = "x" * 50
      update = DiscourseSharedEdits::Yjs.update_from_state(initial_state, valid_text)

      result = described_class.safe_apply_update(post.id, initial_state, update)
      expect(result[:text]).to eq(valid_text)
    end
  end

  describe "concurrent edit simulation" do
    fab!(:post) { Fabricate(:post, raw: "Initial content here") }
    fab!(:user1, :user)
    fab!(:user2, :user)
    fab!(:user3, :user)

    def simulate_edit(post, user, new_text)
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, new_text)
      SharedEditRevision.revise!(
        post_id: post.id,
        user_id: user.id,
        client_id: "client-#{user.id}",
        update: update,
      )
    end

    it "handles rapid sequential edits without corruption" do
      SharedEditRevision.init!(post)

      10.times { |i| simulate_edit(post, user1, "Content v#{i + 1}") }

      health = described_class.health_check(post.id)

      expect(health[:healthy]).to eq(true)
      expect(health[:current_text]).to eq("Content v10")
      expect(health[:revision_count]).to eq(11)
    end

    it "handles alternating user edits" do
      SharedEditRevision.init!(post)
      users = [user1, user2, user3]

      10.times do |i|
        user = users[i % 3]
        simulate_edit(post, user, "Edit #{i + 1} by #{user.username}")
      end

      health = described_class.health_check(post.id)

      expect(health[:healthy]).to eq(true)
      expect(health[:current_text]).to include("Edit 10")
    end

    it "maintains state integrity after commit" do
      SharedEditRevision.init!(post)

      simulate_edit(post, user1, "First edit")
      simulate_edit(post, user2, "Second edit")

      SharedEditRevision.commit!(post.id)

      post.reload
      expect(post.raw).to eq("Second edit")

      simulate_edit(post, user3, "Third edit after commit")

      health = described_class.health_check(post.id)
      expect(health[:healthy]).to eq(true)
      expect(health[:current_text]).to eq("Third edit after commit")
    end
  end

  describe "edge case recovery scenarios" do
    fab!(:post) { Fabricate(:post, raw: "Edge case content") }

    it "recovers when all revisions have nil raw" do
      SharedEditRevision.init!(post)
      SharedEditRevision.where(post_id: post.id).update_all(raw: nil)

      health = described_class.health_check(post.id)
      expect(health[:healthy]).to eq(false)

      result = described_class.recover_from_post_raw(post.id)
      expect(result[:success]).to eq(true)

      health = described_class.health_check(post.id)
      expect(health[:healthy]).to eq(true)
    end

    it "recovers when revisions table is empty for post" do
      SharedEditRevision.where(post_id: post.id).delete_all

      result = described_class.recover_from_post_raw(post.id, force: true)
      expect(result[:success]).to eq(true)

      health = described_class.health_check(post.id)
      expect(health[:healthy]).to eq(true)
    end

    it "handles empty post.raw during recovery" do
      post.update_column(:raw, "")
      SharedEditRevision.init!(post)

      # Corrupt the state
      SharedEditRevision
        .where(post_id: post.id)
        .first
        .update_column(:raw, Base64.strict_encode64("corrupted"))

      result = described_class.recover_from_post_raw(post.id)
      expect(result[:success]).to eq(true)

      new_revision = SharedEditRevision.find_by(post_id: post.id)
      expect(DiscourseSharedEdits::Yjs.text_from_state(new_revision.raw)).to eq("")
    end

    it "handles unicode post.raw during recovery" do
      post.update_column(:raw, "Hello 🌍🎉 世界 مرحبا")
      SharedEditRevision.init!(post)

      result = described_class.recover_from_post_raw(post.id, force: true)
      expect(result[:success]).to eq(true)

      new_revision = SharedEditRevision.find_by(post_id: post.id)
      expect(DiscourseSharedEdits::Yjs.text_from_state(new_revision.raw)).to eq("Hello 🌍🎉 世界 مرحبا")
    end
  end
end
