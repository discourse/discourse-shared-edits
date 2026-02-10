import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import sinon from "sinon";
import RichModeSync from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/rich-mode-sync";
import * as YjsDocument from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits/yjs-document";

module("Discourse Shared Edits | Unit | rich-mode-sync", function (hooks) {
  setupTest(hooks);

  hooks.afterEach(function () {
    sinon.restore();
  });

  test("skips syncing when serializer unexpectedly returns blank content", function (assert) {
    const anomalyStub = sinon.stub();
    const sync = new RichModeSync(this.owner, { onSyncAnomaly: anomalyStub });

    const xmlFragment = {
      length: 1,
      forEach(callback) {
        callback("still here");
      },
    };

    const text = {
      toString() {
        return "Existing collaborative content";
      },
    };

    const doc = {
      transact: sinon.spy(),
    };

    sinon.stub(YjsDocument, "getMarkdownFromView").returns("");
    const consoleStub = sinon.stub(console, "error");

    const result = sync.syncYTextFromXmlFragment(xmlFragment, text, doc);

    assert.false(result, "sync reports no changes applied");
    assert.true(consoleStub.calledOnce, "logs a warning");
    assert.true(doc.transact.notCalled, "does not mutate the Yjs document");
    assert.true(
      anomalyStub.calledOnceWith(
        sinon.match.has("reason", "empty_serialization")
      ),
      "invokes anomaly callback with context"
    );
  });

  test("allows intentional blanking when fragment contains no text", function (assert) {
    const anomalyStub = sinon.stub();
    const sync = new RichModeSync(this.owner, { onSyncAnomaly: anomalyStub });

    const xmlFragment = {
      length: 1,
      forEach(callback) {
        callback("");
      },
    };

    const yText = {
      _value: "Old value",
      toString() {
        return this._value;
      },
      delete(start, len) {
        this._value =
          this._value.slice(0, start) + this._value.slice(start + len);
      },
      insert(start, str) {
        this._value =
          this._value.slice(0, start) + str + this._value.slice(start);
      },
    };

    const doc = {
      transact: sinon.spy((cb) => cb()),
    };

    sinon.stub(YjsDocument, "getMarkdownFromView").returns("");

    const result = sync.syncYTextFromXmlFragment(xmlFragment, yText, doc);

    assert.true(result, "sync applied");
    assert.true(doc.transact.calledOnce, "document updated");
    assert.true(anomalyStub.notCalled, "no anomaly reported");
    assert.strictEqual(yText.toString(), "", "text cleared");
  });
});
