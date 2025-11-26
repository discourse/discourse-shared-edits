# frozen_string_literal: true

require "rails_helper"
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

RSpec.describe SharedEditRevision do
  before do
    unless ActiveRecord::Base.connection.data_source_exists?(:shared_edit_revisions)
      MigrateSharedEdits.new.up
      ResizeSharedEditColumns.new.up
    end
  end

  def latest_state(post)
    SharedEditRevision.where(post_id: post.id).order("version desc").limit(1).pluck(:raw).first
  end

  def fake_edit(post, user_id, new_text)
    state = latest_state(post)
    update = DiscourseSharedEdits::Yjs.update_from_state(state, new_text)

    SharedEditRevision.revise!(
      post_id: post.id,
      user_id: user_id,
      client_id: user_id,
      update: update,
    )
  end

  describe ".init!" do
    fab!(:post)

    it "creates an initial revision with the post content" do
      SharedEditRevision.init!(post)

      revision = SharedEditRevision.find_by(post_id: post.id)
      expect(revision).to be_present
      expect(revision.version).to eq(1)
      expect(revision.client_id).to eq("system")
      expect(revision.user_id).to eq(Discourse.system_user.id)
      expect(DiscourseSharedEdits::Yjs.text_from_state(revision.raw)).to eq(post.raw)
    end

    it "does not create duplicate revisions if already initialized" do
      SharedEditRevision.init!(post)
      SharedEditRevision.init!(post)

      expect(SharedEditRevision.where(post_id: post.id).count).to eq(1)
    end
  end

  describe ".toggle_shared_edits!" do
    fab!(:post)

    it "enables shared edits and creates initial revision" do
      SharedEditRevision.toggle_shared_edits!(post.id, true)

      post.reload
      expect(post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]).to eq(true)
      expect(SharedEditRevision.where(post_id: post.id).count).to eq(1)
    end

    it "disables shared edits and removes revisions" do
      SharedEditRevision.toggle_shared_edits!(post.id, true)
      SharedEditRevision.toggle_shared_edits!(post.id, false)

      post.reload
      expect(post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]).to be_nil
      expect(SharedEditRevision.where(post_id: post.id).count).to eq(0)
    end

    it "commits pending changes when disabling" do
      SharedEditRevision.toggle_shared_edits!(post.id, true)
      user = Fabricate(:user)
      new_raw = "#{post.raw} edited content"
      fake_edit(post, user.id, new_raw)

      SharedEditRevision.toggle_shared_edits!(post.id, false)

      post.reload
      expect(post.raw).to eq(new_raw)
    end
  end

  describe ".latest_raw" do
    fab!(:post)

    it "returns nil when no revisions exist" do
      result = SharedEditRevision.latest_raw(post.id)
      expect(result).to be_nil
    end

    it "returns the version and text of the latest revision" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)
      new_text = "Updated content"
      fake_edit(post, user.id, new_text)

      version, text = SharedEditRevision.latest_raw(post.id)

      expect(version).to eq(2)
      expect(text).to eq(new_text)
    end
  end

  describe ".revise!" do
    fab!(:post)
    fab!(:user)

    before { SharedEditRevision.init!(post) }

    it "raises when shared edits not initialized" do
      SharedEditRevision.where(post_id: post.id).delete_all

      expect {
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: user.id,
          client_id: "test",
          update: "some_update",
        )
      }.to raise_error(StandardError, "shared edits not initialized")
    end

    it "publishes to message bus" do
      messages =
        MessageBus.track_publish("/shared_edits/#{post.id}") do
          fake_edit(post, user.id, "new content")
        end

      expect(messages.length).to eq(1)
      expect(messages.first.data[:version]).to eq(2)
      expect(messages.first.data[:user_id]).to eq(user.id)
    end
  end

  describe ".commit!" do
    fab!(:post) { Fabricate(:post, raw: "Original content that is long enough") }

    it "returns nil when no revisions exist" do
      result = SharedEditRevision.commit!(post.id)
      expect(result).to be_nil
    end

    it "does nothing when already committed" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)
      fake_edit(post, user.id, "Modified content that is long enough")
      SharedEditRevision.commit!(post.id)

      post.reload
      original_raw = post.raw
      revision_count = PostRevision.where(post: post).count

      SharedEditRevision.commit!(post.id)

      expect(PostRevision.where(post: post).count).to eq(revision_count)
      expect(post.reload.raw).to eq(original_raw)
    end

    it "does not apply to post when apply_to_post is false" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)
      fake_edit(post, user.id, "Modified content that is long enough")

      SharedEditRevision.commit!(post.id, apply_to_post: false)

      expect(post.reload.raw).to eq("Original content that is long enough")
    end
  end

  it "can resolve complex edits and notify" do
    raw = <<~RAW
      0123456
      0123456
      0123456
    RAW

    user1 = Fabricate(:user)
    user2 = Fabricate(:user)
    user3 = Fabricate(:user)

    post = Fabricate(:post, raw: raw)
    SharedEditRevision.init!(post)

    text_after_user1 = <<~RAW
      0123456
      mister
      0123456
    RAW

    text_after_user2 = <<~RAW
      Hello
      mister
      0123456
    RAW

    final_text = <<~RAW
      Hello
      mister
      world
    RAW

    messages =
      MessageBus.track_publish("/shared_edits/#{post.id}") do
        fake_edit(post, user1.id, text_after_user1)
      end

    expect(messages.length).to eq(1)
    expect(messages.first.data[:version]).to eq(2)
    expect(messages.first.data[:update]).to be_present

    SharedEditRevision.commit!(post.id)

    post.reload
    expect(post.raw.strip).to eq(text_after_user1.strip)

    fake_edit(post, user2.id, text_after_user2)
    fake_edit(post, user3.id, final_text)

    SharedEditRevision.commit!(post.id)

    post.reload

    expect(post.raw.strip).to eq(final_text.strip)

    rev = post.revisions.order(:number).first

    reason = rev.modifications["edit_reason"][1].to_s
    expect(reason).to include(user1.username)
    expect(reason).to include(user2.username)
    expect(reason).to include(user3.username)

    edit_rev = SharedEditRevision.where(post_id: post.id).order("version desc").first

    expect(edit_rev.post_revision_id).to eq(rev.id)
  end

  it "does not update the post if validation fails" do
    user = Fabricate(:admin)
    post = Fabricate(:post, user: user, raw: "Hello world")

    SharedEditRevision.init!(post)
    SharedEditRevision.revise!(
      post_id: post.id,
      user_id: user.id,
      client_id: user.id,
      update: DiscourseSharedEdits::Yjs.update_from_text_change("Hello world", "Test"),
    )

    expect(post.reload.raw).to eq("Hello world")
  end
end
