# frozen_string_literal: true

RSpec.describe DiscourseSharedEdits::RevisionController do
  fab!(:user)
  fab!(:tl4_user) { Fabricate(:user, trust_level: TrustLevel[4]) }
  fab!(:post1) { Fabricate(:post, user: user, raw: "Hello World, testing shared edits") }
  fab!(:admin)

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
      sign_in admin
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

    it "includes message_bus_last_id in response" do
      get "/shared_edits/p/#{post1.id}"

      expect(response.status).to eq(200)
      expect(response.parsed_body).to have_key("message_bus_last_id")
      expect(response.parsed_body["message_bus_last_id"]).to be_a(Integer)
    end

    it "returns correct message_bus_last_id after revisions" do
      get "/shared_edits/p/#{post1.id}"
      initial_last_id = response.parsed_body["message_bus_last_id"]

      new_text = "Updated content here"
      latest_state = latest_state_for(post1)

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "abc",
            update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, new_text),
          }

      get "/shared_edits/p/#{post1.id}"
      new_last_id = response.parsed_body["message_bus_last_id"]

      expect(new_last_id).to be > initial_last_id
    end

    it "allows client to subscribe without missing messages using message_bus_last_id" do
      get "/shared_edits/p/#{post1.id}"
      last_id_at_fetch = response.parsed_body["message_bus_last_id"]

      new_text = "Edit made after fetch but before subscribe"
      latest_state = latest_state_for(post1)

      messages =
        MessageBus.track_publish("/shared_edits/#{post1.id}") do
          put "/shared_edits/p/#{post1.id}",
              params: {
                client_id: "other_client",
                update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, new_text),
              }
        end

      expect(messages.length).to eq(1)

      backlog = MessageBus.backlog("/shared_edits/#{post1.id}", last_id_at_fetch)

      expect(backlog.length).to eq(1)
      expect(backlog.first.data["version"]).to eq(2)
    end
  end

  describe "#commit" do
    before { sign_in admin }

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

    it "returns 404 when shared edits are not enabled on the post" do
      put "/shared_edits/p/#{post1.id}/commit"
      expect(response.status).to eq(404)
    end
  end

  describe "#revise" do
    before do
      sign_in admin
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

    it "rejects blanking a post without explicit allow flag" do
      latest_state = latest_state_for(post1)
      blank_update = DiscourseSharedEdits::Yjs.update_from_state(latest_state, "")

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "abc",
            update: blank_update,
          }

      expect(response.status).to eq(422)
      expect(response.parsed_body["error"]).to eq("blank_state_rejected")
    end

    it "allows blanking a post when allow flag is provided" do
      latest_state = latest_state_for(post1)
      blank_update = DiscourseSharedEdits::Yjs.update_from_state(latest_state, "")

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "abc",
            update: blank_update,
            allow_blank_state: true,
          }

      expect(response.status).to eq(200)
      expect(response.parsed_body["version"]).to eq(2)
    end

    it "requires client_id parameter" do
      put "/shared_edits/p/#{post1.id}", params: { update: "test" }
      expect(response.status).to eq(400)
    end

    it "requires update or awareness parameter" do
      put "/shared_edits/p/#{post1.id}", params: { client_id: "abc" }
      expect(response.status).to eq(400)
    end

    it "accepts awareness-only updates without document update" do
      messages =
        MessageBus.track_publish("/shared_edits/#{post1.id}") do
          put "/shared_edits/p/#{post1.id}",
              params: {
                client_id: "abc",
                awareness: Base64.strict_encode64("awareness_data"),
              }
        end

      expect(response.status).to eq(200)
      expect(messages.length).to eq(1)
      expect(messages.first.data[:awareness]).to be_present
      expect(messages.first.data[:client_id]).to eq("abc")
    end

    it "does not create revision for awareness-only updates" do
      initial_count = SharedEditRevision.where(post_id: post1.id).count

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "abc",
            awareness: Base64.strict_encode64("awareness_data"),
          }

      expect(response.status).to eq(200)
      expect(SharedEditRevision.where(post_id: post1.id).count).to eq(initial_count)
    end

    it "rejects invalid awareness payloads" do
      put "/shared_edits/p/#{post1.id}", params: { client_id: "abc", awareness: "not-base64" }

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

    it "handles corrupted state with automatic recovery" do
      # Corrupt the state
      revision = SharedEditRevision.where(post_id: post1.id).first
      revision.update_column(:raw, Base64.strict_encode64("corrupted data"))

      put "/shared_edits/p/#{post1.id}", params: { client_id: "abc", update: "some_update" }

      expect(response.status).to eq(409)
      expect(response.parsed_body["error"]).to eq("state_recovered")
      expect(response.parsed_body["recovered_version"]).to eq(1)
    end

    it "returns 404 when shared edits not enabled on post" do
      post1.custom_fields.delete(DiscourseSharedEdits::SHARED_EDITS_ENABLED)
      post1.save_custom_fields

      put "/shared_edits/p/#{post1.id}", params: { client_id: "abc", update: "test" }

      expect(response.status).to eq(404)
    end

    it "returns 403 when the user cannot edit the post" do
      other_user = Fabricate(:user)
      sign_in(other_user)

      latest_state = latest_state_for(post1)
      new_text = "Collaborative edit from another user"

      put "/shared_edits/p/#{post1.id}",
          params: {
            client_id: "other-client",
            update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, new_text),
          }

      expect(response.status).to eq(403)
    end

    describe "rate limiting" do
      # Use TL4 user for rate limiting tests since admins/mods bypass rate limits
      # TL4 users can edit others' posts but don't bypass rate limiting
      before { sign_in tl4_user }

      it "allows requests within the rate limit" do
        RateLimiter.enable

        5.times do
          latest_state = latest_state_for(post1)
          new_text = "Edit #{SecureRandom.hex(4)}"
          put "/shared_edits/p/#{post1.id}",
              params: {
                client_id: "abc",
                update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, new_text),
              }
          expect(response.status).to eq(200)
        end
      ensure
        RateLimiter.disable
      end

      it "returns 429 when rate limit is exceeded" do
        RateLimiter.enable

        # Exhaust the rate limit (60 per minute)
        61.times do |i|
          latest_state = latest_state_for(post1)
          new_text = "Edit #{i}"
          put "/shared_edits/p/#{post1.id}",
              params: {
                client_id: "abc",
                update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, new_text),
              }
        end

        expect(response.status).to eq(429)
        expect(response.parsed_body["extras"]["wait_seconds"]).to be_present
      ensure
        RateLimiter.disable
      end

      it "rate limits per post independently" do
        RateLimiter.enable

        post2 = Fabricate(:post, user: tl4_user)
        SharedEditRevision.toggle_shared_edits!(post2.id, true)

        # Make requests to post1
        latest_state = latest_state_for(post1)
        put "/shared_edits/p/#{post1.id}",
            params: {
              client_id: "abc",
              update: DiscourseSharedEdits::Yjs.update_from_state(latest_state, "Edit post1"),
            }
        expect(response.status).to eq(200)

        # Make requests to post2 - should not be affected by post1's rate limit
        latest_state2 = SharedEditRevision.where(post_id: post2.id).order("version desc").first.raw
        put "/shared_edits/p/#{post2.id}",
            params: {
              client_id: "abc",
              update: DiscourseSharedEdits::Yjs.update_from_state(latest_state2, "Edit post2"),
            }
        expect(response.status).to eq(200)
      ensure
        RateLimiter.disable
      end
    end
  end

  describe "#health" do
    context "when admin" do
      before do
        sign_in admin
        SharedEditRevision.toggle_shared_edits!(post1.id, true)
      end

      it "returns health status for a post" do
        get "/shared_edits/p/#{post1.id}/health"

        expect(response.status).to eq(200)
        body = response.parsed_body
        expect(body["healthy"]).to eq(true)
        expect(body["state"]).to eq("initialized")
        expect(body["current_text"]).to eq(post1.raw)
      end

      it "detects corrupted state" do
        revision = SharedEditRevision.where(post_id: post1.id).first
        revision.update_column(:raw, Base64.strict_encode64("corrupted"))

        get "/shared_edits/p/#{post1.id}/health"

        expect(response.status).to eq(200)
        body = response.parsed_body
        expect(body["healthy"]).to eq(false)
        expect(body["errors"]).not_to be_empty
      end

      it "returns not_initialized for posts without shared edits" do
        post2 = Fabricate(:post)

        get "/shared_edits/p/#{post2.id}/health"

        expect(response.status).to eq(200)
        body = response.parsed_body
        expect(body["state"]).to eq("not_initialized")
      end
    end

    context "when regular user" do
      before { sign_in user }

      it "returns 403" do
        get "/shared_edits/p/#{post1.id}/health"
        expect(response.status).to eq(403)
      end
    end
  end

  describe "#recover" do
    context "when admin" do
      before do
        sign_in admin
        SharedEditRevision.toggle_shared_edits!(post1.id, true)
      end

      it "recovers corrupted state" do
        revision = SharedEditRevision.where(post_id: post1.id).first
        revision.update_column(:raw, Base64.strict_encode64("corrupted"))

        messages =
          MessageBus.track_publish("/shared_edits/#{post1.id}") do
            post "/shared_edits/p/#{post1.id}/recover"
          end

        expect(response.status).to eq(200)
        body = response.parsed_body
        expect(body["success"]).to eq(true)

        expect(messages.length).to eq(1)
        expect(messages.first.data[:action]).to eq("resync")
      end

      it "refuses to recover healthy state without force" do
        post "/shared_edits/p/#{post1.id}/recover"

        expect(response.status).to eq(422)
        body = response.parsed_body
        expect(body["success"]).to eq(false)
        expect(body["message"]).to include("healthy")
      end

      it "recovers healthy state with force parameter" do
        post "/shared_edits/p/#{post1.id}/recover", params: { force: "true" }

        expect(response.status).to eq(200)
        body = response.parsed_body
        expect(body["success"]).to eq(true)
      end

      it "returns 404 for non-existent post" do
        post "/shared_edits/p/999999/recover"
        expect(response.status).to eq(404)
      end
    end

    context "when regular user" do
      before { sign_in user }

      it "returns 403" do
        post "/shared_edits/p/#{post1.id}/recover"
        expect(response.status).to eq(403)
      end
    end
  end

  describe "#latest with automatic recovery" do
    before do
      sign_in admin
      SharedEditRevision.toggle_shared_edits!(post1.id, true)
    end

    it "automatically recovers corrupted state on access" do
      revision = SharedEditRevision.where(post_id: post1.id).first
      revision.update_column(:raw, Base64.strict_encode64("corrupted"))

      get "/shared_edits/p/#{post1.id}"

      expect(response.status).to eq(200)
      body = response.parsed_body
      expect(body["raw"]).to eq(post1.raw)
      expect(body["version"]).to eq(1)
    end
  end

  describe "#reset" do
    def latest_state_for(post)
      SharedEditRevision.where(post_id: post.id).order("version desc").limit(1).pluck(:raw).first
    end

    context "when admin" do
      before do
        sign_in admin
        SharedEditRevision.toggle_shared_edits!(post1.id, true)
      end

      it "resets history and notifies clients" do
        # Make some edits to build up history
        state = latest_state_for(post1)
        update = DiscourseSharedEdits::Yjs.update_from_state(state, "Edit 1")
        SharedEditRevision.revise!(
          post_id: post1.id,
          user_id: admin.id,
          client_id: "test",
          update: update,
        )

        state = latest_state_for(post1)
        update = DiscourseSharedEdits::Yjs.update_from_state(state, "Edit 2")
        SharedEditRevision.revise!(
          post_id: post1.id,
          user_id: admin.id,
          client_id: "test",
          update: update,
        )

        expect(SharedEditRevision.where(post_id: post1.id).count).to eq(3)

        messages =
          MessageBus.track_publish("/shared_edits/#{post1.id}") do
            post "/shared_edits/p/#{post1.id}/reset"
          end

        expect(response.status).to eq(200)
        body = response.parsed_body
        expect(body["success"]).to eq(true)
        expect(body["version"]).to eq(1)

        expect(SharedEditRevision.where(post_id: post1.id).count).to eq(1)

        expect(messages.length).to eq(1)
        expect(messages.first.data[:action]).to eq("resync")
      end

      it "commits pending changes before reset" do
        state = latest_state_for(post1)
        new_content = "New content from edit"
        update = DiscourseSharedEdits::Yjs.update_from_state(state, new_content)
        SharedEditRevision.revise!(
          post_id: post1.id,
          user_id: admin.id,
          client_id: "test",
          update: update,
        )

        post "/shared_edits/p/#{post1.id}/reset"

        expect(response.status).to eq(200)
        post1.reload
        expect(post1.raw).to eq(new_content)
      end
    end

    context "when regular user" do
      before { sign_in user }

      it "returns 403" do
        post "/shared_edits/p/#{post1.id}/reset"
        expect(response.status).to eq(403)
      end
    end
  end
end
