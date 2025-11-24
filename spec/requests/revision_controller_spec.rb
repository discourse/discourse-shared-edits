# frozen_string_literal: true

RSpec.describe DiscourseSharedEdits::RevisionController do
  fab!(:post1) { Fabricate(:post, raw: "Hello World, testing shared edits") }
  fab!(:admin)
  fab!(:user)

  describe "#enable" do
    context "when admin" do
      before { sign_in admin }

      it "returns 404 when plugin is disabled" do
        SiteSetting.shared_edits_enabled = false
        put "/shared_edits/p/#{post1.id}/enable"
        expect(response.status).to eq(404)
      end

      it "enables shared edits on a post" do
        put "/shared_edits/p/#{post1.id}/enable"
        expect(response.status).to eq(200)

        post1.reload
        expect(post1.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]).to eq(true)
      end
    end

    context "when regular user" do
      before { sign_in user }

      it "returns 403" do
        put "/shared_edits/p/#{post1.id}/enable"
        expect(response.status).to eq(403)
      end
    end

    context "when anonymous" do
      it "returns 403" do
        put "/shared_edits/p/#{post1.id}/enable"
        expect(response.status).to eq(403)
      end
    end
  end

  describe "#disable" do
    context "when admin" do
      before { sign_in admin }

      it "disables shared edits on a post" do
        SharedEditRevision.toggle_shared_edits!(post1.id, true)

        put "/shared_edits/p/#{post1.id}/disable"
        expect(response.status).to eq(200)

        post1.reload
        expect(post1.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]).to be_nil
      end
    end

    context "when regular user" do
      before { sign_in user }

      it "returns 403" do
        put "/shared_edits/p/#{post1.id}/disable"
        expect(response.status).to eq(403)
      end
    end
  end

  describe "#latest" do
    before do
      sign_in user
      SharedEditRevision.toggle_shared_edits!(post1.id, true)
    end

    def latest_state_for(post)
      SharedEditRevision.where(post_id: post.id).order("version desc").limit(1).pluck(:raw).first
    end

    it "returns the latest version" do
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

    it "returns 404 when no revisions exist" do
      SharedEditRevision.where(post_id: post1.id).delete_all

      get "/shared_edits/p/#{post1.id}"
      expect(response.status).to eq(404)
    end

    it "returns 404 for non-existent post" do
      get "/shared_edits/p/999999"
      expect(response.status).to eq(404)
    end
  end

  describe "#commit" do
    before { sign_in user }

    it "commits pending changes to the post" do
      SharedEditRevision.toggle_shared_edits!(post1.id, true)
      new_text = "committed content " + post1.raw
      state = SharedEditRevision.where(post_id: post1.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, new_text)

      SharedEditRevision.revise!(
        post_id: post1.id,
        user_id: user.id,
        client_id: "test",
        update: update,
      )

      put "/shared_edits/p/#{post1.id}/commit"
      expect(response.status).to eq(200)

      post1.reload
      expect(post1.raw).to eq(new_text)
    end

    it "returns 404 for non-existent post" do
      put "/shared_edits/p/999999/commit"
      expect(response.status).to eq(404)
    end
  end

  describe "#revise" do
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

    it "requires client_id parameter" do
      put "/shared_edits/p/#{post1.id}", params: { update: "test" }
      expect(response.status).to eq(400)
    end

    it "requires update parameter" do
      put "/shared_edits/p/#{post1.id}", params: { client_id: "abc" }
      expect(response.status).to eq(400)
    end

    it "schedules a deferred commit" do
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
  end
end
