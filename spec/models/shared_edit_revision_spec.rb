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
                     "20251124000000_resize_shared_edit_columns",
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
