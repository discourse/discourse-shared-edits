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
  ACTIVE_SESSION_TTL_SECONDS = 120
  FORCED_SNAPSHOT_THRESHOLD_BYTES = 10.megabytes

  def self.commit_delay_seconds
    SiteSetting.shared_edits_commit_delay_seconds
  rescue StandardError
    DEFAULT_COMMIT_DELAY_SECONDS
  end

  def self.will_commit_key(post_id)
    "shared_revision_will_commit_#{post_id}"
  end

  def self.ensure_will_commit(post_id)
    with_commit_lock(post_id) { schedule_commit(post_id) }
  end

  def self.schedule_commit(post_id, delay_seconds: commit_delay_seconds)
    key = will_commit_key(post_id)
    return if Discourse.redis.get(key)

    Jobs.enqueue_in(delay_seconds.seconds, :commit_shared_revision, post_id: post_id)
    key_ttl = [delay_seconds * 2, commit_lock_validity_seconds].max
    Discourse.redis.setex(key, key_ttl, "1")
  end
  private_class_method :schedule_commit

  def self.message_bus_channel(post_id)
    "#{MESSAGE_BUS_CHANNEL_PREFIX}/#{post_id}"
  end

  def self.active_session_key(post_id)
    "shared_revision_active_session_#{post_id}"
  end

  def self.mark_session_active!(post_id)
    Discourse.redis.setex(active_session_key(post_id), ACTIVE_SESSION_TTL_SECONDS, "1")
  end

  def self.session_active?(post_id)
    Discourse.redis.exists?(active_session_key(post_id))
  end
  private_class_method :session_active?

  def self.legacy_document_id(post_id)
    hex = Digest::MD5.hexdigest("shared-edits:#{post_id}")
    [hex[0, 8], hex[8, 4], hex[12, 4], hex[16, 4], hex[20, 12]].join("-")
  end

  def self.current_document_version(post_id)
    SharedEditRevision.where(post_id: post_id).order(version: :desc).pick(:document_id)
  end

  def self.ensure_document_id!(post_id, latest)
    return latest.document_id if latest.document_id.present?

    document_id =
      SharedEditRevision
        .where(post_id: post_id)
        .where.not(document_id: nil)
        .order(version: :desc)
        .pick(:document_id) || legacy_document_id(post_id)
    SharedEditRevision.where(post_id: post_id, document_id: nil).update_all(
      document_id: document_id,
    )
    latest.document_id = document_id
  end
  private_class_method :ensure_document_id!

  def self.ensure_document_version!(post_id)
    transaction do
      Post.where(id: post_id).lock.pick(:id)
      latest = where(post_id: post_id).order(version: :desc).first
      if !latest
        raise DiscourseSharedEdits::StateValidator::SharedEditsNotInitializedError.new(
                "shared edits not initialized",
                post_id: post_id,
              )
      end

      ensure_document_id!(post_id, latest)
    end
  end

  def self.last_revision_id_for_post(post)
    PostRevision.where(post: post).limit(1).order("number desc").pluck(:id).first
  end

  def self.toggle_shared_edits!(post_id, enable)
    post = Post.find(post_id)
    if enable
      init!(post)
      post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED] = true
      post.save_custom_fields
      post.publish_change_to_clients!(:acted)
      true
    else
      disable_failed = false
      with_commit_lock(post_id) do
        result = commit!(post_id)
        if result.nil?
          latest = SharedEditRevision.where(post_id: post_id).order("version desc").first
          if latest&.raw.present? && latest.post_revision_id.nil?
            Rails.logger.warn(
              "[SharedEdits] Failed to disable shared edits for post #{post_id}: uncommitted changes present",
            )
            disable_failed = true
          end
        end

        next if disable_failed

        SharedEditRevision.where(post_id: post_id).delete_all
        post.custom_fields.delete(DiscourseSharedEdits::SHARED_EDITS_ENABLED)
        post.custom_fields.delete("shared_edits_editor_usernames")
      end

      return false if disable_failed

      post.save_custom_fields
      post.publish_change_to_clients!(:acted)
      true
    end
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
      document_id: SecureRandom.uuid,
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

    max_length = SiteSetting.max_post_length
    if raw.length > max_length
      Rails.logger.warn(
        "[SharedEdits] Cannot commit post #{post_id}: text length #{raw.length} exceeds max_post_length #{max_length}",
      )
      return nil
    end

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

    existing_usernames = stored_editor_usernames(post)
    combined_usernames = (existing_usernames + new_usernames).uniq

    new_reason = I18n.t("shared_edits.reason", users: combined_usernames.join(", "))

    existing_reason = post_revision.modifications["edit_reason"]
    existing_reason = existing_reason[1] if existing_reason.is_a?(Array)
    existing_reason ||= ""

    store_editor_usernames(post, combined_usernames)

    return if new_reason == existing_reason

    post_revision.modifications["edit_reason"] = [nil, new_reason]
    post_revision.save!
    post.update_column(:edit_reason, new_reason)
  end
  private_class_method :update_edit_reason

  def self.stored_editor_usernames(post)
    raw = post.custom_fields["shared_edits_editor_usernames"]
    case raw
    when Array
      raw.map(&:to_s).reject(&:blank?)
    when String
      begin
        parsed = JSON.parse(raw)
        parsed.is_a?(Array) ? parsed.map(&:to_s).reject(&:blank?) : []
      rescue JSON::ParserError
        []
      end
    else
      []
    end
  end
  private_class_method :stored_editor_usernames

  def self.store_editor_usernames(post, usernames)
    post.custom_fields["shared_edits_editor_usernames"] = usernames.uniq
    post.save_custom_fields
  end
  private_class_method :store_editor_usernames

  def self.reset_history!(post_id)
    post = Post.find(post_id)

    reset_failed = false

    with_commit_lock(post_id) do
      SharedEditRevision.transaction do
        Post.where(id: post_id).lock.pick(:id)
        result = commit!(post_id)
        if result.nil?
          latest = SharedEditRevision.where(post_id: post_id).order("version desc").first
          if latest&.raw.present? && latest.post_revision_id.nil?
            Rails.logger.warn(
              "[SharedEdits] Reset blocked for post #{post_id} because pending changes could not be committed",
            )
            reset_failed = true
            raise ActiveRecord::Rollback
          end
        end

        SharedEditRevision.where(post_id: post_id).delete_all
        init!(post)
      end
    end

    return nil if reset_failed

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
    latest = SharedEditRevision.where(post_id: post_id).order(version: :desc).first
    return if latest.nil?

    validation = DiscourseSharedEdits::StateValidator.validate_state(latest.raw)
    unless validation[:valid]
      Rails.logger.warn(
        "[SharedEdits] Skipping compaction for post #{post_id}: latest state is invalid - #{validation[:error]}",
      )
      return
    end

    if DiscourseSharedEdits::StateValidator.should_snapshot?(latest.raw)
      force_snapshot =
        Base64.strict_decode64(latest.raw).bytesize >= FORCED_SNAPSHOT_THRESHOLD_BYTES
      if session_active?(post_id) && !force_snapshot
        schedule_commit(post_id, delay_seconds: ACTIVE_SESSION_TTL_SECONDS)
      else
        latest = snapshot_state!(post_id) || latest
      end
    end

    keep_raw_ids = Set.new([latest.id])
    last_committed =
      SharedEditRevision
        .where(post_id: post_id)
        .where.not(post_revision_id: nil)
        .order(version: :desc)
        .first
    keep_raw_ids << last_committed.id if last_committed

    SharedEditRevision
      .where(post_id: post_id)
      .where("version <= ?", latest.version)
      .where.not(id: keep_raw_ids.to_a)
      .where.not(raw: nil)
      .update_all(raw: nil)

    SharedEditRevision
      .where(post_id: post_id)
      .where("version <= ?", latest.version)
      .where("updated_at < ?", MAX_HISTORY_AGE.ago)
      .where.not(id: keep_raw_ids.to_a)
      .in_batches
      .delete_all

    keep_ids =
      SharedEditRevision
        .where(post_id: post_id)
        .order(version: :desc)
        .limit(MAX_HISTORY_COUNT)
        .pluck(:id)
    all_keep_ids = (Set.new(keep_ids) + keep_raw_ids).to_a

    SharedEditRevision
      .where(post_id: post_id)
      .where("version <= ?", latest.version)
      .where.not(id: all_keep_ids)
      .in_batches
      .delete_all
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

  def self.snapshot_state!(post_id)
    baseline =
      SharedEditRevision.transaction do
        Post.where(id: post_id).lock.pick(:id)
        latest = SharedEditRevision.where(post_id: post_id).order(version: :desc).first
        next if latest&.raw.blank?
        next if !DiscourseSharedEdits::StateValidator.should_snapshot?(latest.raw)

        text = DiscourseSharedEdits::Yjs.text_from_state(latest.raw)
        fresh_state = DiscourseSharedEdits::Yjs.state_from_text(text)[:state]
        revision =
          SharedEditRevision.create!(
            post_id: post_id,
            client_id: "snapshot",
            user_id: Discourse.system_user.id,
            version: latest.version + 1,
            revision: "",
            raw: fresh_state,
            document_id: SecureRandom.uuid,
            post_revision_id: latest.post_revision_id,
          )
        update_state_hash!(revision)
        revision
      end
    return if baseline.nil?

    ActiveRecord.after_all_transactions_commit do
      Rails.logger.info(
        "[SharedEdits] Rotated document baseline for post #{post_id} at v#{baseline.version}",
      )
      Post.find(post_id).publish_message!(
        message_bus_channel(post_id),
        {
          action: DiscourseSharedEdits::Protocol::MessageActions::RESYNC,
          replace: true,
          version: baseline.version,
          document_version: baseline.document_id,
        },
        max_backlog_age: MESSAGE_BUS_MAX_BACKLOG_AGE,
        max_backlog_size: MESSAGE_BUS_MAX_BACKLOG_SIZE,
      )
    end
    baseline
  end
  private_class_method :snapshot_state!

  def self.revise!(
    post_id:,
    user_id:,
    client_id:,
    update:,
    cursor: nil,
    awareness: nil,
    post: nil,
    username: nil,
    allow_blank_state: false,
    state_vector: nil,
    document_version: nil
  )
    server_document_version = current_document_version(post_id)
    server_document_version = ensure_document_version!(post_id) if server_document_version.nil?
    if document_version.nil? && server_document_version == legacy_document_id(post_id)
      document_version = server_document_version
    end

    retries = 0
    result = nil
    message = nil

    begin
      result, message =
        SharedEditRevision.transaction do
          Post.where(id: post_id).lock.pick(:id)
          latest = SharedEditRevision.where(post_id: post_id).order("version desc").first
          if !latest
            raise DiscourseSharedEdits::StateValidator::SharedEditsNotInitializedError.new(
                    "shared edits not initialized",
                    post_id: post_id,
                  )
          end

          current_document_version = latest.document_id
          if document_version.to_s != current_document_version.to_s
            raise DiscourseSharedEdits::StateValidator::DocumentReplacedError.new(
                    document_version: current_document_version,
                  )
          end

          if state_vector.present?
            validation =
              DiscourseSharedEdits::StateValidator.validate_client_state_vector(
                latest.raw,
                state_vector,
              )
            unless validation[:valid]
              if validation[:missing_update].present?
                raise DiscourseSharedEdits::StateValidator::StateDivergedError.new(
                        "Client state vector is behind server",
                        post_id: post_id,
                        missing_update: validation[:missing_update],
                      )
              end

              raise DiscourseSharedEdits::StateValidator::InvalidUpdateError.new(
                      "Invalid state vector: #{validation[:error]}",
                      post_id: post_id,
                    )
            end
          end

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
              document_id: latest.document_id,
              version: latest.version + 1,
            )
          update_state_hash!(revision)

          event = {
            version: revision.version,
            update: update,
            client_id: client_id,
            user_id: user_id,
            username: username || User.find(user_id).username,
            document_version: revision.document_id,
          }
          event[:cursor] = cursor if cursor.present?
          event[:awareness] = awareness if awareness.present?
          state_hash = revision.respond_to?(:state_hash) ? revision.state_hash : nil

          [[revision.version, update, state_hash], event]
        end
    rescue ActiveRecord::RecordNotUnique => e
      retries += 1
      if retries < MAX_REVISION_RETRIES
        Rails.logger.warn(
          "[SharedEdits] Version conflict for post #{post_id}, retry #{retries}/#{MAX_REVISION_RETRIES}",
        )
        retry
      end

      Rails.logger.error(
        "[SharedEdits] Version conflict for post #{post_id} after #{MAX_REVISION_RETRIES} retries: #{e.message}",
      )
      raise
    end

    mark_session_active!(post_id)
    schedule_commit(post_id)
    (post || Post.find(post_id)).publish_message!(
      message_bus_channel(post_id),
      message,
      max_backlog_age: MESSAGE_BUS_MAX_BACKLOG_AGE,
      max_backlog_size: MESSAGE_BUS_MAX_BACKLOG_SIZE,
    )
    result
  rescue MiniRacer::RuntimeError, MiniRacer::ParseError, ArgumentError => e
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
#  document_id      :uuid
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
