import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import sinon from "sinon";
import sharedEditsProsemirrorExtension, {
  clearSharedEditYjsState,
  getSharedEditYjsState,
  setSharedEditYjsState,
} from "discourse/plugins/discourse-shared-edits/discourse/lib/shared-edits-prosemirror-extension";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class Plugin {
  constructor(specification) {
    this.specification = specification;
  }
}

module("Unit | Lib | shared-edits | prosemirror-extension", function (hooks) {
  setupTest(hooks);

  let originalSharedEditsYjs;
  let editor;

  hooks.beforeEach(function () {
    originalSharedEditsYjs = window.SharedEditsYjs;
    window.SharedEditsYjs = {
      yCursorPlugin: () => ({ name: "cursor" }),
      ySyncPlugin: () => ({ name: "sync" }),
      yUndoPlugin: () => ({ name: "undo" }),
    };

    const dom = document.createElement("div");
    dom.contentEditable = "true";
    document.body.appendChild(dom);
    editor = {
      dom,
      isDestroyed: false,
      state: {
        doc: {},
        plugins: [],
        reconfigure({ plugins }) {
          return { ...this, plugins };
        },
      },
      updateState(newState) {
        this.state = newState;
      },
    };
  });

  hooks.afterEach(function () {
    clearSharedEditYjsState();
    editor.dom.remove();
    window.SharedEditsYjs = originalSharedEditsYjs;
    sinon.restore();
  });

  function startConfiguration(loadProsemirror, onError = sinon.stub()) {
    setSharedEditYjsState({
      awareness: {},
      loadProsemirror,
      onError,
      seedXmlFromView: false,
      xmlFragment: { length: 1 },
    });
    const plugins = sharedEditsProsemirrorExtension.plugins({
      pmState: { Plugin },
    });
    editor.state.plugins = plugins;
    const loaderView = plugins[1].specification.view(editor);
    return { loaderView, onError };
  }

  test("keeps the editor read-only until collaboration is bound", async function (assert) {
    const loading = deferred();

    startConfiguration(() => loading.promise);

    assert.strictEqual(
      editor.dom.contentEditable,
      "false",
      "input is disabled while the binding loads"
    );

    loading.resolve();
    await loading.promise;
    await Promise.resolve();

    assert.true(
      getSharedEditYjsState().configured,
      "the binding is configured"
    );
    assert.strictEqual(
      editor.dom.contentEditable,
      "true",
      "input is restored after binding"
    );
  });

  test("restores editing when a pending binding is superseded", async function (assert) {
    const loading = deferred();
    startConfiguration(() => loading.promise);
    setSharedEditYjsState({
      awareness: {},
      loadProsemirror: () => Promise.resolve(),
      seedXmlFromView: false,
      xmlFragment: { length: 1 },
    });

    loading.resolve();
    await loading.promise;
    await Promise.resolve();

    assert.strictEqual(
      editor.dom.contentEditable,
      "true",
      "the abandoned loader releases the editor"
    );
  });

  test("reports configuration failures and restores editing", async function (assert) {
    const onError = sinon.stub();
    editor.updateState = () => {
      throw new Error("configuration failed");
    };

    startConfiguration(() => Promise.resolve(), onError);
    await Promise.resolve();
    await Promise.resolve();

    assert.true(onError.calledOnce, "the manager receives the failure");
    assert.false(
      getSharedEditYjsState().configured,
      "a failed binding is not marked configured"
    );
    assert.strictEqual(
      editor.dom.contentEditable,
      "true",
      "editing is restored for failure handling"
    );
  });
});
