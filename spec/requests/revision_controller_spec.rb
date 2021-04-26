# frozen_string_literal: true
require 'rails_helper'

describe ::DiscourseSharedEdits::RevisionController do
  fab!(:post1) do
    Fabricate(:post)
  end

  fab!(:admin) do
    Fabricate(:admin)
  end

  fab!(:user) do
    Fabricate(:user)
  end

  context :admin do
    before do
      sign_in admin
    end

    it "is hard disabled when plugin is disabled" do
      SiteSetting.shared_edits_enabled = false
      put "/shared_edits/p/#{post1.id}/enable"
      expect(response.status).to eq(403)
    end

    it "is able to enable revisions on a post" do

      put "/shared_edits/p/#{post1.id}/enable"
      expect(response.status).to eq(200)

      post1.reload
      expect(post1.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]).to eq(true)

      put "/shared_edits/p/#{post1.id}/disable"
      expect(response.status).to eq(200)

      post1.reload
      expect(post1.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]).to eq(nil)
    end
  end

  context :user do
    before do
      sign_in user
      SharedEditRevision.toggle_shared_edits!(post1.id, true)
    end

    it "can submit edits on a post" do
      put "/shared_edits/p/#{post1.id}", params: {
        client_id: 'abc', version: 1, revision: [{ d: 4 }, "1234"].to_json
      }
      expect(response.status).to eq(200)

      SharedEditRevision.commit!(post1.id)

      post1.reload
      expect(post1.raw[0..3]).to eq("1234")
    end

    it "can get the latest version" do
      put "/shared_edits/p/#{post1.id}", params: {
        client_id: 'abc', version: 1, revision: [{ d: 4 }, "1234"].to_json
      }

      get "/shared_edits/p/#{post1.id}"
      expect(response.status).to eq(200)

      raw = response.parsed_body["raw"]
      version = response.parsed_body["version"]

      expect(raw[0..3]).to eq("1234")
      expect(version).to eq(2)
    end

    it "will defer commit" do
      Discourse.redis.del SharedEditRevision.will_commit_key(post1.id)

      Sidekiq::Testing.inline! do
        put "/shared_edits/p/#{post1.id}", params: {
          client_id: 'abc', version: 1, revision: [{ d: 4 }, "1234"].to_json
        }

        get "/shared_edits/p/#{post1.id}"
        expect(response.status).to eq(200)

        raw = response.parsed_body["raw"]
        version = response.parsed_body["version"]

        expect(raw[0..3]).to eq("1234")
        expect(version).to eq(2)
      end
    end

    it "can submit old edits to a post and get sane info" do
      put "/shared_edits/p/#{post1.id}", params: {
        client_id: 'abc', version: 1, revision: [{ d: 4 }, "1234"].to_json
      }

      put "/shared_edits/p/#{post1.id}", params: {
        client_id: '123', version: 1, revision: [4, { d: 4 }, "abcd"].to_json
      }
      expect(response.status).to eq(200)

      SharedEditRevision.commit!(post1.id)

      post1.reload
      expect(post1.raw[4..7]).to eq("abcd")
    end

    it "can not enable revisions as normal user" do
      put "/shared_edits/p/#{post1.id}/enable"
      expect(response.status).to eq(403)
      put "/shared_edits/p/#{post1.id}/disable"
      expect(response.status).to eq(403)
    end
  end

end
