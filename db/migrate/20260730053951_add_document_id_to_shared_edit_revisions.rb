# frozen_string_literal: true

class AddDocumentIdToSharedEditRevisions < ActiveRecord::Migration[8.0]
  def up
    add_column :shared_edit_revisions, :document_id, :uuid
  end

  def down
    remove_column :shared_edit_revisions, :document_id
  end
end
