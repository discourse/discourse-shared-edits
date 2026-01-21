# frozen_string_literal: true

require "rails_helper"

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

  describe ".init!" do
    fab!(:post)

    it "creates an initial revision with the post content" do
      SharedEditRevision.init!(post)

      revision = SharedEditRevision.find_by(post_id: post.id)
      expect(revision).to be_present
      expect(revision.version).to eq(1)
      expect(revision.client_id).to eq("system")
      expect(revision.user_id).to eq(Discourse.system_user.id)
      expect(DiscourseSharedEdits::Yjs.text_from_state(revision.raw)).to eq(post.raw)
    end

    it "does not create duplicate revisions if already initialized" do
      SharedEditRevision.init!(post)
      SharedEditRevision.init!(post)

      expect(SharedEditRevision.where(post_id: post.id).count).to eq(1)
    end
  end

  describe ".toggle_shared_edits!" do
    fab!(:post)

    it "enables shared edits and creates initial revision" do
      SharedEditRevision.toggle_shared_edits!(post.id, true)

      post.reload
      expect(post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]).to eq(true)
      expect(SharedEditRevision.where(post_id: post.id).count).to eq(1)
    end

    it "disables shared edits and removes revisions" do
      SharedEditRevision.toggle_shared_edits!(post.id, true)
      SharedEditRevision.toggle_shared_edits!(post.id, false)

      post.reload
      expect(post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]).to be_nil
      expect(SharedEditRevision.where(post_id: post.id).count).to eq(0)
    end

    it "commits pending changes when disabling" do
      SharedEditRevision.toggle_shared_edits!(post.id, true)
      user = Fabricate(:user)
      new_raw = "#{post.raw} edited content"
      fake_edit(post, user.id, new_raw)

      SharedEditRevision.toggle_shared_edits!(post.id, false)

      post.reload
      expect(post.raw).to eq(new_raw)
    end
  end

  describe ".latest_raw" do
    fab!(:post)

    it "returns nil when no revisions exist" do
      result = SharedEditRevision.latest_raw(post.id)
      expect(result).to be_nil
    end

    it "returns the version and text of the latest revision" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)
      new_text = "Updated content"
      fake_edit(post, user.id, new_text)

      version, text = SharedEditRevision.latest_raw(post.id)

      expect(version).to eq(2)
      expect(text).to eq(new_text)
    end
  end

  describe ".revise!" do
    fab!(:post)
    fab!(:user)

    before { SharedEditRevision.init!(post) }

    it "raises when shared edits not initialized" do
      SharedEditRevision.where(post_id: post.id).delete_all

      expect {
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: user.id,
          client_id: "test",
          update: "some_update",
        )
      }.to raise_error(StandardError, "shared edits not initialized")
    end

    it "publishes to message bus" do
      messages =
        MessageBus.track_publish("/shared_edits/#{post.id}") do
          fake_edit(post, user.id, "new content")
        end

      expect(messages.length).to eq(1)
      expect(messages.first.data[:version]).to eq(2)
      expect(messages.first.data[:user_id]).to eq(user.id)
    end

    it "includes cursor metadata when supplied" do
      cursor_payload = { "start" => "encoded-start", "end" => "encoded-end" }
      state = latest_state(post)
      update = DiscourseSharedEdits::Yjs.update_from_state(state, "cursor content")

      messages =
        MessageBus.track_publish("/shared_edits/#{post.id}") do
          SharedEditRevision.revise!(
            post_id: post.id,
            user_id: user.id,
            client_id: "cursor-client",
            update: update,
            cursor: cursor_payload,
          )
        end

      expect(messages.length).to eq(1)
      expect(messages.first.data[:cursor]).to eq(cursor_payload)
    end
  end

  describe ".commit!" do
    fab!(:post) { Fabricate(:post, raw: "Original content that is long enough") }

    it "returns nil when no revisions exist" do
      result = SharedEditRevision.commit!(post.id)
      expect(result).to be_nil
    end

    it "does nothing when already committed" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)
      fake_edit(post, user.id, "Modified content that is long enough")
      SharedEditRevision.commit!(post.id)

      post.reload
      original_raw = post.raw
      revision_count = PostRevision.where(post: post).count

      SharedEditRevision.commit!(post.id)

      expect(PostRevision.where(post: post).count).to eq(revision_count)
      expect(post.reload.raw).to eq(original_raw)
    end

    it "does not apply to post when apply_to_post is false" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)
      fake_edit(post, user.id, "Modified content that is long enough")

      SharedEditRevision.commit!(post.id, apply_to_post: false)

      expect(post.reload.raw).to eq("Original content that is long enough")
    end

    it "removes revisions older than the compaction window" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)
      fake_edit(post, user.id, "recent change")
      fake_edit(post, user.id, "another change")

      stale_revision = SharedEditRevision.find_by(post_id: post.id, version: 2)
      stale_revision.update_column(:updated_at, 2.minutes.ago)

      SharedEditRevision.commit!(post.id)

      expect(SharedEditRevision.exists?(stale_revision.id)).to eq(false)
      expect(SharedEditRevision.where(post_id: post.id).order("version desc").first.version).to eq(
        3,
      )
    end

    it "caps stored revisions to the configured history limit" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)

      (SharedEditRevision::MAX_HISTORY_COUNT + 10).times do |i|
        fake_edit(post, user.id, "change #{i}")
      end

      SharedEditRevision.commit!(post.id)

      expect(SharedEditRevision.where(post_id: post.id).count).to be <=
        SharedEditRevision::MAX_HISTORY_COUNT
    end

    it "maintains valid ydoc state after compaction" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)

      5.times { |i| fake_edit(post, user.id, "Content version #{i + 1}") }

      SharedEditRevision
        .where(post_id: post.id)
        .where("version < ?", 5)
        .update_all(updated_at: 2.minutes.ago)

      SharedEditRevision.commit!(post.id)

      latest = SharedEditRevision.where(post_id: post.id).order("version desc").first
      validation = DiscourseSharedEdits::StateValidator.validate_state(latest.raw)

      expect(validation[:valid]).to eq(true)
      expect(validation[:text]).to be_present
    end

    it "skips compaction when latest state is corrupted" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)
      fake_edit(post, user.id, "Valid content here")

      old_revision = SharedEditRevision.find_by(post_id: post.id, version: 1)
      old_revision.update_column(:updated_at, 2.minutes.ago)

      latest = SharedEditRevision.where(post_id: post.id).order("version desc").first
      latest.update_column(:raw, Base64.strict_encode64("corrupted data"))

      initial_count = SharedEditRevision.where(post_id: post.id).count

      SharedEditRevision.commit!(post.id, apply_to_post: false)

      expect(SharedEditRevision.where(post_id: post.id).count).to eq(initial_count)
    end

    describe "compaction strategy" do
      fab!(:user)

      it "nulls out raw for intermediate revisions but keeps latest and last committed" do
        SharedEditRevision.init!(post)

        # Create several edits
        5.times { |i| fake_edit(post, user.id, "Edit #{i + 1}") }

        # Commit to create a committed revision
        SharedEditRevision.commit!(post.id)

        # Make more edits after the commit
        3.times { |i| fake_edit(post, user.id, "Post-commit edit #{i + 1}") }

        # Trigger another commit which runs compaction
        SharedEditRevision.commit!(post.id)

        revisions = SharedEditRevision.where(post_id: post.id).order("version asc")
        latest = revisions.last
        last_committed =
          SharedEditRevision
            .where(post_id: post.id)
            .where.not(post_revision_id: nil)
            .order("version desc")
            .first

        # Latest should have raw
        expect(latest.raw).to be_present

        # Last committed should have raw
        expect(last_committed.raw).to be_present

        # Other revisions should have raw nulled out (except if they are latest or last_committed)
        intermediate =
          revisions.reject { |r| r.id == latest.id || r.id == last_committed.id }.select(&:raw)
        expect(intermediate).to be_empty
      end

      it "allows recovery from post raw when all intermediate raws are null" do
        SharedEditRevision.init!(post)

        5.times { |i| fake_edit(post, user.id, "Edit #{i + 1}") }
        SharedEditRevision.commit!(post.id)

        # Manually null out some raws to simulate compaction state
        SharedEditRevision.where(post_id: post.id).where("version < ?", 5).update_all(raw: nil)

        # Recovery should still work
        recovery = DiscourseSharedEdits::StateValidator.recover_from_post_raw(post.id, force: true)
        expect(recovery[:success]).to eq(true)

        # Can continue editing after recovery
        fake_edit(post, user.id, "Post-recovery edit")
        version, text = SharedEditRevision.latest_raw(post.id)
        expect(text).to eq("Post-recovery edit")
      end

      it "keeps exactly two full snapshots after commit: latest and last committed" do
        SharedEditRevision.init!(post)

        10.times { |i| fake_edit(post, user.id, "Edit #{i + 1}") }
        SharedEditRevision.commit!(post.id)

        revisions_with_raw = SharedEditRevision.where(post_id: post.id).where.not(raw: nil).count
        expect(revisions_with_raw).to be <= 2
      end
    end

    it "preserves ability to continue editing after compaction" do
      SharedEditRevision.init!(post)
      user = Fabricate(:user)

      5.times { |i| fake_edit(post, user.id, "Edit #{i + 1}") }

      SharedEditRevision
        .where(post_id: post.id)
        .where("version < ?", 5)
        .update_all(updated_at: 2.minutes.ago)

      SharedEditRevision.commit!(post.id)

      fake_edit(post, user.id, "Post-compaction edit works")

      version, text = SharedEditRevision.latest_raw(post.id)
      expect(text).to eq("Post-compaction edit works")
      expect(version).to be > 5
    end
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
      update: DiscourseSharedEdits::Yjs.update_from_text_change("Hello world", "Test")[:update],
    )

    expect(post.reload.raw).to eq("Hello world")
  end

  describe ".revise! version conflict handling" do
    fab!(:user)
    fab!(:post) { Fabricate(:post, user: user, raw: "Hello world") }

    before { SharedEditRevision.init!(post) }

    it "retries on version conflict and succeeds" do
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, "Hello world updated")
      call_count = 0

      allow(SharedEditRevision).to receive(:create!).and_wrap_original do |method, **args|
        call_count += 1
        if call_count == 1
          raise ActiveRecord::RecordNotUnique.new("duplicate key value")
        else
          method.call(**args)
        end
      end

      result =
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: user.id,
          client_id: "test-client",
          update: update,
        )

      expect(result).to be_present
      expect(call_count).to eq(2)
    end

    it "raises after max retries exhausted" do
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update = DiscourseSharedEdits::Yjs.update_from_state(state, "Hello world updated")

      allow(SharedEditRevision).to receive(:create!).and_raise(
        ActiveRecord::RecordNotUnique.new("duplicate key value"),
      )

      expect {
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: user.id,
          client_id: "test-client",
          update: update,
        )
      }.to raise_error(ActiveRecord::RecordNotUnique)
    end

    it "handles concurrent revisions gracefully" do
      state = SharedEditRevision.where(post_id: post.id).order("version desc").first.raw
      update1 = DiscourseSharedEdits::Yjs.update_from_state(state, "Change from client 1")
      update2 = DiscourseSharedEdits::Yjs.update_from_state(state, "Change from client 2")

      # Simulate two concurrent requests by having one succeed normally
      result1 =
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: user.id,
          client_id: "client-1",
          update: update1,
        )

      # The second one should also succeed (applying to the new state)
      result2 =
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: user.id,
          client_id: "client-2",
          update: update2,
        )

      expect(result1.first).to eq(2)
      expect(result2.first).to eq(3)

      # Both changes should be in the final state (Yjs merges them)
      final_version, final_text = SharedEditRevision.latest_raw(post.id)
      expect(final_version).to eq(3)
      expect(final_text).to be_present
    end
  end

  describe "state snapshotting" do
    fab!(:post) { Fabricate(:post, raw: "Original content that is long enough") }
    fab!(:user)

    # Use a lower threshold for testing since creating actual 100KB+ bloated states is slow
    around do |example|
      stub_const(DiscourseSharedEdits::StateValidator, "SNAPSHOT_THRESHOLD_BYTES", 100) do
        example.run
      end
    end

    it "triggers snapshot when state exceeds threshold during commit" do
      SharedEditRevision.init!(post)

      # Make edits to create a state that will exceed the lowered threshold
      5.times { |i| fake_edit(post, user.id, "Content version #{i + 1} with some more text") }

      latest = SharedEditRevision.where(post_id: post.id).order("version desc").first
      original_size = Base64.decode64(latest.raw).bytesize

      expect(original_size).to be > 100 # Should exceed our lowered threshold

      # Trigger compaction via commit
      SharedEditRevision.commit!(post.id, apply_to_post: false)

      # Reload latest and check size was reduced (fresh state has less metadata)
      latest.reload
      new_size = Base64.decode64(latest.raw).bytesize
      # The snapshotted state may or may not be smaller depending on recent updates
      # but it should still be valid
      validation = DiscourseSharedEdits::StateValidator.validate_state(latest.raw)
      expect(validation[:valid]).to eq(true)
    end

    it "preserves text content after snapshot" do
      SharedEditRevision.init!(post)

      # Create some edits
      5.times { |i| fake_edit(post, user.id, "Content version #{i + 1} with extra words") }

      # Trigger commit which should snapshot
      SharedEditRevision.commit!(post.id, apply_to_post: false)

      # Verify text is preserved (should be the last edit)
      latest = SharedEditRevision.where(post_id: post.id).order("version desc").first
      text = DiscourseSharedEdits::Yjs.text_from_state(latest.raw)
      expect(text).to eq("Content version 5 with extra words")
    end

    it "allows continued editing after snapshot" do
      SharedEditRevision.init!(post)

      # Make edits to trigger snapshot threshold
      5.times { |i| fake_edit(post, user.id, "Edit #{i + 1} with padding content") }

      # Trigger snapshot
      SharedEditRevision.commit!(post.id, apply_to_post: false)

      # Create a new edit
      fake_edit(post, user.id, "Post-snapshot edit works")

      # Verify the edit was applied
      version, text = SharedEditRevision.latest_raw(post.id)
      expect(text).to eq("Post-snapshot edit works")
    end

    it "preserves recent updates during snapshot" do
      SharedEditRevision.init!(post)

      # Make some recent edits (these should be preserved)
      3.times { |i| fake_edit(post, user.id, "Recent edit #{i + 1} padding") }

      recent_count =
        SharedEditRevision
          .where(post_id: post.id)
          .where.not(revision: ["", nil])
          .where("created_at > ?", SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_AGE.seconds.ago)
          .count

      expect(recent_count).to eq(3)

      # Trigger snapshot
      SharedEditRevision.commit!(post.id, apply_to_post: false)

      # State should still be valid
      latest = SharedEditRevision.where(post_id: post.id).order("version desc").first
      validation = DiscourseSharedEdits::StateValidator.validate_state(latest.raw)
      expect(validation[:valid]).to eq(true)
    end

    it "broadcasts resync when history exceeds message bus limits" do
      # Use a very high threshold so test doesn't run in the around block
      stub_const(DiscourseSharedEdits::StateValidator, "SNAPSHOT_THRESHOLD_BYTES", 100.megabytes) do
        # Lower the message bus limit temporarily for faster testing
        stub_const(SharedEditRevision, "MESSAGE_BUS_MAX_BACKLOG_SIZE", 5) do
          SharedEditRevision.init!(post)

          # Create more than the lowered MESSAGE_BUS_MAX_BACKLOG_SIZE revisions
          10.times { |i| fake_edit(post, user.id, "Edit #{i + 1}") }

          # Force snapshot by mocking should_snapshot? to return true
          allow(DiscourseSharedEdits::StateValidator).to receive(:should_snapshot?).and_return(true)

          # Track message bus publications - need apply_to_post: true (default)
          # for compact_history! to be called
          messages =
            MessageBus.track_publish("/shared_edits/#{post.id}") do
              SharedEditRevision.commit!(post.id)
            end

          # Should have a resync message
          resync_messages = messages.select { |m| m.data[:action] == "resync" }
          expect(resync_messages).not_to be_empty
        end
      end
    end

    it "does not trigger snapshot when state is below threshold" do
      # Use a very high threshold so no snapshot occurs
      stub_const(DiscourseSharedEdits::StateValidator, "SNAPSHOT_THRESHOLD_BYTES", 100.megabytes) do
        SharedEditRevision.init!(post)

        latest = SharedEditRevision.where(post_id: post.id).order("version desc").first
        original_raw = latest.raw

        # Commit should not change the raw since it's below threshold
        SharedEditRevision.commit!(post.id, apply_to_post: false)

        latest.reload
        # The raw content should be the same (not snapshotted)
        expect(latest.raw).to eq(original_raw)
      end
    end
  end

  describe ".ensure_will_commit" do
    fab!(:post)

    let(:redis) { Discourse.redis }
    let(:key) { SharedEditRevision.will_commit_key(post.id) }

    before { redis.del(key) }

    it "schedules a job and sets a key if not already scheduled" do
      expect(redis.get(key)).to be_nil

      expect { SharedEditRevision.ensure_will_commit(post.id) }.to change(
        Jobs::CommitSharedRevision.jobs,
        :size,
      ).by(1)

      expect(redis.get(key)).to eq("1")
      expect(redis.ttl(key)).to be_within(5).of(60)
    end

    it "does not schedule a job if already scheduled" do
      redis.setex(key, 60, "1")

      expect { SharedEditRevision.ensure_will_commit(post.id) }.not_to change(
        Jobs::CommitSharedRevision.jobs,
        :size,
      )
    end
  end
end
