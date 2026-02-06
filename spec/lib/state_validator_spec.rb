# frozen_string_literal: true

require "rails_helper"
RSpec.describe DiscourseSharedEdits::StateValidator do
  describe ".validate_state" do
    it "returns valid for a properly encoded state" do
      state = DiscourseSharedEdits::Yjs.state_from_text("Hello world")[:state]
      result = described_class.validate_state(state)

      expect(result[:valid]).to eq(true)
      expect(result[:text]).to eq("Hello world")
      expect(result[:error]).to be_nil
    end

    it "returns invalid for nil state" do
      result = described_class.validate_state(nil)

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("State is nil")
    end

    it "returns invalid for empty state" do
      result = described_class.validate_state("")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("State is empty")
    end

    it "returns invalid for malformed base64" do
      result = described_class.validate_state("not-valid-base64!!!")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to include("Invalid base64")
    end

    it "returns invalid for corrupted Yjs state" do
      # Valid base64 but not a valid Yjs document
      corrupted = Base64.strict_encode64("random garbage data that is not yjs")
      result = described_class.validate_state(corrupted)

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to include("Yjs extraction failed")
    end

    it "handles unicode content correctly" do
      state = DiscourseSharedEdits::Yjs.state_from_text("Hello 🌍 世界")[:state]
      result = described_class.validate_state(state)

      expect(result[:valid]).to eq(true)
      expect(result[:text]).to eq("Hello 🌍 世界")
    end

    it "handles very large content" do
      large_text = "x" * 100_000
      state = DiscourseSharedEdits::Yjs.state_from_text(large_text)[:state]
      result = described_class.validate_state(state)

      expect(result[:valid]).to eq(true)
      expect(result[:text].length).to eq(100_000)
    end
  end

  describe ".validate_state_vector" do
    it "returns valid for a properly encoded state vector" do
      state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      sv = DiscourseSharedEdits::Yjs.get_state_vector(state)
      sv_b64 = Base64.strict_encode64(sv.pack("C*"))

      result = described_class.validate_state_vector(sv_b64)

      expect(result[:valid]).to eq(true)
      expect(result[:error]).to be_nil
    end

    it "returns invalid for nil state vector" do
      result = described_class.validate_state_vector(nil)

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("State vector is nil")
    end

    it "returns invalid for empty state vector" do
      result = described_class.validate_state_vector("")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("State vector is empty")
    end

    it "returns invalid for malformed base64" do
      result = described_class.validate_state_vector("not-valid-base64!!!")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to include("Invalid base64")
    end
  end

  describe ".validate_client_state_vector" do
    it "returns valid when client state vector matches server" do
      state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      sv = DiscourseSharedEdits::Yjs.get_state_vector(state)
      sv_b64 = Base64.strict_encode64(sv.pack("C*"))

      result = described_class.validate_client_state_vector(state, sv_b64)

      expect(result[:valid]).to eq(true)
      expect(result[:missing_update]).to be_nil
    end

    it "returns invalid with missing_update when client is behind server" do
      state1 = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      update = DiscourseSharedEdits::Yjs.update_from_state(state1, "Hello World")
      state2 = DiscourseSharedEdits::Yjs.apply_update(state1, update)[:state]

      client_sv = DiscourseSharedEdits::Yjs.get_state_vector(state1)
      client_sv_b64 = Base64.strict_encode64(client_sv.pack("C*"))

      result = described_class.validate_client_state_vector(state2, client_sv_b64)

      expect(result[:valid]).to eq(false)
      expect(result[:missing_update]).to be_present

      applied = DiscourseSharedEdits::Yjs.apply_update(state1, result[:missing_update])
      expect(applied[:text]).to eq("Hello World")
    end

    it "returns valid when client is ahead of server" do
      state1 = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      update = DiscourseSharedEdits::Yjs.update_from_state(state1, "Hello World")
      state2 = DiscourseSharedEdits::Yjs.apply_update(state1, update)[:state]

      client_sv = DiscourseSharedEdits::Yjs.get_state_vector(state2)
      client_sv_b64 = Base64.strict_encode64(client_sv.pack("C*"))

      result = described_class.validate_client_state_vector(state1, client_sv_b64)

      expect(result[:valid]).to eq(true)
    end

    it "returns error for invalid state vector" do
      state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]

      result = described_class.validate_client_state_vector(state, "invalid!!!")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to include("Invalid base64")
    end
  end

  describe ".should_snapshot?" do
    it "returns false for nil state" do
      expect(described_class.should_snapshot?(nil)).to eq(false)
    end

    it "returns false for empty state" do
      expect(described_class.should_snapshot?("")).to eq(false)
    end

    it "returns false for state below threshold" do
      state = DiscourseSharedEdits::Yjs.state_from_text("Hello world")[:state]
      expect(described_class.should_snapshot?(state)).to eq(false)
    end

    it "returns true for state above threshold" do
      # Create a state larger than 100KB by creating large text
      # The Yjs state will be even larger than the text due to CRDT metadata
      large_text = "x" * 120_000
      state = DiscourseSharedEdits::Yjs.state_from_text(large_text)[:state]
      expect(described_class.should_snapshot?(state)).to eq(true)
    end

    it "returns false for invalid base64" do
      expect(described_class.should_snapshot?("not-valid-base64!!!")).to eq(false)
    end

    it "returns false for large invalid base64 payloads" do
      invalid_state = "not-base64" * 20_000
      expect(described_class.should_snapshot?(invalid_state)).to eq(false)
    end
  end

  describe ".validate_update" do
    it "returns valid for a properly encoded update" do
      old_text = "Hello"
      new_text = "Hello world"
      update = DiscourseSharedEdits::Yjs.update_from_text_change(old_text, new_text)[:update]

      result = described_class.validate_update(update)

      expect(result[:valid]).to eq(true)
      expect(result[:error]).to be_nil
    end

    it "returns invalid for nil update" do
      result = described_class.validate_update(nil)

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("Update is nil")
    end

    it "returns invalid for empty update" do
      result = described_class.validate_update("")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to eq("Update is empty")
    end

    it "returns invalid for malformed base64" do
      result = described_class.validate_update("not-valid-base64!!!")

      expect(result[:valid]).to eq(false)
      expect(result[:error]).to include("Invalid base64")
    end
  end

  describe ".health_check" do
    fab!(:post) { Fabricate(:post, raw: "Original content") }

    it "returns not_initialized when no revisions exist" do
      report = described_class.health_check(post.id)

      expect(report[:state]).to eq(:not_initialized)
      expect(report[:healthy]).to eq(true)
    end

    it "returns healthy for properly initialized state" do
      SharedEditRevision.init!(post)

      report = described_class.health_check(post.id)

      expect(report[:state]).to eq(:initialized)
      expect(report[:healthy]).to eq(true)
      expect(report[:errors]).to be_empty
      expect(report[:current_text]).to eq(post.raw)
    end

    it "detects corrupted state" do
      SharedEditRevision.init!(post)
      revision = SharedEditRevision.find_by(post_id: post.id)
      revision.update_column(:raw, Base64.strict_encode64("corrupted data"))

      report = described_class.health_check(post.id)

      expect(report[:healthy]).to eq(false)
      expect(report[:errors]).not_to be_empty
      expect(report[:errors].first).to include("corrupted")
    end

    it "detects nil state in revision" do
      SharedEditRevision.init!(post)
      revision = SharedEditRevision.find_by(post_id: post.id)
      revision.update_column(:raw, nil)

      report = described_class.health_check(post.id)

      expect(report[:healthy]).to eq(false)
      expect(report[:errors]).to include("Latest revision has nil state")
    end

    it "reports version gaps as informational" do
      SharedEditRevision.init!(post)

      # Manually create a revision with a version gap
      state = DiscourseSharedEdits::Yjs.state_from_text("v5 content")[:state]
      SharedEditRevision.create!(
        post_id: post.id,
        client_id: "test",
        user_id: Discourse.system_user.id,
        version: 5, # Gap from version 1
        revision: "",
        raw: state,
      )

      report = described_class.health_check(post.id)

      # Version gaps are informational, not warnings - they don't affect functionality
      expect(report[:healthy]).to eq(true)
      expect(report[:version_gaps]).to be_present
      expect(report[:version_gaps].first[:expected]).to eq(2)
      expect(report[:version_gaps].first[:got]).to eq(5)
    end

    it "includes size metrics in the report" do
      SharedEditRevision.init!(post)

      report = described_class.health_check(post.id)

      expect(report[:state_size_bytes]).to be_a(Integer)
      expect(report[:state_size_bytes]).to be > 0
      expect(report[:text_size_bytes]).to be_a(Integer)
      expect(report[:text_size_bytes]).to be > 0
      expect(report[:bloat_ratio]).to be_a(Float)
      expect(report[:bloat_ratio]).to be > 0
    end

    it "adds warning when state exceeds snapshot threshold" do
      SharedEditRevision.init!(post)

      # Mock should_snapshot? to return true
      allow(described_class).to receive(:should_snapshot?).and_return(true)

      report = described_class.health_check(post.id)

      expect(report[:healthy]).to eq(true)
      expect(report[:warnings]).to include(match(/bloated.*snapshot will occur/))
    end
  end

  describe ".recover_from_post_raw" do
    fab!(:post) { Fabricate(:post, raw: "Recovery test content") }

    it "recovers from corrupted state" do
      SharedEditRevision.init!(post)
      revision = SharedEditRevision.find_by(post_id: post.id)
      revision.update_column(:raw, Base64.strict_encode64("corrupted"))
      initial_version = revision.version

      result = described_class.recover_from_post_raw(post.id)

      expect(result[:success]).to eq(true)
      expect(result[:message]).to include("recovered")
      expect(result[:new_version]).to eq(initial_version + 1)

      # Verify the new state is valid
      new_revision = SharedEditRevision.where(post_id: post.id).order("version desc").first
      text = DiscourseSharedEdits::Yjs.text_from_state(new_revision.raw)
      expect(text).to eq(post.raw)
    end

    it "refuses to recover healthy state without force" do
      SharedEditRevision.init!(post)

      result = described_class.recover_from_post_raw(post.id)

      expect(result[:success]).to eq(false)
      expect(result[:message]).to include("healthy")
    end

    it "recovers healthy state with force" do
      SharedEditRevision.init!(post)

      result = described_class.recover_from_post_raw(post.id, force: true)

      expect(result[:success]).to eq(true)
    end

    it "returns error for non-existent post" do
      result = described_class.recover_from_post_raw(999_999)

      expect(result[:success]).to eq(false)
      expect(result[:message]).to eq("Post not found")
    end

    it "preserves existing revisions and appends a recovery revision" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)

      # Add more revisions
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, "Modified content")
      SharedEditRevision.revise!(
        post_id: post.id,
        user_id: user.id,
        client_id: "test",
        update: update,
      )

      initial_count = SharedEditRevision.where(post_id: post.id).count

      # Corrupt the state
      SharedEditRevision
        .where(post_id: post.id)
        .order("version desc")
        .first
        .update_column(:raw, Base64.strict_encode64("corrupted"))

      result = described_class.recover_from_post_raw(post.id)

      expect(result[:success]).to eq(true)
      expect(SharedEditRevision.where(post_id: post.id).count).to eq(initial_count + 1)
      latest_revision = SharedEditRevision.where(post_id: post.id).order("version desc").first
      expect(latest_revision.client_id).to eq("recovery")
    end

    it "uses the shared edits commit lock during recovery" do
      SharedEditRevision.init!(post)

      allow(SharedEditRevision).to receive(:with_commit_lock).and_call_original

      described_class.recover_from_post_raw(post.id, force: true, skip_rate_limit: true)

      expect(SharedEditRevision).to have_received(:with_commit_lock).with(post.id)
    end
  end

  describe "recovery cooldown atomicity" do
    fab!(:post) { Fabricate(:post, raw: "Atomicity test content") }

    it "allows only one concurrent recovery cooldown acquisition" do
      cooldown_key = "shared_edits_recovery_cooldown_#{post.id}"
      counter_key = "shared_edits_recovery_count_#{post.id}"

      Discourse.redis.del(cooldown_key)
      Discourse.redis.del(counter_key)

      mutex = Mutex.new
      condition = ConditionVariable.new
      arrivals = 0

      allow(Discourse.redis).to receive(:exists?).and_wrap_original do
        mutex.synchronize do
          arrivals += 1
          condition.broadcast if arrivals == 2
          condition.wait(mutex) if arrivals < 2
        end
        false
      end

      results = []
      threads =
        2.times.map do
          Thread.new do
            result = described_class.send(:check_recovery_rate_limit, post.id)
            mutex.synchronize { results << result }
          end
        end
      threads.each(&:join)

      expect(results.count { |result| result[:allowed] }).to eq(1)
    ensure
      Discourse.redis.del(cooldown_key)
      Discourse.redis.del(counter_key)
    end
  end

  describe ".safe_apply_update" do
    fab!(:post)

    it "applies valid update successfully" do
      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      update = DiscourseSharedEdits::Yjs.update_from_state(initial_state, "Hello world")

      result = described_class.safe_apply_update(post.id, initial_state, update)

      expect(result[:text]).to eq("Hello world")
      expect(result[:state]).to be_present
    end

    it "raises InvalidUpdateError for invalid update" do
      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]

      expect {
        described_class.safe_apply_update(post.id, initial_state, "not-valid-base64!!!")
      }.to raise_error(DiscourseSharedEdits::StateValidator::InvalidUpdateError)
    end

    it "raises InvalidUpdateError for nil update" do
      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]

      expect { described_class.safe_apply_update(post.id, initial_state, nil) }.to raise_error(
        DiscourseSharedEdits::StateValidator::InvalidUpdateError,
      )
    end

    it "raises PostLengthExceededError when result exceeds max_post_length" do
      SiteSetting.max_post_length = 100

      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      long_text = "x" * 200
      update = DiscourseSharedEdits::Yjs.update_from_state(initial_state, long_text)

      expect { described_class.safe_apply_update(post.id, initial_state, update) }.to raise_error(
        DiscourseSharedEdits::StateValidator::PostLengthExceededError,
        /exceeds maximum allowed/,
      )
    end

    it "allows updates within max_post_length" do
      SiteSetting.max_post_length = 100

      initial_state = DiscourseSharedEdits::Yjs.state_from_text("Hello")[:state]
      valid_text = "x" * 50
      update = DiscourseSharedEdits::Yjs.update_from_state(initial_state, valid_text)

      result = described_class.safe_apply_update(post.id, initial_state, update)
      expect(result[:text]).to eq(valid_text)
    end

    it "rejects blank updates when previous text exists and allow flag is false" do
      SharedEditRevision.init!(post)
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, "")

      expect { described_class.safe_apply_update(post.id, state, update) }.to raise_error(
        DiscourseSharedEdits::StateValidator::UnexpectedBlankStateError,
      )
    end

    it "allows blank updates when allow flag is true" do
      SharedEditRevision.init!(post)
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, "")

      result = described_class.safe_apply_update(post.id, state, update, allow_blank_state: true)

      expect(result[:text]).to eq("")
    end
  end

  describe "concurrent edit simulation" do
    fab!(:post) { Fabricate(:post, raw: "Initial content here") }
    fab!(:user1, :user)
    fab!(:user2, :user)
    fab!(:user3, :user)

    def simulate_edit(post, user, new_text)
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, new_text)
      SharedEditRevision.revise!(
        post_id: post.id,
        user_id: user.id,
        client_id: "client-#{user.id}",
        update: update,
      )
    end

    it "handles rapid sequential edits without corruption" do
      SharedEditRevision.init!(post)

      10.times { |i| simulate_edit(post, user1, "Content v#{i + 1}") }

      health = described_class.health_check(post.id)

      expect(health[:healthy]).to eq(true)
      expect(health[:current_text]).to eq("Content v10")
      expect(health[:revision_count]).to eq(11)
    end

    it "handles alternating user edits" do
      SharedEditRevision.init!(post)
      users = [user1, user2, user3]

      10.times do |i|
        user = users[i % 3]
        simulate_edit(post, user, "Edit #{i + 1} by #{user.username}")
      end

      health = described_class.health_check(post.id)

      expect(health[:healthy]).to eq(true)
      expect(health[:current_text]).to include("Edit 10")
    end

    it "maintains state integrity after commit" do
      SharedEditRevision.init!(post)

      simulate_edit(post, user1, "First edit")
      simulate_edit(post, user2, "Second edit")

      SharedEditRevision.commit!(post.id)

      post.reload
      expect(post.raw).to eq("Second edit")

      simulate_edit(post, user3, "Third edit after commit")

      health = described_class.health_check(post.id)
      expect(health[:healthy]).to eq(true)
      expect(health[:current_text]).to eq("Third edit after commit")
    end
  end

  describe "edge case recovery scenarios" do
    fab!(:post) { Fabricate(:post, raw: "Edge case content") }

    it "recovers when all revisions have nil raw" do
      SharedEditRevision.init!(post)
      SharedEditRevision.where(post_id: post.id).update_all(raw: nil)

      health = described_class.health_check(post.id)
      expect(health[:healthy]).to eq(false)

      result = described_class.recover_from_post_raw(post.id)
      expect(result[:success]).to eq(true)

      health = described_class.health_check(post.id)
      expect(health[:healthy]).to eq(true)
    end

    it "recovers when revisions table is empty for post" do
      SharedEditRevision.where(post_id: post.id).delete_all

      result = described_class.recover_from_post_raw(post.id, force: true)
      expect(result[:success]).to eq(true)

      health = described_class.health_check(post.id)
      expect(health[:healthy]).to eq(true)
    end

    it "handles empty post.raw during recovery" do
      post.update_column(:raw, "")
      SharedEditRevision.init!(post)

      # Corrupt the state
      SharedEditRevision
        .where(post_id: post.id)
        .first
        .update_column(:raw, Base64.strict_encode64("corrupted"))

      result = described_class.recover_from_post_raw(post.id)
      expect(result[:success]).to eq(true)

      new_revision = SharedEditRevision.where(post_id: post.id).order("version desc").first
      expect(DiscourseSharedEdits::Yjs.text_from_state(new_revision.raw)).to eq("")
    end

    it "handles unicode post.raw during recovery" do
      post.update_column(:raw, "Hello 🌍🎉 世界 مرحبا")
      SharedEditRevision.init!(post)

      result = described_class.recover_from_post_raw(post.id, force: true)
      expect(result[:success]).to eq(true)

      new_revision = SharedEditRevision.where(post_id: post.id).order("version desc").first
      expect(DiscourseSharedEdits::Yjs.text_from_state(new_revision.raw)).to eq("Hello 🌍🎉 世界 مرحبا")
    end
  end

  describe ".recover_from_text" do
    fab!(:post) { Fabricate(:post, raw: "Text recovery content") }

    it "uses the shared edits commit lock during text recovery" do
      allow(SharedEditRevision).to receive(:with_commit_lock).and_call_original

      described_class.recover_from_text(post.id, "Recovered text")

      expect(SharedEditRevision).to have_received(:with_commit_lock).with(post.id)
    end

    it "preserves existing revisions and appends a text recovery revision" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)

      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, "Existing edit")
      SharedEditRevision.revise!(
        post_id: post.id,
        user_id: user.id,
        client_id: "test",
        update: update,
      )

      initial_count = SharedEditRevision.where(post_id: post.id).count

      result = described_class.recover_from_text(post.id, "Recovered text")

      expect(result[:success]).to eq(true)
      expect(SharedEditRevision.where(post_id: post.id).count).to eq(initial_count + 1)
      latest_revision = SharedEditRevision.where(post_id: post.id).order("version desc").first
      expect(latest_revision.client_id).to eq("recovery")
      expect(DiscourseSharedEdits::Yjs.text_from_state(latest_revision.raw)).to eq("Recovered text")
    end
  end
end
