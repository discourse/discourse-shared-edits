# frozen_string_literal: true

module ::DiscourseSharedEdits
  class RevisionController < ::ApplicationController
    requires_login
    before_action :ensure_logged_in, :ensure_shared_edits
    skip_before_action :preload_json, :check_xhr

    def enable
      guardian.ensure_can_toggle_shared_edits!
      SharedEditRevision.toggle_shared_edits!(params[:post_id].to_i, true)
      render json: success_json
    end

    def disable
      guardian.ensure_can_toggle_shared_edits!
      SharedEditRevision.toggle_shared_edits!(params[:post_id].to_i, false)
      render json: success_json
    end

    def latest
      post = Post.find(params[:post_id].to_i)
      guardian.ensure_can_see!(post)
      SharedEditRevision.commit!(post.id, apply_to_post: false)
      version, raw = SharedEditRevision.latest_raw(post)
      render json: {
        raw: raw,
        version: version
      }
    end

    def commit
      params.require(:post_id)

      post = Post.find(params[:post_id].to_i)
      guardian.ensure_can_see!(post)
      SharedEditRevision.commit!(post.id)

      render json: success_json
    end

    def revise
      params.require(:revision)
      params.require(:client_id)
      params.require(:version)

      master_version = params[:version].to_i

      post = Post.find(params[:post_id].to_i)
      guardian.ensure_can_see!(post)

      version, revision = SharedEditRevision.revise!(
        post_id: post.id,
        user_id: current_user.id,
        client_id: params[:client_id],
        version: master_version,
        revision: params[:revision]
      )

      revisions =
        if version == master_version + 1
          [{
            version: version,
            revision: revision,
            client_id: params[:client_id]
          }]
        else
          SharedEditRevision
            .where(post_id: post.id)
            .where('version > ?', master_version)
            .order(:version)
            .pluck(:revision, :version, :client_id).map { |r, v, c|
              {
                version: v,
                revision: r,
                client_id: c
              }
            }
        end

      SharedEditRevision.ensure_will_commit(post.id)

      render json: {
        version: version,
        revisions: revisions
      }
    end

    protected

    def ensure_shared_edits
      if !SiteSetting.shared_edits_enabled
        raise Discourse::InvalidAccess
      end
    end

  end
end
