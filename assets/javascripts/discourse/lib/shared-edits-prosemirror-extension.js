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

          if (view.isDestroyed || !view.dom?.parentNode) {
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

              const syncPlugin = SharedEditsYjs.ySyncPlugin(xmlFragment);
              const cursorBuilder = createCursorBuilder(view.dom);
              const cursorPlugin = SharedEditsYjs.yCursorPlugin(awareness, {
                cursorBuilder,
              });
              const undoPlugin = SharedEditsYjs.yUndoPlugin();

              const remainingPlugins = view.state.plugins.filter(
                (plugin) => plugin !== loaderPlugin
              );

              currentState.configured = true;
              setProsemirrorViewGetter(() => view);

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
