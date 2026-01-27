# frozen_string_literal: true

require "rails_helper"

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

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
    end

    it "handles insertion at the beginning" do
      old_text = "World"
      new_text = "Hello World"

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
    end

    it "handles deletion" do
      old_text = "Hello World"
      new_text = "World"

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
    end

    it "handles insertion at the end" do
      old_text = "Hello"
      new_text = "Hello World"

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
    end

    it "handles complete replacement" do
      old_text = "foo"
      new_text = "bar"

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
    end

    it "handles emoji content" do
      old_text = "Hello 😎"
      new_text = "Hello 🎉 World"

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
    end

    it "handles empty to content" do
      old_text = ""
      new_text = "Hello World"

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
    end

    it "handles content to empty" do
      old_text = "Hello World"
      new_text = ""

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
    end

    it "handles multiline content" do
      old_text = "Line 1\nLine 2\nLine 3"
      new_text = "Line 1\nModified Line\nLine 3"

      result = described_class.update_from_text_change(old_text, new_text)
      applied = described_class.apply_update(result[:state], result[:update])

      expect(applied[:text]).to eq(new_text)
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

  describe ".get_state_vector" do
    it "returns a state vector for a given state" do
      state = described_class.state_from_text("Hello")[:state]
      sv = described_class.get_state_vector(state)

      expect(sv).to be_an(Array)
      expect(sv).not_to be_empty
    end

    it "returns different state vectors for different states" do
      state1 = described_class.state_from_text("Hello")[:state]
      state2 = described_class.state_from_text("World")[:state]

      sv1 = described_class.get_state_vector(state1)
      sv2 = described_class.get_state_vector(state2)

      expect(sv1).not_to eq(sv2)
    end
  end

  describe ".compare_state_vectors" do
    it "returns valid when client has seen all server operations" do
      state = described_class.state_from_text("Hello")[:state]
      sv = described_class.get_state_vector(state)

      result = described_class.compare_state_vectors(sv, sv)

      expect(result[:valid]).to eq(true)
      expect(result[:missing]).to be_empty
    end

    it "returns invalid when client is behind server" do
      state1 = described_class.state_from_text("Hello")[:state]
      update = described_class.update_from_state(state1, "Hello World")
      state2 = described_class.apply_update(state1, update)[:state]

      client_sv = described_class.get_state_vector(state1)
      server_sv = described_class.get_state_vector(state2)

      result = described_class.compare_state_vectors(client_sv, server_sv)

      expect(result[:valid]).to eq(false)
      expect(result[:missing]).not_to be_empty
    end

    it "returns valid when client is ahead of server" do
      state1 = described_class.state_from_text("Hello")[:state]
      update = described_class.update_from_state(state1, "Hello World")
      state2 = described_class.apply_update(state1, update)[:state]

      client_sv = described_class.get_state_vector(state2)
      server_sv = described_class.get_state_vector(state1)

      result = described_class.compare_state_vectors(client_sv, server_sv)

      expect(result[:valid]).to eq(true)
    end
  end

  describe ".get_missing_update" do
    it "returns an update containing operations the client is missing" do
      state1 = described_class.state_from_text("Hello")[:state]
      update = described_class.update_from_state(state1, "Hello World")
      state2 = described_class.apply_update(state1, update)[:state]

      client_sv =
        Base64.strict_decode64(
          Base64.strict_encode64(described_class.get_state_vector(state1).pack("C*")),
        ).bytes

      missing_update = described_class.get_missing_update(state2, client_sv)

      applied = described_class.apply_update(state1, missing_update)
      expect(applied[:text]).to eq("Hello World")
    end

    it "returns empty update when client is caught up" do
      state = described_class.state_from_text("Hello")[:state]
      sv = described_class.get_state_vector(state)

      missing_update = described_class.get_missing_update(state, sv)

      decoded = Base64.strict_decode64(missing_update)
      expect(decoded.bytesize).to be < 10
    end
  end
end
