# frozen_string_literal: true

module DiscourseSharedEdits
  class Revise
    include Service::Base

    step :validate_client_id
    step :apply_revision

    private

    def validate_client_id(post:, client_id:)
      validation = StateValidator.validate_client_id(client_id)
      return if validation[:valid]

      raise StateValidator::InvalidUpdateError.new(
              "Invalid client_id: #{validation[:error]}",
              post_id: post.id,
            )
    end

    def apply_revision(post:, current_user:, client_id:, update:)
      version, update_payload, state_hash =
        SharedEditRevision.revise!(
          post_id: post.id,
          user_id: current_user.id,
          client_id: client_id,
          update: update,
          cursor: context[:cursor],
          awareness: context[:awareness],
          post: post,
          username: current_user.username,
          allow_blank_state: context[:allow_blank_state] || false,
          state_vector: context[:state_vector],
        )

      SharedEditRevision.ensure_will_commit(post.id)
      context[:version] = version
      context[:update] = update_payload
      context[:state_hash] = state_hash
    end
  end
end
