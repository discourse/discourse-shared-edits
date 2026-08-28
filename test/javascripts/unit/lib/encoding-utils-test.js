import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import { applyDiff } from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/encoding-utils";

class FakeYText {
  constructor(value) {
    this._value = value;
  }

  toString() {
    return this._value;
  }

  delete(start, len) {
    this._value = this._value.slice(0, start) + this._value.slice(start + len);
  }

  insert(start, str) {
    this._value = this._value.slice(0, start) + str + this._value.slice(start);
  }
}

module("Discourse Shared Edits | Unit | encoding-utils", function (hooks) {
  setupTest(hooks);

  test("does nothing when the text is already the target value", function (assert) {
    const yText = new FakeYText("unchanged");

    applyDiff(yText, "unchanged");

    assert.strictEqual(yText.toString(), "unchanged");
  });

  test("handles insert at the beginning of text", function (assert) {
    const yText = new FakeYText("initial content");

    applyDiff(yText, "PREFIX initial content");

    assert.strictEqual(yText.toString(), "PREFIX initial content");
  });

  test("handles delete in the middle of text", function (assert) {
    const yText = new FakeYText("initial content");

    applyDiff(yText, "initient");

    assert.strictEqual(yText.toString(), "initient");
  });

  test("handles replacement (delete + insert) in the middle of text", function (assert) {
    const yText = new FakeYText("initial content");

    applyDiff(yText, "initial text");

    assert.strictEqual(yText.toString(), "initial text");
  });

  test("uses the current state of yText", function (assert) {
    const yText = new FakeYText("hello world");
    yText.insert(5, ", beautiful");

    assert.strictEqual(yText.toString(), "hello, beautiful world");

    applyDiff(yText, "hello world!");

    assert.strictEqual(yText.toString(), "hello world!");
  });
});
