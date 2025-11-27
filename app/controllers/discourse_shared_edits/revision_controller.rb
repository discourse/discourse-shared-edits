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

      # Validate state before sending to client
      health = StateValidator.health_check(post.id)
      unless health[:healthy]
        Rails.logger.warn(
          "[SharedEdits] Unhealthy state detected for post #{post.id}, attempting recovery",
        )
        recovery = StateValidator.recover_from_post_raw(post.id)
        unless recovery[:success]
          raise Discourse::InvalidAccess.new(
                  I18n.t("shared_edits.errors.state_corrupted"),
                  custom_message: "shared_edits.errors.state_corrupted",
                )
        end
        revision = SharedEditRevision.where(post_id: post.id).order("version desc").first
      end

      # Include message_bus_last_id so clients can subscribe from the correct position
      # to avoid missing any messages between fetching state and subscribing
      message_bus_last_id = MessageBus.last_id("/shared_edits/#{post.id}")

      render json: {
               raw: DiscourseSharedEdits::Yjs.text_from_state(revision.raw),
               version: revision.version,
               state: revision.raw,
               message_bus_last_id: message_bus_last_id,
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
    rescue StateValidator::StateCorruptionError => e
      Rails.logger.error(
        "[SharedEdits] State corruption in revise for post #{params[:post_id]}: #{e.message}",
      )

      # Attempt automatic recovery
      recovery = StateValidator.recover_from_post_raw(params[:post_id].to_i)
      if recovery[:success]
        render json: {
                 error: "state_recovered",
                 message: I18n.t("shared_edits.errors.state_recovered"),
                 recovered_version: recovery[:new_version],
               },
               status: :conflict
      else
        render json: {
                 error: "state_corrupted",
                 message: I18n.t("shared_edits.errors.state_corrupted"),
               },
               status: :unprocessable_entity
      end
    end

    def health
      guardian.ensure_can_toggle_shared_edits!

      post = Post.find(params[:post_id].to_i)
      health = StateValidator.health_check(post.id)

      render json: health
    end

    def recover
      guardian.ensure_can_toggle_shared_edits!

      post = Post.find(params[:post_id].to_i)
      result = StateValidator.recover_from_post_raw(post.id, force: params[:force] == "true")

      if result[:success]
        # Notify connected clients to resync
        post.publish_message!(
          "/shared_edits/#{post.id}",
          { action: "resync", version: result[:new_version] },
          max_backlog_age: SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_AGE,
          max_backlog_size: SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_SIZE,
        )
        render json: result
      else
        render json: result, status: :unprocessable_entity
      end
    end

    def reset
      guardian.ensure_can_toggle_shared_edits!

      post = Post.find(params[:post_id].to_i)
      new_version = SharedEditRevision.reset_history!(post.id)

      # Notify connected clients to resync
      post.publish_message!(
        "/shared_edits/#{post.id}",
        { action: "resync", version: new_version },
        max_backlog_age: SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_AGE,
        max_backlog_size: SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_SIZE,
      )

      render json: { success: true, version: new_version }
    end

    protected

    def ensure_shared_edits
      raise Discourse::InvalidAccess if !SiteSetting.shared_edits_enabled
    end
  end
end
