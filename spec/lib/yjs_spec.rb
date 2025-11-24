# frozen_string_literal: true

require "rails_helper"
require_dependency Rails.root.join(
                     "plugins",
                     "discourse-shared-edits",
                     "lib",
                     "discourse_shared_edits",
                     "yjs",
                   )

RSpec.describe DiscourseSharedEdits::Yjs do
  it "encodes text into a Yjs state and returns the same content" do
    result = described_class.state_from_text("😎hello world")

    expect(result[:text]).to eq("😎hello world")
    expect(result[:state]).to be_present
  end

  it "applies an update to produce new content" do
    initial = described_class.state_from_text("I like bananas")
    update = described_class.update_from_state(initial[:state], "I eat apples")

    applied = described_class.apply_update(initial[:state], update)

    expect(applied[:text]).to eq("I eat apples")
    expect(applied[:state]).to be_present
  end
end
