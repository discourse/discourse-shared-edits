# frozen_string_literal: true

require "base64"
require "mini_racer"

module DiscourseSharedEdits
  module Yjs
    LOCK = Mutex.new

    class << self
      def context
        LOCK.synchronize do
          return @context if @context

          ctx = MiniRacer::Context.new
          ctx.eval(<<~JS)
            const global = this;
            var module = { exports: {} };
            var exports = module.exports;

            if (!global.crypto) {
              global.crypto = {
                getRandomValues(array) {
                  if (!array || typeof array.length !== "number") {
                    throw new Error("Expected typed array");
                  }
                  for (let i = 0; i < array.length; i++) {
                    array[i] = Math.floor(Math.random() * 256);
                  }
                  return array;
                },
              };
            }
          JS

          yjs_path = File.expand_path("../../public/javascripts/yjs-dist.js", __dir__)
          ctx.eval(File.read(yjs_path))

          ctx.eval(<<~JS)
            const YRef = global.Y;
            const TEXT_KEY = "post";

            function createDocWithText(text) {
              const doc = new YRef.Doc();
              doc.getText(TEXT_KEY).insert(0, text || "");
              return doc;
            }

            function createDocFromState(state) {
              const doc = new YRef.Doc();
              if (state && state.length) {
                YRef.applyUpdate(doc, new Uint8Array(state));
              }
              return doc;
            }

            function encodeDocState(doc) {
              return Array.from(YRef.encodeStateAsUpdate(doc));
            }

            function getDocText(doc) {
              return doc.getText(TEXT_KEY).toString();
            }

            function applyDiffToYText(yText, current, desired) {
              let start = 0;
              while (
                start < current.length &&
                start < desired.length &&
                current[start] === desired[start]
              ) {
                start++;
              }

              let endCurrent = current.length - 1;
              let endDesired = desired.length - 1;

              while (
                endCurrent >= start &&
                endDesired >= start &&
                current[endCurrent] === desired[endDesired]
              ) {
                endCurrent--;
                endDesired--;
              }

              const removeCount = Math.max(0, endCurrent - start + 1);
              if (removeCount > 0) {
                yText.delete(start, removeCount);
              }

              const insertText = endDesired >= start ? desired.slice(start, endDesired + 1) : "";
              if (insertText.length > 0) {
                yText.insert(start, insertText);
              }
            }

            function applyUpdateToState(state, update) {
              const doc = createDocFromState(state);
              if (update && update.length) {
                YRef.applyUpdate(doc, new Uint8Array(update));
              }
              return { state: encodeDocState(doc), text: getDocText(doc) };
            }

            function stateFromText(text) {
              const doc = createDocWithText(text);
              return { state: encodeDocState(doc), text: getDocText(doc) };
            }

            function updateFromTextChange(oldText, newText) {
              const doc = createDocWithText(oldText);
              const initialState = encodeDocState(doc);
              const stateVector = YRef.encodeStateVector(doc);
              applyDiffToYText(doc.getText(TEXT_KEY), oldText || "", newText || "");
              return { state: initialState, update: Array.from(YRef.encodeStateAsUpdate(doc, stateVector)) };
            }

            function updateFromState(state, newText) {
              const doc = createDocFromState(state);
              const stateVector = YRef.encodeStateVector(doc);
              const yText = doc.getText(TEXT_KEY);
              applyDiffToYText(yText, yText.toString(), newText || "");
              return Array.from(YRef.encodeStateAsUpdate(doc, stateVector));
            }
          JS

          @context = ctx
        end
      end

      def state_from_text(text)
        result = context.call("stateFromText", text)
        { state: encode(result["state"]), text: result["text"] }
      end

      def apply_update(state_b64, update_b64)
        result = context.call("applyUpdateToState", decode(state_b64), decode(update_b64))

        { state: encode(result["state"]), text: result["text"] }
      end

      def text_from_state(state_b64)
        context.call("applyUpdateToState", decode(state_b64), [])["text"]
      end

      def update_from_text_change(old_text, new_text)
        result = context.call("updateFromTextChange", old_text, new_text)
        { state: encode(result["state"]), update: encode(result["update"]) }
      end

      def update_from_state(state_b64, new_text)
        encode(context.call("updateFromState", decode(state_b64), new_text))
      end

      private

      def encode(array)
        Base64.strict_encode64(array.pack("C*"))
      end

      def decode(str)
        Base64.decode64(str.to_s).bytes
      end
    end
  end
end
