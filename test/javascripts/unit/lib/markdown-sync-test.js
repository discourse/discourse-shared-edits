import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import MarkdownSync from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/markdown-sync";
import { ensureYjsLoaded } from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/yjs-document";

module("Unit | Lib | shared-edits | markdown-sync", function(hooks) {
  setupTest(hooks);

  let container;
  let textarea;
  let sync;
  let doc;
  let text;

  hooks.beforeEach(async function() {
    const Y = await ensureYjsLoaded();
    container = document.createElement("div");
    container.id = "reply-control";
    textarea = document.createElement("textarea");
    textarea.className = "d-editor-input";
    textarea.value = "initial content";
    container.appendChild(textarea);
    document.body.appendChild(container);

    doc = new Y.Doc();
    text = doc.getText("post");
    text.insert(0, textarea.value);
    sync = new MarkdownSync(this);
    text.observe((event, transaction) => {
      sync.handleTextChange(event, transaction, text, doc);
    });
    sync.attach(doc, text, null);
  });

  hooks.afterEach(function() {
    sync.detach();
    doc.destroy();
    container.remove();
  });

  test("uses the current caret after local selection movement", function(assert) {
    textarea.setSelectionRange(10, 10);
    sync.setPendingRelativeSelection(sync.captureRelativeSelection(text));

    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    doc.transact(() => text.insert(0, "X"), { type: "remote" });

    assert.strictEqual(
      textarea.selectionStart,
      3,
      "the moved caret is transformed"
    );
  });

  test("preserves a backward selection through a remote edit", function(assert) {
    textarea.setSelectionRange(2, 5, "backward");

    doc.transact(() => text.insert(0, "X"), { type: "remote" });

    assert.deepEqual(
      [
        textarea.selectionStart,
        textarea.selectionEnd,
        textarea.selectionDirection,
      ],
      [3, 6, "backward"],
      "the active end of the selection is preserved"
    );
  });

  test("transforms a dragged selection through disjoint remote updates", async function(assert) {
    sync.onSelectionEnd = () => sync.syncTextareaAfterSelection(text);
    textarea.setSelectionRange(5, 7);
    textarea.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    doc.transact(() => text.insert(0, "X"), { type: "remote" });
    doc.transact(() => text.insert(text.length, "Y"), { type: "remote" });
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    assert.deepEqual(
      [textarea.selectionStart, textarea.selectionEnd],
      [6, 8],
      "only the prefix insertion shifts the selection"
    );
  });

  test("restores the caret against the pre-undo document", function(assert) {
    const Y = window.Y;
    const undoManager = new Y.UndoManager(text, {
      trackedOrigins: new Set([this.owner]),
    });
    sync.detach();
    sync.attach(doc, text, undoManager);

    doc.transact(() => text.insert(3, "X"), this.owner);
    textarea.value = text.toString();
    textarea.setSelectionRange(4, 4);
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "z",
      })
    );

    assert.strictEqual(textarea.value, "initial content", "the edit is undone");
    assert.strictEqual(
      textarea.selectionStart,
      3,
      "the caret returns to the edit position"
    );
    undoManager.destroy();
  });

  test("patches the DOM value against the Yjs target instead of only relying on the event delta (regression)", function (assert) {
    textarea.value = "xyz";

    const event = { delta: [{ retain: 3 }, { insert: "d" }] };
    const currentYText = { toString: () => "abcd" };

    sync.handleTextChange(event, { origin: {} }, currentYText, {}, (cb) =>
      cb()
    );

    assert.strictEqual(textarea.value, "abcd");
  });
});
