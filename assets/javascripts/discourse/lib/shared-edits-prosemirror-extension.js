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

// Custom cursor builder that flips the label below the cursor when near the top
// of the editor to prevent cropping on the first line
function createCursorBuilder(editorContainer) {
  return (user) => {
    const cursor = document.createElement("span");
    cursor.classList.add("ProseMirror-yjs-cursor");
    cursor.style.borderColor = user.color;

    const label = document.createElement("div");
    label.textContent = user.name;
    label.style.backgroundColor = user.color;
    cursor.appendChild(label);

    // Check position after DOM insertion to detect first-line cursors
    requestAnimationFrame(() => {
      if (!cursor.isConnected) {
        return;
      }

      const cursorRect = cursor.getBoundingClientRect();
      const containerRect = editorContainer?.getBoundingClientRect();

      // If cursor is within ~20px of container top, flip label below
      if (containerRect && cursorRect.top - containerRect.top < 20) {
        label.classList.add("ProseMirror-yjs-cursor__label--below");
      }
    });

    return cursor;
  };
}

export function setSharedEditYjsState(state) {
  // Assign a unique ID to each state to prevent race conditions
  // when the editor is destroyed and recreated quickly
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
  // Follow hello.html:545-549 createPlugins pattern
  // IMPORTANT: Plugin order matters - ySyncPlugin MUST be first
  plugins(params) {
    capturePM(params);

    // Capture markdown serializer for proper image/link handling on commit
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
    // Capture the state ID at plugin creation time to detect stale callbacks
    const capturedStateId = _stateId;
    // Track configuration state on the sharedEditYjsState object to prevent
    // race conditions when the editor view is recreated before the promise resolves
    const currentState = sharedEditYjsState;

    // Capture plugin - survives reconfiguration and captures markdown on view destroy
    // This is needed because the view is destroyed before commit() can serialize it
    const capturePlugin = new Plugin({
      view(view) {
        return {
          destroy() {
            // Capture markdown BEFORE view is fully destroyed
            // so it's available for the sync during commit
            if (convertToMarkdown && view.state?.doc) {
              try {
                const markdown = convertToMarkdown(view.state.doc);
                setCapturedMarkdown(markdown);
              } catch {
                // Ignore serialization errors on destroy
              }
            }
          },
        };
      },
    });

    const loaderPlugin = new Plugin({
      view(view) {
        let destroyed = false;
        let configurationStarted = false;

        // Helper to check if this plugin instance is still valid
        const isStillValid = () => {
          if (destroyed) {
            return false;
          }

          // Check if global state changed (new subscription started)
          const activeState = getSharedEditYjsState();
          if (!activeState || activeState._stateId !== capturedStateId) {
            return false;
          }

          // Check if already configured
          if (currentState.configured) {
            return false;
          }

          // Check if view is still alive
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

        // Start loading asynchronously but guard against races
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

              // Final validity check before reconfiguration
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

              // Re-fetch current plugins as they might have changed
              // Keep capturePlugin so it can serialize on destroy
              const remainingPlugins = view.state.plugins.filter(
                (plugin) => plugin !== loaderPlugin
              );

              // Mark as configured BEFORE updating state to prevent re-entry
              currentState.configured = true;

              // Store view getter for markdown serialization on commit
              // This allows proper conversion of images, links, etc.
              setProsemirrorViewGetter(() => view);

              // Atomic update of the view state
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
