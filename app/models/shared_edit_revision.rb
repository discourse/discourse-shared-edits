# frozen_string_literal: true

class SharedEditRevision < ActiveRecord::Base
  belongs_to :post
  belongs_to :post_revision

  MAX_HISTORY_AGE = 1.minute
  MAX_HISTORY_COUNT = 200
  MESSAGE_BUS_MAX_BACKLOG_AGE = 600
  MESSAGE_BUS_MAX_BACKLOG_SIZE = 500
  MAX_AWARENESS_BYTES = 10.kilobytes
  MESSAGE_BUS_CHANNEL_PREFIX = "/shared_edits"
  DEFAULT_COMMIT_DELAY_SECONDS = 30

  def self.commit_delay_seconds
    SiteSetting.shared_edits_commit_delay_seconds
  rescue StandardError
    DEFAULT_COMMIT_DELAY_SECONDS
  end

  def self.will_commit_key(post_id)
    "shared_revision_will_commit_#{post_id}"
  end

  def self.ensure_will_commit(post_id)
    with_commit_lock(post_id) do
      key = will_commit_key(post_id)
      next if Discourse.redis.get(key)

      delay = commit_delay_seconds.seconds
      Jobs.enqueue_in(delay, :commit_shared_revision, post_id: post_id)
      Discourse.redis.setex(key, commit_lock_validity_seconds, "1")
    end
  end

  def self.message_bus_channel(post_id)
    "#{MESSAGE_BUS_CHANNEL_PREFIX}/#{post_id}"
  end

  def self.last_revision_id_for_post(post)
    PostRevision.where(post: post).limit(1).order("number desc").pluck(:id).first
  end

  def self.toggle_shared_edits!(post_id, enable)
    post = Post.find(post_id)
    if enable
      init!(post)
      post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED] = true
    else
      result = commit!(post_id)
      if result.nil?
        latest = SharedEditRevision.where(post_id: post_id).order("version desc").first
        if latest&.raw.present?
          Rails.logger.warn(
            "[SharedEdits] Disabling shared edits for post #{post_id} with uncommitted changes",
          )
        end
      end
      SharedEditRevision.where(post_id: post_id).delete_all
      post.custom_fields.delete(DiscourseSharedEdits::SHARED_EDITS_ENABLED)
    end
    post.save_custom_fields
    post.publish_change_to_clients!(:acted)
  end

  def self.init!(post)
    return if SharedEditRevision.where(post_id: post.id).exists?

    revision_id = last_revision_id_for_post(post)
    initial_state = DiscourseSharedEdits::Yjs.state_from_text(post.raw)

    SharedEditRevision.create!(
      post: post,
      client_id: "system",
      user_id: Discourse.system_user.id,
      version: 1,
      revision: "",
      raw: initial_state[:state],
      post_revision_id: revision_id,
    )
  end

  def self.commit!(post_id, apply_to_post: true)
    latest = SharedEditRevision.where(post_id: post_id).order("version desc").first

    return if latest.nil? || latest.raw.nil?

    validation = DiscourseSharedEdits::StateValidator.validate_state(latest.raw)
    unless validation[:valid]
      Rails.logger.warn(
        "[SharedEdits] Cannot commit post #{post_id}: state is corrupted - #{validation[:error]}",
      )
      return
    end

    raw = validation[:text]

    return raw unless apply_to_post

    post = Post.find(post_id)
    topic = post.topic

    if topic&.closed? || topic&.archived?
      Rails.logger.warn(
        "[SharedEdits] Cannot commit to post #{post_id}: topic is #{topic.closed? ? "closed" : "archived"}",
      )
      return nil
    end

    if latest.post_revision_id.present?
      compact_history!(post_id)
      return raw
    end

    # Normalize both texts the same way PostRevisor does to avoid
    # creating spurious revisions when content is effectively unchanged
    normalize = ->(text) { text.present? ? TextCleaner.normalize_whitespaces(text).rstrip : "" }
    if normalize.call(raw) == normalize.call(post.raw)
      compact_history!(post_id)
      return raw
    end

    revisor = PostRevisor.new(post)
    opts = {
      bypass_rate_limiter: true,
      bypass_bump: true,
      skip_staff_log: true,
      skip_validations: true,
    }
    revised = revisor.revise!(Discourse.system_user, { raw: raw }, opts)

    unless revised
      compact_history!(post_id)
      return raw
    end

    post_revision = PostRevision.where(post: post).order("number desc").first
    if post_revision.nil?
      compact_history!(post_id)
      return raw
    end

    SharedEditRevision.transaction do
      editor_usernames = collect_editor_usernames(post_id)
      update_edit_reason(post, post_revision, editor_usernames)
      latest.update!(post_revision_id: post_revision.id)
    end

    compact_history!(post_id)

    # Compute and store state hash AFTER compact_history! since snapshotting can mutate latest.raw
    # Re-fetch latest to get the potentially updated state
    latest = SharedEditRevision.where(post_id: post_id).order("version desc").first
    update_state_hash!(latest)

    raw
  end

  def self.collect_editor_usernames(post_id)
    last_committed_version =
      SharedEditRevision
        .where(post_id: post_id)
        .where.not(post_revision_id: nil)
        .maximum(:version) || 0

    editor_ids =
      SharedEditRevision
        .where(post_id: post_id)
        .where("version > ?", last_committed_version)
        .distinct
        .pluck(:user_id)

    User.where(id: editor_ids).pluck(:username)
  end
  private_class_method :collect_editor_usernames

  def self.update_edit_reason(post, post_revision, new_usernames)
    return if new_usernames.empty?

    existing_reason = post_revision.modifications["edit_reason"]
    existing_reason = existing_reason[1] if existing_reason.is_a?(Array)
    existing_reason ||= ""

    existing_usernames = parse_usernames_from_reason(existing_reason)
    combined_usernames = (existing_usernames + new_usernames).uniq

    new_reason = I18n.t("shared_edits.reason", users: combined_usernames.join(", "))

    return if new_reason == existing_reason

    post_revision.modifications["edit_reason"] = [nil, new_reason]
    post_revision.save!
    post.update_column(:edit_reason, new_reason)
  end
  private_class_method :update_edit_reason

  def self.parse_usernames_from_reason(reason)
    return [] if reason.blank?

    prefix = I18n.t("shared_edits.reason", users: "")
    return [] unless reason.start_with?(prefix)

    users_part = reason[prefix.length..]
    users_part.split(",").map(&:strip).reject(&:blank?)
  end
  private_class_method :parse_usernames_from_reason

  def self.reset_history!(post_id)
    post = Post.find(post_id)

    SharedEditRevision.transaction do
      commit!(post_id)
      SharedEditRevision.where(post_id: post_id).delete_all
      init!(post)
    end

    revision = SharedEditRevision.where(post_id: post_id).order("version desc").first
    revision&.version
  end

  def self.latest_raw(post_id)
    latest =
      SharedEditRevision
        .where("raw IS NOT NULL")
        .where(post_id: post_id)
        .order("version desc")
        .limit(1)
        .first

    return if !latest

    [latest.version, DiscourseSharedEdits::Yjs.text_from_state(latest.raw)]
  end

  MAX_REVISION_RETRIES = 3

  def self.compact_history!(post_id)
    latest = SharedEditRevision.where(post_id: post_id).order("version desc").limit(1).first

    return if latest.nil?

    validation = DiscourseSharedEdits::StateValidator.validate_state(latest.raw)
    unless validation[:valid]
      Rails.logger.warn(
        "[SharedEdits] Skipping compaction for post #{post_id}: latest state is invalid - #{validation[:error]}",
      )
      return
    end

    keep_raw_ids = Set.new([latest.id])
    last_committed =
      SharedEditRevision
        .where(post_id: post_id)
        .where.not(post_revision_id: nil)
        .order("version desc")
        .first
    keep_raw_ids << last_committed.id if last_committed

    SharedEditRevision
      .where(post_id: post_id)
      .where.not(id: keep_raw_ids.to_a)
      .where.not(raw: nil)
      .update_all(raw: nil)

    SharedEditRevision
      .where(post_id: post_id)
      .where("updated_at < ?", MAX_HISTORY_AGE.ago)
      .where.not(id: keep_raw_ids.to_a)
      .in_batches
      .delete_all

    keep_ids =
      Set.new(
        SharedEditRevision
          .where(post_id: post_id)
          .order("version desc")
          .limit(MAX_HISTORY_COUNT)
          .pluck(:id),
      )

    all_keep_ids = (keep_ids + keep_raw_ids).to_a
    SharedEditRevision.where(post_id: post_id).where.not(id: all_keep_ids).in_batches.delete_all

    # Check if snapshotting is needed to reduce state bloat
    # Re-fetch latest since it may have been modified above
    latest = SharedEditRevision.where(post_id: post_id).order("version desc").first
    if latest&.raw.present? && DiscourseSharedEdits::StateValidator.should_snapshot?(latest.raw)
      snapshot_state!(post_id, latest)
    end
  end

  def self.clear_commit_schedule(post_id)
    Discourse.redis.del(will_commit_key(post_id))
  end

  def self.commit_lock_validity_seconds
    commit_delay_seconds * 2
  end
  private_class_method :commit_lock_validity_seconds

  def self.with_commit_lock(post_id, &block)
    DistributedMutex.synchronize(
      commit_mutex_key(post_id),
      validity: commit_lock_validity_seconds,
      &block
    )
  end

  def self.commit_mutex_key(post_id)
    "shared_edits_commit_#{post_id}"
  end
  private_class_method :commit_mutex_key
  private_class_method :compact_history!

  def self.update_state_hash!(revision)
    return if revision.nil? || revision.raw.blank?
    return if column_names.exclude?("state_hash")
    state_hash = DiscourseSharedEdits::Yjs.compute_state_hash(revision.raw)
    revision.update_column(:state_hash, state_hash) if state_hash.present?
  end
  private_class_method :update_state_hash!

  def self.snapshot_state!(post_id, latest)
    return if latest&.raw.blank?

    original_size =
      begin
        Base64.decode64(latest.raw).bytesize
      rescue StandardError
        0
      end

    # Get recent revisions within BOTH message bus limits:
    # - Time: MESSAGE_BUS_MAX_BACKLOG_AGE (10 min)
    # - Count: MESSAGE_BUS_MAX_BACKLOG_SIZE (500 messages)
    # This ensures new clients can catch up via message bus
    all_recent =
      SharedEditRevision
        .where(post_id: post_id)
        .where("created_at > ?", MESSAGE_BUS_MAX_BACKLOG_AGE.seconds.ago)
        .where.not(revision: ["", nil])
        .order(version: :desc)

    # Check if we need to truncate to message bus size limit
    needs_resync = all_recent.count > MESSAGE_BUS_MAX_BACKLOG_SIZE

    # Take only what message bus can hold, then reverse to apply in order
    recent_revisions = all_recent.limit(MESSAGE_BUS_MAX_BACKLOG_SIZE).to_a.reverse

    # Extract text and create fresh base state
    text = DiscourseSharedEdits::Yjs.text_from_state(latest.raw)
    fresh_state = DiscourseSharedEdits::Yjs.state_from_text(text)[:state]

    # Re-apply recent updates to preserve item ID continuity
    recent_revisions.each do |rev|
      result = DiscourseSharedEdits::Yjs.apply_update(fresh_state, rev.revision)
      fresh_state = result[:state]
    end

    # Update in place
    latest.update!(raw: fresh_state)

    new_size =
      begin
        Base64.decode64(fresh_state).bytesize
      rescue StandardError
        0
      end

    Rails.logger.info(
      "[SharedEdits] Snapshotted state for post #{post_id} v#{latest.version}: " \
        "#{original_size} -> #{new_size} bytes (preserved #{recent_revisions.count} recent updates)",
    )

    # If we had to truncate history beyond message bus limits, force resync
    # so all clients get the new baseline state
    if needs_resync
      post = Post.find(post_id)
      post.publish_message!(
        message_bus_channel(post_id),
        { action: "resync", version: latest.version },
        max_backlog_age: MESSAGE_BUS_MAX_BACKLOG_AGE,
        max_backlog_size: MESSAGE_BUS_MAX_BACKLOG_SIZE,
      )
      Rails.logger.info(
        "[SharedEdits] Broadcast resync for post #{post_id} - history exceeded message bus limits",
      )
    end
  end

  def self.revise!(
    post_id:,
    user_id:,
    client_id:,
    update:,
    cursor: nil,
    awareness: nil,
    post: nil,
    username: nil,
    allow_blank_state: false
  )
    retries = 0

    begin
      SharedEditRevision.transaction do
        latest = SharedEditRevision.where(post_id: post_id).lock.order("version desc").first
        raise StandardError, "shared edits not initialized" if !latest

        applied =
          DiscourseSharedEdits::StateValidator.safe_apply_update(
            post_id,
            latest.raw,
            update,
            allow_blank_state: allow_blank_state,
          )

        revision =
          SharedEditRevision.create!(
            post_id: post_id,
            user_id: user_id,
            client_id: client_id,
            revision: update,
            raw: applied[:state],
            version: latest.version + 1,
          )

        post ||= Post.find(post_id)
        username ||= User.find(user_id).username
        message = {
          version: revision.version,
          update: update,
          client_id: client_id,
          user_id: user_id,
          username: username,
        }
        message[:cursor] = cursor if cursor.present?
        message[:awareness] = awareness if awareness.present?
        post.publish_message!(
          message_bus_channel(post.id),
          message,
          max_backlog_age: MESSAGE_BUS_MAX_BACKLOG_AGE,
          max_backlog_size: MESSAGE_BUS_MAX_BACKLOG_SIZE,
        )

        # Return the most recently computed state_hash for sync verification.
        # This hash is from the most recently committed revision (computed during
        # commit!), not the newly created revision. Clients use this as a sync
        # target and forward MessageBus updates until their local hash matches.
        state_hash = latest.respond_to?(:state_hash) ? latest.state_hash : nil
        [revision.version, update, state_hash]
      end
    rescue ActiveRecord::RecordNotUnique => e
      retries += 1
      if retries < MAX_REVISION_RETRIES
        Rails.logger.warn(
          "[SharedEdits] Version conflict for post #{post_id}, retry #{retries}/#{MAX_REVISION_RETRIES}",
        )
        retry
      else
        Rails.logger.error(
          "[SharedEdits] Version conflict for post #{post_id} after #{MAX_REVISION_RETRIES} retries: #{e.message}",
        )
        raise
      end
    end
  rescue MiniRacer::RuntimeError, MiniRacer::ParseError => e
    raise DiscourseSharedEdits::StateValidator::StateCorruptionError.new(
            "Yjs operation failed: #{e.message}",
            post_id: post_id,
          )
  end
end

# == Schema Information
#
# Table name: shared_edit_revisions
#
#  id               :bigint           not null, primary key
#  post_id          :integer          not null
#  raw              :text
#  revision         :text             not null
#  user_id          :integer          not null
#  client_id        :string           not null
#  version          :integer          not null
#  post_revision_id :integer
#  state_hash       :string(64)
#  created_at       :datetime         not null
#  updated_at       :datetime         not null
#
# Indexes
#
#  index_shared_edit_revisions_on_post_id_and_version  (post_id,version) UNIQUE
#
