# frozen_string_literal: true

RSpec.describe DiscourseSharedEdits::Revise do
  fab!(:admin)
  fab!(:post) { Fabricate(:post, user: admin, raw: "initial content") }

  before do
    SiteSetting.shared_edits_enabled = true
    SharedEditRevision.toggle_shared_edits!(post.id, true)
  end

  def latest_state_for(post)
    SharedEditRevision.where(post_id: post.id).order("version desc").limit(1).pluck(:raw).first
  end

  def revise!(client_id:, state_vector: nil)
    latest_state = latest_state_for(post)
    update = DiscourseSharedEdits::Yjs.update_from_state(latest_state, "updated content")
    described_class.call(
      post: post,
      current_user: admin,
      client_id: client_id,
      update: update,
      cursor: nil,
      awareness: nil,
      allow_blank_state: false,
      state_vector: state_vector,
    )
  end

  it "applies revisions through the service pipeline" do
    response = nil

    latest_state = latest_state_for(post)
    revision_update = DiscourseSharedEdits::Yjs.update_from_state(latest_state, "updated content")
    described_class.call(
      post: post,
      current_user: admin,
      client_id: "abc",
      update: revision_update,
      cursor: nil,
      awareness: nil,
      allow_blank_state: false,
      state_vector: nil,
    ) do |result|
      on_success do
        response = {
          version: result[:version],
          update: result[:update],
          state_hash: result[:state_hash],
        }
      end
    end

    expect(response).to be_present
    expect(response[:version]).to eq(2)
    expect(response[:update]).to eq(revision_update)
    expect(response[:state_hash]).to be_present
  end

  it "raises invalid update when client_id is invalid" do
    expect { revise!(client_id: "a" * 256) }.to raise_error(
      DiscourseSharedEdits::StateValidator::InvalidUpdateError,
      /Invalid client_id/,
    )
  end

  it "raises invalid update when state_vector is invalid" do
    expect { revise!(client_id: "abc", state_vector: "invalid!!!") }.to raise_error(
      DiscourseSharedEdits::StateValidator::InvalidUpdateError,
      /Invalid state vector/,
    )
  end
end
