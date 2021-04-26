# frozen_string_literal: true

# name: discourse-shared-edits
# about: Edit posts collaboratively in Discourse
# version: 0.1.0
# authors: Sam Saffron
# url: https://github.com/discourse/discourse-shared-edits

enabled_site_setting :shared_edits_enabled

register_asset 'stylesheets/common/discourse-shared-edits.scss'

after_initialize do

  module ::DiscourseSharedEdits
    SHARED_EDITS_ENABLED = "shared_edits_enabled"

    class Engine < ::Rails::Engine
      engine_name "discourse_shared_edits"
      isolate_namespace ::DiscourseSharedEdits
    end
  end

  [
    "../lib/ot_text_unicode.rb",
    "../app/models/shared_edit_revision.rb",
    "../app/controllers/discourse_shared_edits/revision_controller.rb",
    "../app/jobs/commit_shared_revision.rb"
  ].each { |path| require File.expand_path(path, __FILE__) }

  ::DiscourseSharedEdits::Engine.routes.draw do
    put '/p/:post_id/enable' => 'revision#enable'
    put '/p/:post_id/disable' => 'revision#disable'
    put '/p/:post_id' => 'revision#revise'
    get '/p/:post_id' => 'revision#latest'
    put '/p/:post_id/commit' => 'revision#commit'
  end

  Discourse::Application.routes.append do
    mount ::DiscourseSharedEdits::Engine, at: "/shared_edits"
  end

  class ::Guardian
    def can_toggle_shared_edits?
      SiteSetting.shared_edits_enabled && is_staff?
    end
  end

  register_post_custom_field_type(DiscourseSharedEdits::SHARED_EDITS_ENABLED, :boolean)

  add_to_serializer(:post, :shared_edits_enabled) do
    SiteSetting.shared_edits_enabled &&
      object.custom_fields[DiscourseSharedEdits::SHARED_EDITS_ENABLED]
  end
end
