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
      guardian.ensure_can_edit!(post)

      # Only allowed if shared edits are enabled for this post
      unless post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]
        raise Discourse::NotFound
      end

      revision = SharedEditRevision.where(post_id: post.id).order("version desc").first

      # If not initialized, we should 404 as expected by tests and original logic
      raise Discourse::NotFound if revision.nil?

      # Capture MessageBus ID as close as possible to the revision state
      message_bus_last_id = MessageBus.last_id("/shared_edits/#{post.id}")

      begin
        if revision.raw.blank?
          raise DiscourseSharedEdits::StateValidator::StateCorruptionError.new(
                  "Latest revision has empty state",
                  post_id: post.id,
                )
        end

        render json: {
                 raw: DiscourseSharedEdits::Yjs.text_from_state(revision.raw),
                 version: revision.version,
                 state: revision.raw,
                 message_bus_last_id: message_bus_last_id,
               }
      rescue StandardError => e
        # If state is corrupted, attempt recovery
        Rails.logger.warn(
          "[SharedEdits] State corrupted for post #{post.id}, attempting recovery: #{e.message}",
        )
        recovery = StateValidator.recover_from_post_raw(post.id, force: true)
        if recovery[:success]
          revision = SharedEditRevision.where(post_id: post.id).order("version desc").first
          render json: {
                   raw: DiscourseSharedEdits::Yjs.text_from_state(revision.raw),
                   version: revision.version,
                   state: revision.raw,
                   message_bus_last_id: message_bus_last_id,
                 }
        else
          raise Discourse::InvalidAccess.new(
                  I18n.t("shared_edits.errors.state_corrupted"),
                  custom_message: "shared_edits.errors.state_corrupted",
                )
        end
      end
    end

    def commit
      params.require(:post_id)

      post = Post.find(params[:post_id].to_i)
      guardian.ensure_can_edit!(post)

      # Only allowed if shared edits are enabled for this post
      unless post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]
        raise Discourse::NotFound
      end
      SharedEditRevision.commit!(post.id)

      render json: success_json
    end

    def revise
      params.require(:client_id)

      post = Post.find(params[:post_id].to_i)
      guardian.ensure_can_edit!(post)

      # Shared edits allows users who can edit the post to participate
      # once it's enabled (the toggle itself is restricted to staff/TL4+)
      # Verify shared edits are enabled on this post
      unless post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]
        raise Discourse::NotFound
      end

      awareness = params[:awareness]
      if awareness.present?
        validation = StateValidator.validate_awareness(awareness)
        unless validation[:valid]
          render json: failed_json, status: :bad_request
          return
        end
      end

      # Rich mode may send awareness-only updates (no document changes)
      # In that case, just broadcast awareness and return success
      if params[:update].blank?
        if awareness.present?
          # Broadcast awareness update to other clients
          post.publish_message!(
            "/shared_edits/#{post.id}",
            {
              client_id: params[:client_id],
              user_id: current_user.id,
              user_name: current_user.username,
              awareness: awareness,
            },
            max_backlog_age: SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_AGE,
            max_backlog_size: SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_SIZE,
          )
          render json: success_json
        else
          render json: failed_json, status: :bad_request
        end
        return
      end

      cursor_params = params[:cursor]
      cursor_hash =
        case cursor_params
        when ActionController::Parameters
          cursor_params.permit(:start, :end).to_h
        when Hash
          cursor_params.slice(:start, :end, "start", "end")
        end
      cursor_hash = cursor_hash&.transform_keys(&:to_s)&.compact

      version, update =
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: current_user.id,
          client_id: params[:client_id],
          update: params[:update],
          cursor: cursor_hash,
          awareness: awareness,
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
