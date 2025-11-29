# frozen_string_literal: true

RSpec.describe "Discourse Shared Edits | Editing a post", system: true do
  fab!(:admin)
  fab!(:post) { Fabricate(:post, user: admin, raw: "lorem ipsum\n") }
  let(:composer) { PageObjects::Components::Composer.new }

  before { sign_in(admin) }

  it "allows the user to edit and save a post" do
    visit(post.topic.relative_url)

    find(".show-more-actions").click
    find(".show-post-admin-menu").click
    find(".admin-toggle-shared-edits").click

    try_until_success do
      revision = SharedEditRevision.find_by(post_id: post.id, version: 1)
      expect(revision).to be_present
      expect(DiscourseSharedEdits::Yjs.text_from_state(revision.raw)).to eq("lorem ipsum\n")
      expect(revision.revision).to eq("")
      expect(SharedEditRevision.count).to eq(1)
    end

    find(".shared-edit").click
    expect(composer).to have_content("lorem ipsum")

    composer.type_content "foo"
    try_until_success do
      revision = SharedEditRevision.find_by(post_id: post.id, version: 2)
      expect(revision).to be_present
      expect(DiscourseSharedEdits::Yjs.text_from_state(revision.raw)).to eq("lorem ipsum\nfoo")
      expect(SharedEditRevision.count).to eq(2)
    end

    composer.type_content " bar"
    try_until_success do
      revision = SharedEditRevision.find_by(post_id: post.id, version: 3)
      expect(revision).to be_present
      expect(DiscourseSharedEdits::Yjs.text_from_state(revision.raw)).to eq("lorem ipsum\nfoo bar")
      expect(SharedEditRevision.count).to eq(3)
    end

    find(".leave-shared-edit .btn-primary").click
    try_until_success do
      expect(post.reload.raw).to eq("lorem ipsum\nfoo bar")
      expect(find("#post_1 .cooked > p")).to have_content("lorem ipsum\nfoo bar")
      expect(SharedEditRevision.count).to eq(3)
    end
  end
end
