# frozen_string_literal: true

module DiscourseSharedEdits
  module StateValidator
    SNAPSHOT_THRESHOLD_BYTES = 100.kilobytes
    RECOVERY_RATE_LIMIT_SECONDS = 30
    MAX_RECOVERY_ATTEMPTS_PER_HOUR = 10
    MAX_UPDATE_BYTES = 1.megabyte
    MAX_STATE_VECTOR_BYTES = 64.kilobytes
    MAX_CLIENT_ID_LENGTH = 255

    class StateCorruptionError < StandardError
      attr_reader :post_id, :version, :recovery_attempted

      def initialize(message, post_id: nil, version: nil, recovery_attempted: false)
        @post_id = post_id
        @version = version
        @recovery_attempted = recovery_attempted
        super(message)
      end
    end

    class UnexpectedBlankStateError < StandardError
      attr_reader :post_id

      def initialize(message, post_id:)
        @post_id = post_id
        super(message)
      end
    end

    class InvalidUpdateError < StandardError
      attr_reader :post_id

      def initialize(message, post_id:)
        @post_id = post_id
        super(message)
      end
    end

    class PostLengthExceededError < StandardError
      attr_reader :post_id, :current_length, :max_length

      def initialize(message, post_id:, current_length:, max_length:)
        @post_id = post_id
        @current_length = current_length
        @max_length = max_length
        super(message)
      end
    end

    class StateDivergedError < StandardError
      attr_reader :post_id, :missing_update

      def initialize(message, post_id:, missing_update:)
        @post_id = post_id
        @missing_update = missing_update
        super(message)
      end
    end

    class SharedEditsNotInitializedError < StandardError
      attr_reader :post_id

      def initialize(message, post_id:)
        @post_id = post_id
        super(message)
      end
    end

    class << self
      def validate_state(state_b64)
        return { valid: false, text: nil, error: "State is nil" } if state_b64.nil?
        return { valid: false, text: nil, error: "State is empty" } if state_b64.empty?

        begin
          decoded = Base64.strict_decode64(state_b64)
          return { valid: false, text: nil, error: "Decoded state is empty" } if decoded.empty?
        rescue ArgumentError => e
          return { valid: false, text: nil, error: "Invalid base64: #{e.message}" }
        end

        begin
          text = DiscourseSharedEdits::Yjs.text_from_state(state_b64)
          { valid: true, text: text, error: nil }
        rescue MiniRacer::RuntimeError, MiniRacer::ParseError => e
          { valid: false, text: nil, error: "Yjs extraction failed: #{e.message}" }
        rescue StandardError => e
          { valid: false, text: nil, error: "Unexpected error: #{e.message}" }
        end
      end

      def validate_update(update_b64)
        return { valid: false, error: "Update is nil" } if update_b64.nil?
        return { valid: false, error: "Update is empty" } if update_b64.empty?

        begin
          decoded = Base64.strict_decode64(update_b64)
          return { valid: false, error: "Decoded update is empty" } if decoded.empty?
          if decoded.bytesize > MAX_UPDATE_BYTES
            return { valid: false, error: "Update payload too large (#{decoded.bytesize} bytes)" }
          end
          { valid: true, error: nil }
        rescue ArgumentError => e
          { valid: false, error: "Invalid base64: #{e.message}" }
        end
      end

      def should_snapshot?(state_b64)
        return false if state_b64.blank?

        state_bytes = Base64.strict_decode64(state_b64).bytesize
        state_bytes > SNAPSHOT_THRESHOLD_BYTES
      rescue ArgumentError
        false
      end

      def validate_awareness(awareness_b64)
        return { valid: false, error: "Awareness is nil" } if awareness_b64.nil?
        return { valid: false, error: "Awareness is empty" } if awareness_b64.empty?

        begin
          decoded = Base64.strict_decode64(awareness_b64)
          return { valid: false, error: "Decoded awareness is empty" } if decoded.empty?
          if decoded.bytesize > SharedEditRevision::MAX_AWARENESS_BYTES
            return { valid: false, error: "Awareness payload too large" }
          end
          { valid: true, error: nil }
        rescue ArgumentError => e
          { valid: false, error: "Invalid base64: #{e.message}" }
        end
      end

      def validate_state_vector(state_vector_b64)
        return { valid: false, error: "State vector is nil" } if state_vector_b64.nil?
        return { valid: false, error: "State vector is empty" } if state_vector_b64.empty?

        begin
          decoded = Base64.strict_decode64(state_vector_b64)
          return { valid: false, error: "Decoded state vector is empty" } if decoded.empty?
          if decoded.bytesize > MAX_STATE_VECTOR_BYTES
            return { valid: false, error: "State vector payload too large" }
          end
          { valid: true, error: nil }
        rescue ArgumentError => e
          { valid: false, error: "Invalid base64: #{e.message}" }
        end
      end

      def validate_client_id(client_id)
        return { valid: false, error: "Client ID is nil" } if client_id.nil?
        return { valid: false, error: "Client ID must be a string" } if !client_id.is_a?(String)
        return { valid: false, error: "Client ID is empty" } if client_id.empty?
        if client_id.bytesize > MAX_CLIENT_ID_LENGTH
          return { valid: false, error: "Client ID is too long" }
        end

        { valid: true, error: nil }
      end

      def validate_client_state_vector(server_state_b64, client_sv_b64)
        sv_validation = validate_state_vector(client_sv_b64)
        return sv_validation unless sv_validation[:valid]

        begin
          server_sv = DiscourseSharedEdits::Yjs.get_state_vector(server_state_b64)
          client_sv = Base64.strict_decode64(client_sv_b64).bytes

          result = DiscourseSharedEdits::Yjs.compare_state_vectors(client_sv, server_sv)

          if result[:valid]
            { valid: true }
          else
            missing_update =
              DiscourseSharedEdits::Yjs.get_missing_update(server_state_b64, client_sv)
            { valid: false, missing_update: missing_update }
          end
        rescue MiniRacer::RuntimeError, MiniRacer::ParseError => e
          { valid: false, error: "Yjs state vector comparison failed: #{e.message}" }
        rescue StandardError => e
          { valid: false, error: "Unexpected error: #{e.message}" }
        end
      end

      def health_check(post_id)
        report = { post_id: post_id, healthy: true, errors: [], warnings: [], state: nil }

        revisions = SharedEditRevision.where(post_id: post_id).order(:version).to_a

        if revisions.empty?
          report[:state] = :not_initialized
          return report
        end

        report[:state] = :initialized
        report[:revision_count] = revisions.length
        report[:version_range] = [revisions.first.version, revisions.last.version]

        expected_version = revisions.first.version
        version_gaps = []
        revisions.each do |rev|
          if rev.version != expected_version
            version_gaps << { expected: expected_version, got: rev.version }
          end
          expected_version = rev.version + 1
        end
        report[:version_gaps] = version_gaps if version_gaps.any?

        latest = revisions.last
        if latest.raw.present?
          validation = validate_state(latest.raw)
          if validation[:valid]
            report[:current_text] = validation[:text]
            report[:text_length] = validation[:text]&.length

            state_bytes =
              begin
                Base64.decode64(latest.raw).bytesize
              rescue StandardError
                0
              end
            text_bytes = [validation[:text].to_s.bytesize, 1].max

            report[:state_size_bytes] = state_bytes
            report[:text_size_bytes] = text_bytes
            report[:bloat_ratio] = (state_bytes.to_f / text_bytes).round(2)

            if should_snapshot?(latest.raw)
              report[
                :warnings
              ] << "State is bloated (#{state_bytes} bytes) - snapshot will occur on next commit"
            end
          else
            report[:healthy] = false
            report[
              :errors
            ] << "Latest state (v#{latest.version}) is corrupted: #{validation[:error]}"
          end
        else
          report[:healthy] = false
          report[:errors] << "Latest revision has nil state"
        end

        report
      end

      def recover_from_post_raw(post_id, force: false, skip_rate_limit: false)
        post = Post.find_by(id: post_id)
        return { success: false, message: "Post not found" } if post.nil?

        unless skip_rate_limit
          rate_limit_result = check_recovery_rate_limit(post_id)
          unless rate_limit_result[:allowed]
            Rails.logger.warn(
              "[SharedEdits] Recovery rate limited for post #{post_id}: #{rate_limit_result[:message]}",
            )
            return { success: false, message: rate_limit_result[:message] }
          end
        end

        unless force
          health = health_check(post_id)
          if health[:healthy]
            return { success: false, message: "State is healthy, use force: true to override" }
          end
        end

        SharedEditRevision.with_commit_lock(post_id) do
          SharedEditRevision.transaction do
            next_version = (SharedEditRevision.where(post_id: post_id).maximum(:version) || 0) + 1

            initial_state = DiscourseSharedEdits::Yjs.state_from_text(post.raw)

            revision =
              SharedEditRevision.create!(
                post_id: post_id,
                client_id: "recovery",
                user_id: Discourse.system_user.id,
                version: next_version,
                revision: "",
                raw: initial_state[:state],
                post_revision_id: SharedEditRevision.last_revision_id_for_post(post),
              )

            validation = validate_state(revision.raw)
            unless validation[:valid]
              raise StateCorruptionError.new(
                      "Recovery failed: new state is also invalid",
                      post_id: post_id,
                      recovery_attempted: true,
                    )
            end

            Rails.logger.info("[SharedEdits] Recovered state for post #{post_id} from post.raw")

            {
              success: true,
              message: "State recovered from post.raw",
              new_version: revision.version,
            }
          end
        end
      rescue ActiveRecord::RecordInvalid => e
        { success: false, message: "Database error: #{e.message}" }
      rescue StateCorruptionError => e
        { success: false, message: e.message }
      end

      def recover_from_text(post_id, text)
        post = Post.find_by(id: post_id)
        return { success: false, message: "Post not found" } if post.nil?

        max_length = SiteSetting.max_post_length
        if text.length > max_length
          return { success: false, message: "Text exceeds maximum length" }
        end

        rate_limit_result = check_recovery_rate_limit(post_id)
        unless rate_limit_result[:allowed]
          Rails.logger.warn(
            "[SharedEdits] Recovery rate limited for post #{post_id}: #{rate_limit_result[:message]}",
          )
          return { success: false, message: rate_limit_result[:message] }
        end

        SharedEditRevision.with_commit_lock(post_id) do
          SharedEditRevision.transaction do
            next_version = (SharedEditRevision.where(post_id: post_id).maximum(:version) || 0) + 1

            initial_state = DiscourseSharedEdits::Yjs.state_from_text(text)

            revision =
              SharedEditRevision.create!(
                post_id: post_id,
                client_id: "recovery",
                user_id: Discourse.system_user.id,
                version: next_version,
                revision: "",
                raw: initial_state[:state],
                post_revision_id: nil,
              )

            validation = validate_state(revision.raw)
            unless validation[:valid]
              raise StateCorruptionError.new(
                      "Recovery failed: generated state is invalid",
                      post_id: post_id,
                      recovery_attempted: true,
                    )
            end

            Rails.logger.info("[SharedEdits] Recovered state for post #{post_id} from client text")

            {
              success: true,
              message: "State recovered from client text",
              new_version: revision.version,
            }
          end
        end
      rescue ActiveRecord::RecordInvalid => e
        { success: false, message: "Database error: #{e.message}" }
      rescue StateCorruptionError => e
        { success: false, message: e.message }
      end

      def safe_apply_update(post_id, current_state, update, allow_blank_state: false)
        update_validation = validate_update(update)
        unless update_validation[:valid]
          Rails.logger.warn(
            "[SharedEdits] Invalid update for post #{post_id}: #{update_validation[:error]}",
          )
          raise InvalidUpdateError.new(
                  "Invalid update: #{update_validation[:error]}",
                  post_id: post_id,
                )
        end

        previous_text =
          begin
            DiscourseSharedEdits::Yjs.text_from_state(current_state)
          rescue StandardError
            nil
          end

        result = DiscourseSharedEdits::Yjs.apply_update(current_state, update)

        state_validation = validate_state(result[:state])
        unless state_validation[:valid]
          Rails.logger.error(
            "[SharedEdits] State corruption after update for post #{post_id}: #{state_validation[:error]}",
          )
          raise StateCorruptionError.new(
                  "State corrupted after update: #{state_validation[:error]}",
                  post_id: post_id,
                )
        end

        text_length = result[:text]&.length || 0
        max_length = SiteSetting.max_post_length
        previous_length = previous_text&.length || 0
        if text_length > max_length && text_length > previous_length
          raise PostLengthExceededError.new(
                  "Post length #{text_length} exceeds maximum allowed #{max_length}",
                  post_id: post_id,
                  current_length: text_length,
                  max_length: max_length,
                )
        end

        if result[:text].blank? && previous_text.present? && !allow_blank_state
          raise UnexpectedBlankStateError.new(
                  "Blank update rejected because allow_blank_state flag not provided",
                  post_id: post_id,
                )
        end

        result
      end

      private

      def check_recovery_rate_limit(post_id)
        cooldown_key = "shared_edits_recovery_cooldown_#{post_id}"
        counter_key = "shared_edits_recovery_count_#{post_id}"

        count = Discourse.redis.get(counter_key).to_i
        if count >= MAX_RECOVERY_ATTEMPTS_PER_HOUR
          ttl = Discourse.redis.ttl(counter_key)
          return(
            {
              allowed: false,
              message:
                "Too many recovery attempts (#{MAX_RECOVERY_ATTEMPTS_PER_HOUR}/hour). " \
                  "Please wait #{ttl} seconds.",
            }
          )
        end

        cooldown_acquired =
          Discourse.redis.set(cooldown_key, "1", ex: RECOVERY_RATE_LIMIT_SECONDS, nx: true)
        unless cooldown_acquired
          ttl = Discourse.redis.ttl(cooldown_key)
          return(
            {
              allowed: false,
              message: "Recovery rate limited. Please wait #{ttl} seconds before trying again.",
            }
          )
        end

        Discourse.redis.multi do |multi|
          multi.incr(counter_key)
          multi.expire(counter_key, 1.hour.to_i)
        end

        { allowed: true }
      end
    end
  end
end
