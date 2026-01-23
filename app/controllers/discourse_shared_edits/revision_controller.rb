# frozen_string_literal: true

module ::DiscourseSharedEdits
  class RevisionController < ::ApplicationController
    requires_plugin PLUGIN_NAME

    requires_login
    before_action :ensure_logged_in, :ensure_shared_edits
    before_action :load_post, only: %i[latest commit revise health recover reset]
    before_action :ensure_shared_edits_enabled_for_post, only: %i[latest commit revise]
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
      guardian.ensure_can_edit!(@post)

      revision = SharedEditRevision.where(post_id: @post.id).order("version desc").first
      raise Discourse::NotFound if revision.nil?

      message_bus_last_id = MessageBus.last_id(SharedEditRevision.message_bus_channel(@post.id))

      begin
        if revision.raw.blank?
          raise DiscourseSharedEdits::StateValidator::StateCorruptionError.new(
                  "Latest revision has empty state",
                  post_id: @post.id,
                )
        end

        render json: {
                 raw: DiscourseSharedEdits::Yjs.text_from_state(revision.raw),
                 version: revision.version,
                 state: revision.raw,
                 message_bus_last_id: message_bus_last_id,
               }
      rescue StandardError => e
        Rails.logger.warn(
          "[SharedEdits] State corrupted for post #{@post.id}, attempting recovery: #{e.message}",
        )
        recovery = StateValidator.recover_from_post_raw(@post.id, force: true)
        if recovery[:success]
          revision = SharedEditRevision.where(post_id: @post.id).order("version desc").first
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

      guardian.ensure_can_edit!(@post)
      SharedEditRevision.commit!(@post.id)

      render json: success_json
    end

    def revise
      params.require(:client_id)

      guardian.ensure_can_edit!(@post)

      RateLimiter.new(current_user, "shared-edit-revise-#{@post.id}", 60, 1.minute).performed!

      awareness = params[:awareness]
      if awareness.present?
        validation = StateValidator.validate_awareness(awareness)
        unless validation[:valid]
          render json: failed_json, status: :bad_request
          return
        end
      end

      if params[:update].blank?
        if awareness.present?
          @post.publish_message!(
            SharedEditRevision.message_bus_channel(@post.id),
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

      allow_blank_state = ActiveModel::Type::Boolean.new.cast(params[:allow_blank_state])

      version, update =
        SharedEditRevision.revise!(
          post_id: @post.id,
          user_id: current_user.id,
          client_id: params[:client_id],
          update: params[:update],
          cursor: cursor_hash,
          awareness: awareness,
          post: @post,
          user_name: current_user.username,
          allow_blank_state: allow_blank_state,
        )

      SharedEditRevision.ensure_will_commit(@post.id)

      render json: { version: version, update: update }
    rescue StateValidator::UnexpectedBlankStateError => e
      Rails.logger.warn(
        "[SharedEdits] Rejected blank update for post #{params[:post_id]}: #{e.message}",
      )
      render json: {
               error: "blank_state_rejected",
               message: I18n.t("shared_edits.errors.blank_state_rejected"),
             },
             status: :unprocessable_entity
    rescue StateValidator::StateCorruptionError => e
      Rails.logger.error(
        "[SharedEdits] State corruption in revise for post #{params[:post_id]}: #{e.message}",
      )

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

      health = StateValidator.health_check(@post.id)

      render json: health
    end

    def recover
      guardian.ensure_can_toggle_shared_edits!

      result = StateValidator.recover_from_post_raw(@post.id, force: params[:force] == "true")

      if result[:success]
        @post.publish_message!(
          SharedEditRevision.message_bus_channel(@post.id),
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

      new_version = SharedEditRevision.reset_history!(@post.id)

      @post.publish_message!(
        SharedEditRevision.message_bus_channel(@post.id),
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

    def load_post
      @post = Post.find(params[:post_id].to_i)
    end

    def ensure_shared_edits_enabled_for_post
      unless @post.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]
        raise Discourse::NotFound
      end
    end
  end
end
