import {
  capturePM,
  clearPM,
  clearRichModeSerializers,
  ensureYjsProsemirrorLoaded,
  setCapturedMarkdown,
  setConvertToMarkdown,
  setProsemirrorViewGetter,
} from "../services/shared-edit-manager";

let sharedEditYjsState = null;
let stateIdCounter = 0;

function createCursorBuilder(editorContainer) {
  return (user) => {
    const cursor = document.createElement("span");
    cursor.classList.add("ProseMirror-yjs-cursor");
    cursor.style.borderColor = user.color;

    const label = document.createElement("div");
    label.textContent = user.name;
    label.style.backgroundColor = user.color;
    cursor.appendChild(label);

    requestAnimationFrame(() => {
      if (!cursor.isConnected) {
        return;
      }

      const cursorRect = cursor.getBoundingClientRect();
      const containerRect = editorContainer?.getBoundingClientRect();

      if (containerRect && cursorRect.top - containerRect.top < 20) {
        label.classList.add("ProseMirror-yjs-cursor__label--below");
      }
    });

    return cursor;
  };
}

export function setSharedEditYjsState(state) {
  stateIdCounter += 1;
  state._stateId = stateIdCounter;
  state.configured = false;
  sharedEditYjsState = state;
}

export function clearSharedEditYjsState() {
  sharedEditYjsState = null;
  clearPM();
  clearRichModeSerializers();
}

// Test support: reset module state between tests
// Note: We intentionally do NOT reset stateIdCounter. It must be ever-increasing
// to ensure isStillValid() checks work correctly when async operations from a
// previous test are still in flight when the next test starts.
export function resetProsemirrorExtensionState() {
  sharedEditYjsState = null;
}

export function getSharedEditYjsState() {
  return sharedEditYjsState;
}

const sharedEditsProsemirrorExtension = {
  // IMPORTANT: Plugin order matters - ySyncPlugin MUST be first
  plugins(params) {
    capturePM(params);

    const convertToMarkdown = params.utils?.convertToMarkdown;
    if (convertToMarkdown) {
      setConvertToMarkdown(convertToMarkdown);
    }

    if (!sharedEditYjsState) {
      return [];
    }

    const { Plugin } = params.pmState;
    const { xmlFragment, awareness, seedXmlFromView, _stateId, onError } =
      sharedEditYjsState;
    const capturedStateId = _stateId;
    const currentState = sharedEditYjsState;

    // Captures markdown on view destroy before commit() can serialize it
    const capturePlugin = new Plugin({
      view(view) {
        return {
          destroy() {
            if (convertToMarkdown && view.state?.doc) {
              try {
                const markdown = convertToMarkdown(view.state.doc);
                setCapturedMarkdown(markdown);
              } catch {}
            }
          },
        };
      },
    });

    const loaderPlugin = new Plugin({
      view(view) {
        let destroyed = false;
        let configurationStarted = false;

        const isStillValid = () => {
          if (destroyed) {
            return false;
          }

          const activeState = getSharedEditYjsState();
          if (!activeState || activeState._stateId !== capturedStateId) {
            return false;
          }

          if (currentState.configured) {
            return false;
          }

          // Check both parentNode and isConnected for robust detection of
          // detached views (e.g., rapid close after open)
          if (view.isDestroyed || !view.dom?.parentNode || !view.dom.isConnected) {
            return false;
          }

          return true;
        };

        const reportError = (error) => {
          if (!isStillValid()) {
            return;
          }

          onError?.(error);
        };

        if (!configurationStarted) {
          configurationStarted = true;

          ensureYjsProsemirrorLoaded()
            .then(() => {
              if (!isStillValid()) {
                return;
              }

              const SharedEditsYjs = window.SharedEditsYjs;

              if (!SharedEditsYjs?.ySyncPlugin) {
                reportError(
                  new Error("y-prosemirror plugins not available after load")
                );
                // eslint-disable-next-line no-console
                console.error(
                  "[SharedEdits] y-prosemirror plugins not available after load"
                );
                return;
              }

              if (!isStillValid()) {
                return;
              }

              if (
                seedXmlFromView &&
                xmlFragment.length === 0 &&
                SharedEditsYjs.prosemirrorToYXmlFragment
              ) {
                SharedEditsYjs.prosemirrorToYXmlFragment(
                  view.state.doc,
                  xmlFragment
                );
              }

              let syncPlugin, cursorPlugin, undoPlugin;
              try {
                syncPlugin = SharedEditsYjs.ySyncPlugin(xmlFragment);
                const cursorBuilder = createCursorBuilder(view.dom);
                cursorPlugin = SharedEditsYjs.yCursorPlugin(awareness, {
                  cursorBuilder,
                });
                undoPlugin = SharedEditsYjs.yUndoPlugin();
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error(
                  "[SharedEdits] Error creating y-prosemirror plugins:",
                  e
                );
                reportError(e);
                return;
              }

              const remainingPlugins = view.state.plugins.filter(
                (plugin) => plugin !== loaderPlugin
              );

              currentState.configured = true;
              setProsemirrorViewGetter(() => view);

              try {
                view.updateState(
                  view.state.reconfigure({
                    plugins: [
                      syncPlugin,
                      cursorPlugin,
                      undoPlugin,
                      ...remainingPlugins,
                    ],
                  })
                );
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error("[SharedEdits] Error updating view state:", e);
                reportError(e);
              }
            })
            .catch((error) => {
              reportError(error);
              // eslint-disable-next-line no-console
              console.error(
                "[SharedEdits] Failed to load y-prosemirror plugins:",
                error
              );
            });
        }

        return {
          destroy() {
            destroyed = true;
          },
        };
      },
    });

    return [capturePlugin, loaderPlugin];
  },
};

export default sharedEditsProsemirrorExtension;
