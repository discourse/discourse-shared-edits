# frozen_string_literal: true

# Load plugin code
require_relative "../lib/discourse_shared_edits/yjs"
require_relative "../lib/discourse_shared_edits/state_validator"
require_relative "../app/models/shared_edit_revision"

post_id = ARGV[0]&.to_i || 2
post = Post.find(post_id)

puts "Current post content:"
puts post.raw.truncate(200)
puts

puts "Current revisions:"
DiscourseSharedEdits::SharedEditRevision.where(post_id: post_id).each do |r|
  text = DiscourseSharedEdits::Yjs.text_from_state(r.raw) rescue "ERROR"
  puts "v#{r.version}: #{text.truncate(100)}"
end
puts

puts "Clearing rate limit keys..."
%w[cooldown count].each do |type|
  key = "shared_edits_recovery_#{type}_#{post_id}"
  Discourse.redis.del(key)
  puts "Deleted #{key}"
end
puts

puts "Resetting post to clean state..."
new_content = "Sam was here\n\ntest test\n\nI am"
post.update!(raw: new_content)

DiscourseSharedEdits::SharedEditRevision.where(post_id: post_id).delete_all
initial_state = DiscourseSharedEdits::Yjs.state_from_text(post.raw)
DiscourseSharedEdits::SharedEditRevision.create!(
  post_id: post_id,
  client_id: "reset",
  user_id: Discourse.system_user.id,
  version: 1,
  revision: "",
  raw: initial_state[:state]
)

puts "Done! New state:"
puts DiscourseSharedEdits::Yjs.text_from_state(initial_state[:state])
