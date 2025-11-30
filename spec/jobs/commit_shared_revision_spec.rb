# frozen_string_literal: true

require "rails_helper"

RSpec.describe Jobs::CommitSharedRevision do
  fab!(:post) { Fabricate(:post, raw: "Original content") }
  fab!(:user)

  before do
    SiteSetting.shared_edits_enabled = true
    SharedEditRevision.init!(post)
  end

  def latest_state
    SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
  end

  it "commits pending revisions and clears the deferred commit sentinel" do
    redis = Discourse.redis
    key = SharedEditRevision.will_commit_key(post.id)
    redis.setex(key, 60, "1")

    update = DiscourseSharedEdits::Yjs.update_from_state(latest_state, "Edited content")

    SharedEditRevision.revise!(
      post_id: post.id,
      user_id: user.id,
      client_id: "test-client",
      update: update,
    )

    expect { described_class.new.execute(post_id: post.id) }.to change { post.reload.raw }.to(
      "Edited content",
    )

    expect(redis.get(key)).to be_nil

    latest_revision = SharedEditRevision.where(post_id: post.id).order("version desc").first
    expect(latest_revision.post_revision_id).to be_present
  end
end
