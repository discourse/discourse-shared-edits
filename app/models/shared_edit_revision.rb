# frozen_string_literal: true

class SharedEditRevision < ActiveRecord::Base
  belongs_to :post
  belongs_to :post_revision

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

    return if !latest&.raw
    return if latest.post_revision_id && !apply_to_post

    raw = DiscourseSharedEdits::Yjs.text_from_state(latest.raw)

    return raw if latest.post_revision_id || !apply_to_post

    post = Post.find(post_id)
    revisor = PostRevisor.new(post)

    opts = { bypass_rate_limiter: true, bypass_bump: true, skip_staff_log: true }

    done = revisor.revise!(Discourse.system_user, { raw: raw }, opts)

    return raw if !done

    last_post_revision = PostRevision.where(post: post).limit(1).order("number desc").first

    SharedEditRevision.transaction do
      last_committed_version =
        SharedEditRevision
          .where(post_id: post_id)
          .where.not(post_revision_id: nil)
          .maximum(:version) || 0

      editors =
        SharedEditRevision
          .where(post_id: post_id)
          .where("version > ?", last_committed_version)
          .pluck(:user_id)
          .uniq

      reason = last_post_revision.modifications["edit_reason"] || ""
      reason = reason[1] if Array === reason

      usernames = reason&.split(",")&.map(&:strip) || []

      if usernames.length > 0
        reason_length = I18n.t("shared_edits.reason", users: "").length
        usernames[0] = usernames[0][reason_length..-1]
      end

      User.where(id: editors).pluck(:username).each { |name| usernames << name }

      usernames.uniq!

      new_reason = I18n.t("shared_edits.reason", users: usernames.join(", "))

      if new_reason != reason
        last_post_revision.modifications["edit_reason"] = [nil, new_reason]
        last_post_revision.save!
        post.update!(edit_reason: new_reason)
      end

      latest.update!(post_revision_id: last_post_revision.id)
    end

    raw
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

  def self.revise!(post_id:, user_id:, client_id:, update:)
    SharedEditRevision.transaction do
      latest = SharedEditRevision.where(post_id: post_id).lock.order("version desc").first
      raise StandardError, "shared edits not initialized" if !latest

      applied = DiscourseSharedEdits::Yjs.apply_update(latest.raw, update)

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
      }
      post.publish_message!("/shared_edits/#{post.id}", message)

      [revision.version, update]
    end
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
