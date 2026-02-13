# frozen_string_literal: true

class ResizeSharedEditColumns < ActiveRecord::Migration[7.0]
  def change
    change_column :shared_edit_revisions, :raw, :text
    change_column :shared_edit_revisions, :revision, :text
  end
end
