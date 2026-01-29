# frozen_string_literal: true

class AddStateHashToSharedEditRevisions < ActiveRecord::Migration[7.0]
  def up
    add_column :shared_edit_revisions, :state_hash, :string, limit: 64
  end

  def down
    remove_column :shared_edit_revisions, :state_hash
  end
end
