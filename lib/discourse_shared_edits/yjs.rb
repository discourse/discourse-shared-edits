# frozen_string_literal: true

require "base64"
require "digest"
require "mini_racer"
require "monitor"

module DiscourseSharedEdits
  module Yjs
    LOCK = Monitor.new

    class << self
      def context
        return @context if defined?(@context)
        LOCK.synchronize { @context ||= create_context }
      end

      def create_context
        ctx = MiniRacer::Context.new(max_memory: 256_000_000, timeout: 5_000)
        ctx.eval(<<~JS)
          const global = this;
          var module = { exports: {} };
          var exports = module.exports;

          if (typeof window === 'undefined') {
            global.window = global;
          }

          const pmGlobals = [
            'pmState', 'pmView', 'pmModel', 'pmTransform',
            'pmCommands', 'pmHistory', 'pmInputrules', 'pmKeymap'
          ];

          pmGlobals.forEach(pkg => {
            if (!global.window[pkg]) {
              global.window[pkg] = {};
            }
          });

          if (typeof global.window.pmState.PluginKey === 'undefined') {
            global.window.pmState.PluginKey = function(name) {
              this.key = name;
              this.getState = function() { return null; };
            };
          }

          if (!global.crypto) {
            let _secureRandomPool = [];
            let _secureRandomIndex = 0;

            global._refillSecureRandomPool = function(bytes) {
              _secureRandomPool = bytes;
              _secureRandomIndex = 0;
            };

            global.crypto = {
              getRandomValues(array) {
                if (!array || typeof array.length !== "number") {
                  throw new Error("Expected typed array");
                }
                for (let i = 0; i < array.length; i++) {
                  if (_secureRandomIndex < _secureRandomPool.length) {
                    array[i] = _secureRandomPool[_secureRandomIndex++];
                  } else {
                    array[i] = Math.floor(Math.random() * 256);
                  }
                }
                return array;
              },
            };
          }

          if (typeof setTimeout === 'undefined') {
            global.setTimeout = function(fn, delay) { return 0; };
            global.clearTimeout = function(id) {};
            global.setInterval = function(fn, delay) { return 0; };
            global.clearInterval = function(id) {};
          }
        JS

        public_dir = File.expand_path("../../public/javascripts", __dir__)
        yjs_path = Dir.glob(File.join(public_dir, "yjs-dist-*.js")).sort.last
        raise "yjs-dist bundle not found" unless yjs_path
        ctx.eval(File.read(yjs_path))

        ctx.eval(<<~JS)
          const YRef = (typeof SharedEditsYjs !== 'undefined' && SharedEditsYjs.Y) ? SharedEditsYjs.Y : global.Y;

          if (!YRef) {
            throw new Error("Yjs not found in bundled context");
          }

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

          function getStateVector(state) {
            const doc = createDocFromState(state);
            return Array.from(YRef.encodeStateVector(doc));
          }

          function compareStateVectors(clientSV, serverSV) {
            const clientMap = YRef.decodeStateVector(new Uint8Array(clientSV));
            const serverMap = YRef.decodeStateVector(new Uint8Array(serverSV));

            const missing = [];
            serverMap.forEach((clock, clientId) => {
              const clientClock = clientMap.get(clientId) || 0;
              if (clientClock < clock) {
                missing.push({ clientId, serverClock: clock, clientClock });
              }
            });

            return { valid: missing.length === 0, missing };
          }

          function getMissingUpdate(serverState, clientSV) {
            const doc = createDocFromState(serverState);
            return Array.from(YRef.encodeStateAsUpdate(doc, new Uint8Array(clientSV)));
          }
        JS
        ctx
      end

      def state_from_text(text)
        with_secure_random do
          result = context.call("stateFromText", text)
          { state: encode(result["state"]), text: result["text"] }
        end
      end

      def apply_update(state_b64, update_b64)
        with_secure_random do
          result = context.call("applyUpdateToState", decode(state_b64), decode(update_b64))
          { state: encode(result["state"]), text: result["text"] }
        end
      end

      def text_from_state(state_b64)
        LOCK.synchronize { context.call("applyUpdateToState", decode(state_b64), [])["text"] }
      end

      def update_from_text_change(old_text, new_text)
        with_secure_random do
          result = context.call("updateFromTextChange", old_text, new_text)
          { state: encode(result["state"]), update: encode(result["update"]) }
        end
      end

      def update_from_state(state_b64, new_text)
        with_secure_random { encode(context.call("updateFromState", decode(state_b64), new_text)) }
      end

      def get_state_vector(state_b64)
        LOCK.synchronize { context.call("getStateVector", decode(state_b64)) }
      end

      def compare_state_vectors(client_sv, server_sv)
        LOCK.synchronize do
          result = context.call("compareStateVectors", client_sv, server_sv)
          { valid: result["valid"], missing: result["missing"] }
        end
      end

      def get_missing_update(server_state_b64, client_sv)
        LOCK.synchronize do
          encode(context.call("getMissingUpdate", decode(server_state_b64), client_sv))
        end
      end

      def compute_state_hash(state_b64)
        return nil if state_b64.blank?
        decoded = Base64.strict_decode64(state_b64)
        Digest::SHA256.hexdigest(decoded)
      rescue ArgumentError
        nil
      end

      private

      def with_secure_random(&block)
        LOCK.synchronize do
          context.call("_refillSecureRandomPool", SecureRandom.random_bytes(256).bytes)
          block.call
        end
      end

      def encode(array)
        Base64.strict_encode64(array.pack("C*"))
      end

      def decode(str)
        Base64.strict_decode64(str.to_s).bytes
      end
    end
  end
end
