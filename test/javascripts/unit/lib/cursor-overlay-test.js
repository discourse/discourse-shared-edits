import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import CursorOverlay from "discourse/plugins/discourse-shared-edits/discourse/lib/cursor-overlay";

module("Unit | Lib | cursor-overlay", function (hooks) {
  setupTest(hooks);

  let textarea;
  let overlay;

  hooks.beforeEach(function () {
    // Create a mock textarea
    textarea = document.createElement("textarea");
    textarea.style.width = "400px";
    textarea.style.height = "200px";
    textarea.style.fontFamily = "monospace";
    textarea.style.fontSize = "14px";
    textarea.value = "Hello world\nSecond line\nThird line";

    // Create a parent container with relative positioning
    const container = document.createElement("div");
    container.style.position = "relative";
    container.appendChild(textarea);
    document.body.appendChild(container);

    overlay = new CursorOverlay(textarea);
  });

  hooks.afterEach(function () {
    if (overlay) {
      overlay.destroy();
    }
    if (textarea && textarea.parentElement) {
      textarea.parentElement.remove();
    }
  });

  test("creates cursor element with correct structure", function (assert) {
    const cursor = overlay.createCursorElement({
      user_id: 123,
      username: "testuser",
    });

    assert.true(Boolean(cursor.element), "Cursor element was created");
    assert.true(
      cursor.element.classList.contains("shared-edits-cursor"),
      "Element has correct class"
    );
    assert.true(Boolean(cursor.label), "Label was created");
    assert.true(
      cursor.label.classList.contains("shared-edits-cursor__label"),
      "Label has correct class"
    );
    assert.strictEqual(
      cursor.label.textContent,
      "testuser",
      "Label shows username"
    );
    assert.strictEqual(
      cursor.user.username,
      "testuser",
      "User data is stored"
    );
    assert.strictEqual(cursor.user.user_id, 123, "User ID is stored");
  });

  test("getColor returns CSS variable based on user id", function (assert) {
    // Test cycling through 7 colors
    assert.strictEqual(
      overlay.getColor(0),
      "var(--shared-edit-color-1)",
      "User ID 0 gets color 1"
    );
    assert.strictEqual(
      overlay.getColor(1),
      "var(--shared-edit-color-2)",
      "User ID 1 gets color 2"
    );
    assert.strictEqual(
      overlay.getColor(6),
      "var(--shared-edit-color-7)",
      "User ID 6 gets color 7"
    );
    assert.strictEqual(
      overlay.getColor(7),
      "var(--shared-edit-color-1)",
      "User ID 7 wraps to color 1"
    );
    assert.strictEqual(
      overlay.getColor(14),
      "var(--shared-edit-color-1)",
      "User ID 14 wraps to color 1"
    );

    // Test null/undefined handling
    assert.strictEqual(
      overlay.getColor(null),
      "var(--shared-edit-color-1)",
      "Null user ID defaults to color 1"
    );
    assert.strictEqual(
      overlay.getColor(undefined),
      "var(--shared-edit-color-1)",
      "Undefined user ID defaults to color 1"
    );
  });

  test("removeCursor cleans up DOM and Map entry", function (assert) {
    // Create a cursor manually
    const cursor = overlay.createCursorElement({
      user_id: 456,
      username: "toremove",
    });
    overlay.cursors.set("client-to-remove", cursor);
    overlay.container.appendChild(cursor.element);

    assert.true(
      overlay.cursors.has("client-to-remove"),
      "Cursor exists in Map before removal"
    );
    assert.true(
      overlay.container.contains(cursor.element),
      "Element is in DOM before removal"
    );

    overlay.removeCursor("client-to-remove");

    assert.false(
      overlay.cursors.has("client-to-remove"),
      "Cursor is removed from Map"
    );
    assert.false(
      overlay.container.contains(cursor.element),
      "Element is removed from DOM"
    );
  });

  test("destroy removes all cursors and event listeners", function (assert) {
    // Add some cursors
    const cursor1 = overlay.createCursorElement({
      user_id: 1,
      username: "user1",
    });
    const cursor2 = overlay.createCursorElement({
      user_id: 2,
      username: "user2",
    });
    overlay.cursors.set("client1", cursor1);
    overlay.cursors.set("client2", cursor2);
    overlay.container.appendChild(cursor1.element);
    overlay.container.appendChild(cursor2.element);

    // Track typists
    overlay.activeTypists.set("client1", { lastTyped: Date.now() });
    overlay.activeTypists.set("client2", { lastTyped: Date.now() });

    assert.strictEqual(overlay.cursors.size, 2, "Has 2 cursors before destroy");
    assert.strictEqual(
      overlay.activeTypists.size,
      2,
      "Has 2 typists before destroy"
    );

    const containerParent = overlay.container.parentElement;

    overlay.destroy();

    assert.strictEqual(overlay.cursors.size, 0, "Cursors Map is cleared");
    assert.strictEqual(
      overlay.activeTypists.size,
      0,
      "ActiveTypists Map is cleared"
    );
    assert.false(
      containerParent.contains(overlay.container),
      "Container is removed from DOM"
    );
  });

  test("removeCursor also clears activeTypists entry and timeout", function (assert) {
    const cursor = overlay.createCursorElement({
      user_id: 456,
      username: "toremove",
    });
    overlay.cursors.set("client-to-remove", cursor);
    overlay.container.appendChild(cursor.element);
    overlay.markTypist("client-to-remove");

    assert.true(
      overlay.activeTypists.has("client-to-remove"),
      "Typist entry exists before removal"
    );

    overlay.removeCursor("client-to-remove");

    assert.false(
      overlay.cursors.has("client-to-remove"),
      "Cursor is removed from Map"
    );
    assert.false(
      overlay.activeTypists.has("client-to-remove"),
      "Typist entry is removed from Map"
    );
  });

  test("destroy cancels pending typist timeouts", function (assert) {
    const cursor1 = overlay.createCursorElement({
      user_id: 1,
      username: "user1",
    });
    overlay.cursors.set("client1", cursor1);
    overlay.container.appendChild(cursor1.element);
    overlay.markTypist("client1");

    const typist = overlay.activeTypists.get("client1");
    assert.true(Boolean(typist.timeout), "Timeout exists before destroy");

    overlay.destroy();

    assert.strictEqual(overlay.activeTypists.size, 0, "ActiveTypists cleared");
    assert.strictEqual(overlay.cursors.size, 0, "Cursors cleared");
  });

  test("markTypist sets timeout for cursor hiding", async function (assert) {
    const cursor = overlay.createCursorElement({
      user_id: 789,
      username: "typist",
    });
    overlay.cursors.set("typist-client", cursor);
    overlay.container.appendChild(cursor.element);

    // Initially mark as typing
    overlay.markTypist("typist-client");

    const typist = overlay.activeTypists.get("typist-client");
    assert.true(Boolean(typist), "Typist entry was created");
    assert.true(Boolean(typist.lastTyped), "lastTyped timestamp is set");
    assert.true(Boolean(typist.timeout), "Timeout is set");

    // Verify timeout was set (we won't wait 5 seconds, just check it exists)
    assert.strictEqual(
      typeof typist.timeout,
      "number",
      "Timeout ID is a number"
    );

    // Clear the timeout to avoid test pollution
    clearTimeout(typist.timeout);
  });
});
