# frozen_string_literal: true

module Jobs
  class CommitSharedRevision < ::Jobs::Base
    def execute(args)
      post_id = args[:post_id]
      SharedEditRevision.with_commit_lock(post_id) do
        SharedEditRevision.clear_commit_schedule(post_id)
        SharedEditRevision.commit!(post_id)
      end
    end
  end
end
