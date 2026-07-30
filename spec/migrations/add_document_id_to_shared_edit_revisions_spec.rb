# frozen_string_literal: true

require Rails.root.join(
          "plugins/discourse-shared-edits/db/migrate/20260730053951_add_document_id_to_shared_edit_revisions.rb",
        )

require Rails.root.join(
          "plugins/discourse-shared-edits/db/post_migrate/20260730061023_backfill_missing_shared_edit_document_ids.rb",
        )

RSpec.describe BackfillMissingSharedEditDocumentIds do
  fab!(:first_post, :post)
  fab!(:second_post, :post)

  before do
    @original_verbose = ActiveRecord::Migration.verbose
    ActiveRecord::Migration.verbose = false
    SharedEditRevision.reset_column_information
    SharedEditRevision.init!(first_post)
    SharedEditRevision.init!(second_post)
  end

  after do
    if !ActiveRecord::Base.connection.column_exists?(:shared_edit_revisions, :document_id)
      AddDocumentIdToSharedEditRevisions.new.up
    end
    SharedEditRevision.reset_column_information
    ActiveRecord::Migration.verbose = @original_verbose
  end

  it "backfills one stable document identity per post" do
    migration = AddDocumentIdToSharedEditRevisions.new
    migration.down
    migration.up
    described_class.new.up
    SharedEditRevision.reset_column_information

    first_document_ids =
      SharedEditRevision.where(post_id: first_post.id).distinct.pluck(:document_id)
    second_document_ids =
      SharedEditRevision.where(post_id: second_post.id).distinct.pluck(:document_id)

    expect(first_document_ids.length).to eq(1)
    expect(second_document_ids.length).to eq(1)
    expect(first_document_ids.first).to be_present
    expect(first_document_ids.first).not_to eq(second_document_ids.first)
  end
end
