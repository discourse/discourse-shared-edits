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
  describe ".state_from_text" do
    it "encodes text into a Yjs state and returns the same content" do
      result = described_class.state_from_text("😎hello world")

      expect(result[:text]).to eq("😎hello world")
      expect(result[:state]).to be_present
    end

    it "handles empty text" do
      result = described_class.state_from_text("")

      expect(result[:text]).to eq("")
      expect(result[:state]).to be_present
    end

    it "handles nil text" do
      result = described_class.state_from_text(nil)

      expect(result[:text]).to eq("")
      expect(result[:state]).to be_present
    end
  end

  describe ".apply_update" do
    it "applies an update to produce new content" do
      initial = described_class.state_from_text("I like bananas")
      update = described_class.update_from_state(initial[:state], "I eat apples")

      applied = described_class.apply_update(initial[:state], update)

      expect(applied[:text]).to eq("I eat apples")
      expect(applied[:state]).to be_present
    end
  end

  describe ".text_from_state" do
    it "extracts text from an encoded state" do
      original = "Hello World"
      state = described_class.state_from_text(original)[:state]

      expect(described_class.text_from_state(state)).to eq(original)
    end
  end

  describe ".update_from_text_change" do
    it "creates an update representing the diff between two texts" do
      old_text = "Hello World"
      new_text = "Hello Universe"

      update = described_class.update_from_text_change(old_text, new_text)
      expect(update).to be_present
    end

    it "handles insertion at the beginning" do
      old_text = "World"
      new_text = "Hello World"

      update = described_class.update_from_text_change(old_text, new_text)
      expect(update).to be_present
    end

    it "handles deletion" do
      old_text = "Hello World"
      new_text = "World"

      update = described_class.update_from_text_change(old_text, new_text)
      expect(update).to be_present
    end
  end

  describe ".update_from_state" do
    it "creates an update from existing state to new text" do
      initial = described_class.state_from_text("First version")
      update = described_class.update_from_state(initial[:state], "Second version")

      applied = described_class.apply_update(initial[:state], update)

      expect(applied[:text]).to eq("Second version")
    end
  end
end
