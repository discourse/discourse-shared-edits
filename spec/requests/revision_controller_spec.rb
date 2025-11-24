# frozen_string_literal: true

RSpec.describe DiscourseSharedEdits::RevisionController do
  fab!(:post1, :post)
  fab!(:admin)
  fab!(:user)

  context :admin do
    before { sign_in admin }

    it "is hard disabled when plugin is disabled" do
      SiteSetting.shared_edits_enabled = false
      put "/shared_edits/p/#{post1.id}/enable"
      expect(response.status).to eq(404)
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

    def latest_state_for(post)
      SharedEditRevision.where(post_id: post.id).order("version desc").limit(1).pluck(:raw).first
    end

    it "can submit edits on a post" do
      new_text = "1234" + post1.raw[4..]
      latest_state = latest_state_for(post1)

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "abc",
            update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, new_text),
          }
      expect(response.status).to eq(200)

      SharedEditRevision.commit!(post1.id)

      post1.reload
      expect(post1.raw[0..3]).to eq("1234")
    end

    it "can get the latest version" do
      new_text = "1234" + post1.raw[4..]
      latest_state = latest_state_for(post1)

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "abc",
            update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, new_text),
          }

      get "/shared_edits/p/#{post1.id}"
      expect(response.status).to eq(200)

      raw = response.parsed_body["raw"]
      version = response.parsed_body["version"]
      state = response.parsed_body["state"]

      expect(raw[0..3]).to eq("1234")
      expect(version).to eq(2)
      expect(state).to be_present
    end

    it "will defer commit" do
      Discourse.redis.del SharedEditRevision.will_commit_key(post1.id)

      new_text = "1234" + post1.raw[4..]
      latest_state = latest_state_for(post1)

      Sidekiq::Testing.inline! do
        put "/shared_edits/p/#{post1.id}",
            params: {
              client_id: "abc",
              update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, new_text),
            }

        get "/shared_edits/p/#{post1.id}"
        expect(response.status).to eq(200)

        raw = response.parsed_body["raw"]
        version = response.parsed_body["version"]

        expect(raw[0..3]).to eq("1234")
        expect(version).to eq(2)
      end
    end

    it "accepts multiple updates without client-side version tracking" do
      first_text = "abcd" + post1.raw[4..]
      second_text = "wxyz" + post1.raw[4..]
      latest_state = latest_state_for(post1)

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "abc",
            update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, first_text),
          }

      latest_state = latest_state_for(post1)

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "123",
            update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, second_text),
          }

      expect(response.status).to eq(200)

      SharedEditRevision.commit!(post1.id)

      post1.reload
      expect(post1.raw[0..3]).to eq("wxyz")
    end

    it "can not enable revisions as normal user" do
      put "/shared_edits/p/#{post1.id}/enable"
      expect(response.status).to eq(403)
      put "/shared_edits/p/#{post1.id}/disable"
      expect(response.status).to eq(403)
    end
  end
end
