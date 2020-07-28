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
    PostRevision.where(post: post).limit(1).order('number desc').pluck(:id).first || -1
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
    if !SharedEditRevision.where(post_id: post.id).exists?
      revision_id = last_revision_id_for_post(post)

      SharedEditRevision.create!(
        post: post,
        client_id: 'system',
        user_id: Discourse.system_user.id,
        version: 1,
        revision: '[]',
        raw: post.raw,
        post_revision_id: revision_id
      )
    end
  end

  def self.commit!(post_id, apply_to_post: true)

    version_with_raw =
      SharedEditRevision
        .where(post_id: post_id)
        .where('raw IS NOT NULL')
        .order(:version)
        .first

    return if !version_with_raw

    raw = version_with_raw.raw

    to_resolve = SharedEditRevision
      .where(
        post_id: post_id,
      )
      .where('version > ?', version_with_raw.version)
      .order(:version)

    last_revision = version_with_raw

    editors = []

    to_resolve.each do |rev|
      raw = OtTextUnicode.apply(raw, rev.revision)
      last_revision = rev
      editors << rev.user_id
    end

    last_revision.update!(raw: raw) if last_revision.raw != raw
    return if last_revision.post_revision_id
    return if !apply_to_post

    post = Post.find(post_id)
    revisor = PostRevisor.new(post)

    # TODO decide if we need fidelity here around skip_revision
    # skip_revision: true

    opts = {
      bypass_rate_limiter: true,
      bypass_bump: true,
      skip_validations: true,
      skip_staff_log: true,
    }

    Post.transaction do
      done = revisor.revise!(Discourse.system_user, { raw: raw }, opts)
      if done
        last_post_revision = PostRevision
          .where(post: post).limit(1).order('number desc').first

        reason = last_post_revision.modifications["edit_reason"] || ""
        usernames = reason[1]&.split(",")&.map(&:strip) || []

        User.where(id: editors).pluck(:username).each do |name|
          usernames << name
        end

        usernames.uniq!

        new_reason = I18n.t("shared_edits.reason", users: usernames.join(", "))

        if new_reason != reason
          last_post_revision.modifications["edit_reason"] = new_reason
          last_post_revision.save!
          post.update!(edit_reason: new_reason)
        end

        last_revision.update!(post_revision_id: last_post_revision)
      end
    end

    raw
  end

  def self.latest_raw(post_id)
    SharedEditRevision
      .where('raw IS NOT NULL')
      .where(post_id: post_id)
      .order('version desc')
      .limit(1)
      .pluck(:version, :raw)
      .first
  end

  def self.revise!(post_id:, user_id:, client_id:, revision:, version:)

    revision = revision.to_json if !(String === revision)

    args = {
      user_id: user_id,
      client_id: client_id,
      revision: revision,
      post_id: post_id,
      version: version + 1,
      now: Time.zone.now,
    }

    rows = DB.exec(<<~SQL, args)
      INSERT INTO shared_edit_revisions
      (
        post_id,
        user_id,
        client_id,
        revision,
        version,
        created_at,
        updated_at
      )
      SELECT
        :post_id,
        :user_id,
        :client_id,
        :revision,
        :version,
        :now,
        :now
      WHERE :version = (
        SELECT MAX(version) + 1
        FROM shared_edit_revisions
        WHERE post_id = :post_id
      )
    SQL

    if rows == 1
      post = Post.find(post_id)
      message = {
        version: version + 1,
        revision: revision,
        client_id: client_id,
        user_id: user_id
      }
      post.publish_message!("/shared_edits/#{post.id}", message)
      [version + 1, revision]
    else
      missing = SharedEditRevision.where(post_id: post_id)
        .where('version > ?', version)
        .order(:version)
        .pluck(:version, :revision)

      if missing.length == 0
        raise StandardError, "no revisions to apply"
      end

      missing.each do |missing_version, missing_revision|
        revision = OtTextUnicode.transform(revision, missing_revision)
        version = missing_version
      end

      revise!(post_id: post_id, user_id: user_id, client_id: client_id, revision: revision, version: version)
    end
  end

end
# t.integer :post_id, null: false
# t.string :raw
# t.string :revision, null: false
# t.string :client_id, null: false
# t.integer :user_id, null: false
# t.integer :version, null: false
# t.integer :post_revision
