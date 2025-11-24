# frozen_string_literal: true

module ::DiscourseSharedEdits
  class RevisionController < ::ApplicationController
    requires_plugin PLUGIN_NAME

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
      revision = SharedEditRevision.where(post_id: post.id).order("version desc").first

      raise Discourse::NotFound if revision.nil?

      render json: {
               raw: DiscourseSharedEdits::Yjs.text_from_state(revision.raw),
               version: revision.version,
               state: revision.raw,
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
      params.require(:update)
      params.require(:client_id)

      post = Post.find(params[:post_id].to_i)
      guardian.ensure_can_see!(post)

      version, update =
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: current_user.id,
          client_id: params[:client_id],
          update: params[:update],
        )

      SharedEditRevision.ensure_will_commit(post.id)

      render json: { version: version, update: update }
    end

    protected

    def ensure_shared_edits
      raise Discourse::InvalidAccess if !SiteSetting.shared_edits_enabled
    end
  end
end
