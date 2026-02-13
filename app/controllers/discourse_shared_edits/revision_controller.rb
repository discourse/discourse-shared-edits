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
      post = Post.find(params[:post_id].to_i)
      guardian.ensure_can_see!(post)
      guardian.ensure_can_toggle_shared_edits!
      SharedEditRevision.toggle_shared_edits!(post.id, true)
      render json: success_json
    end

    def disable
      post = Post.find(params[:post_id].to_i)
      guardian.ensure_can_see!(post)
      guardian.ensure_can_toggle_shared_edits!
      disabled = SharedEditRevision.toggle_shared_edits!(post.id, false)
      if !disabled
        render json: {
                 error: Protocol::Errors::DISABLE_FAILED,
                 message: I18n.t("shared_edits.errors.disable_failed"),
               },
               status: :unprocessable_entity
        return
      end
      render json: success_json
    end

    def latest
      guardian.ensure_can_edit!(@post)

      SharedEditRevision.transaction do
        revision = SharedEditRevision.where(post_id: @post.id).lock.order("version desc").first
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
        rescue MiniRacer::RuntimeError,
               MiniRacer::ParseError,
               ArgumentError,
               StateValidator::StateCorruptionError => e
          Rails.logger.warn(
            "[SharedEdits] State corrupted for post #{@post.id}, attempting recovery: #{e.message}",
          )
          recovery = StateValidator.recover_from_post_raw(@post.id, force: true)
          if recovery[:success]
            publish_resync!(recovery[:new_version])
            revision = SharedEditRevision.where(post_id: @post.id).order("version desc").first

            message_bus_last_id =
              MessageBus.last_id(SharedEditRevision.message_bus_channel(@post.id))

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
    end

    def commit
      params.require(:post_id)

      guardian.ensure_can_edit!(@post)
      commit_result =
        SharedEditRevision.with_commit_lock(@post.id) { SharedEditRevision.commit!(@post.id) }

      if commit_result.nil?
        render json: {
                 error: Protocol::Errors::COMMIT_FAILED,
                 message: I18n.t("shared_edits.errors.commit_failed"),
               },
               status: :unprocessable_entity
        return
      end

      render json: success_json
    end

    def revise
      params.require(:client_id)

      guardian.ensure_can_edit!(@post)
      client_id = params[:client_id]

      if params[:recovery_text].present?
        return if !ensure_valid_client_id!(client_id)

        RateLimiter.new(current_user, "shared-edit-recover-#{@post.id}", 20, 1.minute).performed!

        health = StateValidator.health_check(@post.id)
        if health[:state] == :initialized && health[:healthy]
          render json: {
                   error: Protocol::Errors::RECOVERY_NOT_NEEDED,
                   message: I18n.t("shared_edits.errors.recovery_not_needed"),
                 },
                 status: :conflict
          return
        end

        recovery = StateValidator.recover_from_text(@post.id, params[:recovery_text])
        if recovery[:success]
          publish_resync!(recovery[:new_version])
          render json: {
                   error: Protocol::Errors::STATE_RECOVERED_FROM_CLIENT,
                   version: recovery[:new_version],
                 },
                 status: :ok
        else
          render json: {
                   error: Protocol::Errors::RECOVERY_FAILED,
                   message: recovery[:message],
                 },
                 status: :unprocessable_entity
        end
        return
      end

      RateLimiter.new(current_user, "shared-edit-revise-#{@post.id}", 120, 1.minute).performed!

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
          return if !ensure_valid_client_id!(client_id)

          @post.publish_message!(
            SharedEditRevision.message_bus_channel(@post.id),
            {
              client_id: client_id,
              user_id: current_user.id,
              username: current_user.username,
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

      allow_blank_state =
        if guardian.can_toggle_shared_edits?
          ActiveModel::Type::Boolean.new.cast(params[:allow_blank_state])
        else
          false
        end

      DiscourseSharedEdits::Revise.call(
        post: @post,
        current_user: current_user,
        client_id: client_id,
        update: params[:update],
        cursor: cursor_hash,
        awareness: awareness,
        allow_blank_state: allow_blank_state,
        state_vector: params[:state_vector],
      ) do |result|
        on_success do
          response = { version: result[:version], update: result[:update] }
          response[:state_hash] = result[:state_hash] if result[:state_hash].present?
          render json: response
        end

        on_failure do
          render json: {
                   error: Protocol::Errors::INVALID_UPDATE,
                   message: I18n.t("shared_edits.errors.invalid_update"),
                 },
                 status: :unprocessable_entity
        end
      end
    rescue StateValidator::UnexpectedBlankStateError => e
      Rails.logger.warn(
        "[SharedEdits] Rejected blank update for post #{params[:post_id]}: #{e.message}",
      )
      render json: {
               error: Protocol::Errors::BLANK_STATE_REJECTED,
               message: I18n.t("shared_edits.errors.blank_state_rejected"),
             },
             status: :unprocessable_entity
    rescue StateValidator::InvalidUpdateError => e
      Rails.logger.warn(
        "[SharedEdits] Invalid update payload for post #{params[:post_id]}: #{e.message}",
      )
      render json: {
               error: Protocol::Errors::INVALID_UPDATE,
               message: I18n.t("shared_edits.errors.invalid_update"),
             },
             status: :bad_request
    rescue StateValidator::PostLengthExceededError => e
      Rails.logger.warn(
        "[SharedEdits] Post length exceeded for post #{params[:post_id]}: #{e.message}",
      )
      render json: {
               error: Protocol::Errors::POST_LENGTH_EXCEEDED,
               message:
                 I18n.t(
                   "shared_edits.errors.post_length_exceeded",
                   current: e.current_length,
                   max: e.max_length,
                 ),
               current_length: e.current_length,
               max_length: e.max_length,
             },
             status: :unprocessable_entity
    rescue StateValidator::StateCorruptionError => e
      Rails.logger.warn(
        "[SharedEdits] State corruption in revise for post #{params[:post_id]}: #{e.message}",
      )

      render json: {
               error: Protocol::Errors::NEEDS_RECOVERY_TEXT,
               message: I18n.t("shared_edits.errors.needs_recovery_text"),
             },
             status: :conflict
    rescue StateValidator::StateDivergedError => e
      Rails.logger.info("[SharedEdits] State diverged for post #{params[:post_id]}: #{e.message}")

      render json: {
               error: Protocol::Errors::STATE_DIVERGED,
               missing_update: e.missing_update,
             },
             status: :conflict
    rescue StateValidator::SharedEditsNotInitializedError => e
      Rails.logger.info(
        "[SharedEdits] Shared edits not initialized for post #{params[:post_id]}: #{e.message}",
      )

      render json: {
               error: Protocol::Errors::NOT_INITIALIZED,
               message: I18n.t("shared_edits.errors.not_initialized"),
             },
             status: :conflict
    end

    def health
      guardian.ensure_can_see!(@post)
      guardian.ensure_can_toggle_shared_edits!

      health = StateValidator.health_check(@post.id)

      render json: health
    end

    def recover
      guardian.ensure_can_see!(@post)
      guardian.ensure_can_toggle_shared_edits!

      # Staff-only endpoint, skip rate limiting since it's already protected by guardian
      result =
        StateValidator.recover_from_post_raw(
          @post.id,
          force: ActiveModel::Type::Boolean.new.cast(params[:force]),
          skip_rate_limit: true,
        )

      if result[:success]
        publish_resync!(result[:new_version])
        render json: result
      else
        render json: result, status: :unprocessable_entity
      end
    end

    def reset
      guardian.ensure_can_see!(@post)
      guardian.ensure_can_toggle_shared_edits!

      new_version = SharedEditRevision.reset_history!(@post.id)
      if new_version.nil?
        render json: {
                 error: Protocol::Errors::RESET_FAILED,
                 message: I18n.t("shared_edits.errors.reset_failed"),
               },
               status: :unprocessable_entity
        return
      end

      publish_resync!(new_version)

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

    def publish_resync!(version)
      @post.publish_message!(
        SharedEditRevision.message_bus_channel(@post.id),
        { action: Protocol::MessageActions::RESYNC, version: version },
        max_backlog_age: SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_AGE,
        max_backlog_size: SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_SIZE,
      )
    end

    def ensure_valid_client_id!(client_id)
      validation = StateValidator.validate_client_id(client_id)
      return true if validation[:valid]

      render json: {
               error: Protocol::Errors::INVALID_UPDATE,
               message: I18n.t("shared_edits.errors.invalid_update"),
             },
             status: :bad_request
      false
    end
  end
end
