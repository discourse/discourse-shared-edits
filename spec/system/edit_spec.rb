# frozen_string_literal: true

RSpec.describe "Discourse Shared Edits | Editing a post", system: true do
  fab!(:admin)
  fab!(:post) { Fabricate(:post, user: admin, raw: "lorem ipsum\n") }
  fab!(:remote_user, :user)
  let(:composer) { PageObjects::Components::SharedEditsComposer.new }
  let(:topic_page) { PageObjects::Pages::SharedEditsTopic.new }

  before { sign_in(admin) }

  it "allows the user to edit and save a post" do
    topic_page.visit_topic(post.topic)
    topic_page.toggle_shared_edits_for(post)

    try_until_success do
      revision = SharedEditRevision.find_by(post_id: post.id, version: 1)
      expect(revision).to be_present
      expect(DiscourseSharedEdits::Yjs.text_from_state(revision.raw)).to eq("lorem ipsum\n")
      expect(revision.revision).to eq("")
      expect(SharedEditRevision.count).to eq(1)
    end

    topic_page.click_shared_edit_button(post)
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

    composer.leave_shared_edit
    try_until_success do
      expect(post.reload.raw).to eq("lorem ipsum\nfoo bar")
      expect(topic_page).to have_post_content(post_number: 1, content: "lorem ipsum\nfoo bar")
      expect(SharedEditRevision.count).to eq(3)
    end
  end

  it "streams backend updates into the composer" do
    topic_page.visit_topic(post.topic)
    topic_page.toggle_shared_edits_for(post)

    try_until_success do
      revision = SharedEditRevision.find_by(post_id: post.id, version: 1)
      expect(revision).to be_present
    end

    topic_page.click_shared_edit_button(post)

    try_until_success { expect(composer).to have_content("lorem ipsum") }

    latest = SharedEditRevision.where(post_id: post.id).order("version desc").first
    update = DiscourseSharedEdits::Yjs.update_from_state(latest.raw, "lorem ipsum\nremote edit")

    SharedEditRevision.revise!(
      post_id: post.id,
      user_id: remote_user.id,
      client_id: "remote-client",
      update: update,
    )

    try_until_success { expect(composer).to have_content("lorem ipsum\nremote edit") }
  end

  context "with rich editor mode" do
    before { SiteSetting.shared_edits_editor_mode = "rich" }

    it "allows editing with rich mode setting enabled" do
      topic_page.visit_topic(post.topic)
      topic_page.toggle_shared_edits_for(post)

      try_until_success do
        revision = SharedEditRevision.find_by(post_id: post.id, version: 1)
        expect(revision).to be_present
      end

      topic_page.click_shared_edit_button(post)

      # In rich mode, the composer should still open
      try_until_success { expect(composer).to be_opened }

      # Save and verify the post content is preserved
      composer.leave_shared_edit

      try_until_success { expect(post.reload.raw).to eq("lorem ipsum\n") }
    end

    it "commits typed content when clicking done and persists after reload" do
      topic_page.visit_topic(post.topic)
      topic_page.toggle_shared_edits_for(post)

      try_until_success do
        revision = SharedEditRevision.find_by(post_id: post.id, version: 1)
        expect(revision).to be_present
      end

      topic_page.click_shared_edit_button(post)
      try_until_success { expect(composer).to be_opened }

      # Type content in the editor
      composer.type_content " and some new rich content here"

      # Click done to commit - this should sync and save all content
      composer.leave_shared_edit

      # Verify it's persisted to the database
      try_until_success(timeout: 10) { expect(post.reload.raw).to include("rich content") }

      # Verify the post content is visible on screen
      try_until_success do
        expect(topic_page).to have_post_content(post_number: 1, content: "rich content here")
      end

      # Reload the page and verify content persists
      page.refresh

      try_until_success do
        expect(topic_page).to have_post_content(post_number: 1, content: "rich content here")
      end
    end

    it "commits changes so non-editors can see them" do
      topic_page.visit_topic(post.topic)
      topic_page.toggle_shared_edits_for(post)

      try_until_success do
        revision = SharedEditRevision.find_by(post_id: post.id, version: 1)
        expect(revision).to be_present
      end

      topic_page.click_shared_edit_button(post)
      try_until_success { expect(composer).to be_opened }

      # Make an edit (via backend simulation since rich mode typing is complex)
      latest = SharedEditRevision.where(post_id: post.id).order("version desc").first
      update =
        DiscourseSharedEdits::Yjs.update_from_state(latest.raw, "lorem ipsum\nrich edit content")

      SharedEditRevision.revise!(
        post_id: post.id,
        user_id: admin.id,
        client_id: "rich-client",
        update: update,
      )

      # Trigger commit via the done button
      composer.leave_shared_edit

      # Verify the post was updated
      try_until_success { expect(post.reload.raw).to eq("lorem ipsum\nrich edit content") }
    end
  end
end
