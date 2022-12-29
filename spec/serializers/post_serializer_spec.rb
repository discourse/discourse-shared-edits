# frozen_string_literal: true

require "rails_helper"

describe PostSerializer do
  fab!(:post) { Fabricate(:post) }

  before { SiteSetting.shared_edits_enabled }

  describe "#shared_edits_enabled" do
    before do
      post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED] = true
      post.save_custom_fields
    end

    it "should return the right value when shared edits exists for a post" do
      payload = PostSerializer.new(post, scope: Guardian.new, root: false).as_json

      expect(payload[:shared_edits_enabled]).to eq(true)
    end

    it "should return the right value when shared edits exists in the topic view context" do
      serializer = PostSerializer.new(post, scope: Guardian.new, root: false)
      serializer.topic_view = TopicView.new(post.topic)

      expect(serializer.as_json[:shared_edits_enabled]).to eq(true)
    end
  end
end
