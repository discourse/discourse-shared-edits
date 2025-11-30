# frozen_string_literal: true

class SharedEditRevision < ActiveRecord::Base
  belongs_to :post
  belongs_to :post_revision

  MAX_HISTORY_AGE = 1.minute
  MAX_HISTORY_COUNT = 200
  MESSAGE_BUS_MAX_BACKLOG_AGE = 600
  MESSAGE_BUS_MAX_BACKLOG_SIZE = 100

  def self.will_commit_key(post_id)
    "shared_revision_will_commit_#{post_id}"
  end

  def self.ensure_will_commit(post_id)
    key = will_commit_key(post_id)
    if !Discourse.redis.get(key)
      Discourse.redis.setex(key, 60, "1")
      Jobs.enqueue_in(10.seconds, :commit_shared_revision, post_id: post_id)
    end
  end

  def self.last_revision_id_for_post(post)
    PostRevision.where(post: post).limit(1).order("number desc").pluck(:id).first || -1
  end

  def self.toggle_shared_edits!(post_id, enable)
    post = Post.find(post_id)
    if enable
      init!(post)
      post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED] = true
    else
      commit!(post_id)
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

    # Validate state before attempting to extract text
    validation = DiscourseSharedEdits::StateValidator.validate_state(latest.raw)
    unless validation[:valid]
      Rails.logger.warn(
        "[SharedEdits] Cannot commit post #{post_id}: state is corrupted - #{validation[:error]}",
      )
      return
    end

    raw = validation[:text]

    return raw unless apply_to_post

    if latest.post_revision_id.present?
      compact_history!(post_id)
      return raw
    end

    post = Post.find(post_id)
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

    # Validate the latest state before compaction - if it's invalid, don't compact
    # as we may need older revisions for recovery
    validation = DiscourseSharedEdits::StateValidator.validate_state(latest.raw)
    unless validation[:valid]
      Rails.logger.warn(
        "[SharedEdits] Skipping compaction for post #{post_id}: latest state is invalid - #{validation[:error]}",
      )
      return
    end

    keep_ids = [latest.id]

    last_committed_id =
      SharedEditRevision
        .where(post_id: post_id)
        .where.not(post_revision_id: nil)
        .order("version desc")
        .limit(1)
        .pluck(:id)
        .first
    keep_ids << last_committed_id if last_committed_id
    keep_ids.compact!
    keep_ids.uniq!

    SharedEditRevision
      .where(post_id: post_id)
      .where("updated_at < ?", MAX_HISTORY_AGE.ago)
      .where.not(id: keep_ids)
      .delete_all

    remaining_scope =
      SharedEditRevision.where(post_id: post_id).where.not(id: keep_ids).order("version desc")

    additional_limit = MAX_HISTORY_COUNT - keep_ids.length
    if additional_limit.positive?
      keep_ids.concat(remaining_scope.limit(additional_limit).pluck(:id))
      keep_ids.uniq!
    end

    SharedEditRevision.where(post_id: post_id).where.not(id: keep_ids).delete_all

    # Verify post-compaction state integrity
    post_compaction_latest =
      SharedEditRevision.where(post_id: post_id).order("version desc").limit(1).first

    if post_compaction_latest.nil?
      Rails.logger.error(
        "[SharedEdits] Compaction error for post #{post_id}: no revisions remain after compaction",
      )
      return
    end

    post_validation =
      DiscourseSharedEdits::StateValidator.validate_state(post_compaction_latest.raw)
    unless post_validation[:valid]
      Rails.logger.error(
        "[SharedEdits] Compaction error for post #{post_id}: post-compaction state is invalid - #{post_validation[:error]}",
      )
    end
  end
  private_class_method :compact_history!

  def self.revise!(post_id:, user_id:, client_id:, update:, cursor: nil)
    retries = 0

    begin
      SharedEditRevision.transaction do
        latest = SharedEditRevision.where(post_id: post_id).lock.order("version desc").first
        raise StandardError, "shared edits not initialized" if !latest

        applied =
          DiscourseSharedEdits::StateValidator.safe_apply_update(post_id, latest.raw, update)

        revision =
          SharedEditRevision.create!(
            post_id: post_id,
            user_id: user_id,
            client_id: client_id,
            revision: update,
            raw: applied[:state],
            version: latest.version + 1,
          )

        post = Post.find(post_id)
        message = {
          version: revision.version,
          update: update,
          client_id: client_id,
          user_id: user_id,
          user_name: User.find(user_id).username,
        }
        message[:cursor] = cursor if cursor.present?
        # Limit backlog to prevent unbounded Redis growth
        post.publish_message!(
          "/shared_edits/#{post.id}",
          message,
          max_backlog_age: MESSAGE_BUS_MAX_BACKLOG_AGE,
          max_backlog_size: MESSAGE_BUS_MAX_BACKLOG_SIZE,
        )

        [revision.version, update]
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
#  created_at       :datetime         not null
#  updated_at       :datetime         not null
#
# Indexes
#
#  index_shared_edit_revisions_on_post_id_and_version  (post_id,version) UNIQUE
#
