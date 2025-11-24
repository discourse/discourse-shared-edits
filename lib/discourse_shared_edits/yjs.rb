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

            function docFromText(text) {
              const doc = new YRef.Doc();
              doc.getText("post").insert(0, text || "");
              return doc;
            }

            function yDocFromState(state) {
              const doc = new YRef.Doc();
              if (state && state.length) {
                YRef.applyUpdate(doc, new Uint8Array(state));
              }
              return doc;
            }

            function encodeState(doc) {
              return Array.from(YRef.encodeStateAsUpdate(doc));
            }

            function docText(doc) {
              return doc.getText("post").toString();
            }

            function applyUpdateToState(state, update) {
              const doc = yDocFromState(state);
              if (update && update.length) {
                YRef.applyUpdate(doc, new Uint8Array(update));
              }

              return { state: encodeState(doc), text: docText(doc) };
            }

            function stateFromText(text) {
              const doc = docFromText(text);
              return { state: encodeState(doc), text: docText(doc) };
            }

            function updateFromTextChange(oldText, newText) {
              const doc = docFromText(oldText);
              const before = YRef.encodeStateVector(doc);
              const text = doc.getText("post");
              const oldVal = oldText || "";
              const newVal = newText || "";

              let start = 0;
              while (
                start < oldVal.length &&
                start < newVal.length &&
                oldVal[start] === newVal[start]
              ) {
                start++;
              }

              let endOld = oldVal.length - 1;
              let endNew = newVal.length - 1;

              while (
                endOld >= start &&
                endNew >= start &&
                oldVal[endOld] === newVal[endNew]
              ) {
                endOld--;
                endNew--;
              }

              const removeCount = Math.max(0, endOld - start + 1);
              const insertText =
                endNew >= start ? newVal.slice(start, endNew + 1) : "";

              if (removeCount > 0) {
                text.delete(start, removeCount);
              }

              if (insertText.length > 0) {
                text.insert(start, insertText);
              }

              return Array.from(YRef.encodeStateAsUpdate(doc, before));
            }

            function updateFromState(state, newText) {
              const doc = yDocFromState(state);
              const before = YRef.encodeStateVector(doc);
              const text = doc.getText("post");
              const current = text.toString();
              const desired = newText || "";

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
              const insertText =
                endDesired >= start ? desired.slice(start, endDesired + 1) : "";

              if (removeCount > 0) {
                text.delete(start, removeCount);
              }

              if (insertText.length > 0) {
                text.insert(start, insertText);
              }

              return Array.from(YRef.encodeStateAsUpdate(doc, before));
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
        encode(context.call("updateFromTextChange", old_text, new_text))
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
