# frozen_string_literal: true
require "rails_helper"

describe SharedEditRevision do
  def fake_edit(post, user_id, data, version:)
    SharedEditRevision.revise!(
      post_id: post.id,
      user_id: user_id,
      client_id: user_id,
      revision: data.to_json,
      version: version,
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

    post = Fabricate(:post, raw: raw)
    SharedEditRevision.init!(post)

    version, revision = nil

    messages =
      MessageBus.track_publish("/shared_edits/#{post.id}") do
        version, revision = fake_edit(post, user1.id, [8, { d: 7 }, "mister"], version: 1)
      end

    expected_rev = [8, { d: 7 }, "mister"].to_json
    expect(messages.length).to eq(1)
    expect(messages.first.data[:version]).to eq(2)
    expect(messages.first.data[:revision]).to eq(expected_rev)

    expect(version).to eq(2)
    expect(revision).to eq(expected_rev)

    SharedEditRevision.commit!(post.id)

    new_raw = (<<~RAW).strip
      0123456
      mister
      0123456
    RAW

    post.reload
    expect(post.raw).to eq(new_raw)

    version, revision = fake_edit(post, user2.id, [{ d: 7 }, "hello"], version: 1)

    expect(version).to eq(3)
    expect(revision).to eq("[{\"d\":7},\"hello\"]")

    version, revision = fake_edit(post, user1.id, [16, { d: 7 }, "world"], version: 1)

    expect(version).to eq(4)
    expect(revision).to eq("[13,{\"d\":7},\"world\"]")

    fake_edit(post, 3, [{ d: 1 }, "H"], version: 3)

    SharedEditRevision.commit!(post.id)

    new_raw = (<<~RAW).strip
      Hello
      mister
      world
    RAW

    post.reload

    expect(post.raw).to eq(new_raw)

    rev = post.revisions.order(:number).first

    reason = rev.modifications["edit_reason"][1].to_s
    expect(reason).to include(user1.username)
    expect(reason).to include(user2.username)
    expect(reason).not_to include("d,")

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
      revision: [{ d: 11 }, "Test"],
      version: 1,
    )

    expect(post.reload.raw).to eq("Hello world")
  end
end
