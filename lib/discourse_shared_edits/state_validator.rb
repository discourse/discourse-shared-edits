# frozen_string_literal: true

module DiscourseSharedEdits
  module StateValidator
    SNAPSHOT_THRESHOLD_BYTES = 100.kilobytes

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
          { valid: true, error: nil }
        rescue ArgumentError => e
          { valid: false, error: "Invalid base64: #{e.message}" }
        end
      end

      def should_snapshot?(state_b64)
        return false if state_b64.blank?

        state_bytes = Base64.decode64(state_b64).bytesize
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

      def recover_from_post_raw(post_id, force: false)
        post = Post.find_by(id: post_id)
        return { success: false, message: "Post not found" } if post.nil?

        unless force
          health = health_check(post_id)
          if health[:healthy]
            return { success: false, message: "State is healthy, use force: true to override" }
          end
        end

        SharedEditRevision.transaction do
          SharedEditRevision.where(post_id: post_id).delete_all

          initial_state = DiscourseSharedEdits::Yjs.state_from_text(post.raw)

          revision =
            SharedEditRevision.create!(
              post_id: post_id,
              client_id: "recovery",
              user_id: Discourse.system_user.id,
              version: 1,
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

          { success: true, message: "State recovered from post.raw", new_version: revision.version }
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
          raise StateCorruptionError.new(
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
        if text_length > max_length
          raise StateCorruptionError.new(
                  "Post length #{text_length} exceeds maximum allowed #{max_length}",
                  post_id: post_id,
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
    end
  end
end
