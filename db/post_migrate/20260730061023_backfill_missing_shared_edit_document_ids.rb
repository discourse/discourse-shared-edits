# frozen_string_literal: true

class BackfillMissingSharedEditDocumentIds < ActiveRecord::Migration[8.0]
  disable_ddl_transaction!

  BATCH_SIZE = 1_000

  def up
    loop do
      updated = DB.exec(<<~SQL, batch_size: BATCH_SIZE)
          WITH affected_posts AS (
            SELECT DISTINCT post_id
            FROM shared_edit_revisions
            WHERE document_id IS NULL
            LIMIT :batch_size
          ), identities AS (
            SELECT
              affected_posts.post_id,
              COALESCE(
                (
                  SELECT document_id
                  FROM shared_edit_revisions existing
                  WHERE existing.post_id = affected_posts.post_id
                    AND existing.document_id IS NOT NULL
                  ORDER BY version DESC
                  LIMIT 1
                ),
                md5('shared-edits:' || affected_posts.post_id::text)::uuid
              ) AS document_id
            FROM affected_posts
          )
          UPDATE shared_edit_revisions revisions
          SET document_id = identities.document_id
          FROM identities
          WHERE revisions.post_id = identities.post_id
            AND revisions.document_id IS NULL
        SQL
      break if updated == 0
    end
  end

  def down
    raise ActiveRecord::IrreversibleMigration
  end
end
