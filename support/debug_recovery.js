// Debug script to trace the content flow during recovery
const { chromium } = require("playwright");
const { execSync } = require("child_process");

const BASE_URL = "http://shared-edits2.home.arpa";
const POST_URL = `${BASE_URL}/t/welcome-to-discourse/5/2`;
const TEST_TEXT_BEFORE = "BEFORE_CORRUPT ";
const TEST_TEXT_AFTER = "AFTER_CORRUPT_SUCCESS";

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Collect console logs
  const consoleLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    consoleLogs.push(`[${msg.type()}] ${text}`);
    // Log SharedEdits and errors immediately
    if (text.includes("[SharedEdits]") || msg.type() === "error") {
      console.log(`BROWSER: ${text}`);
    }
  });

  try {
    // Login as admin
    console.log("Logging in...");
    await page.goto(`${BASE_URL}/session/admin/become`);
    await page.waitForTimeout(2000);

    // Navigate to post
    console.log("Navigating to post...");
    await page.goto(POST_URL);
    await page.waitForSelector("article#post_2", { timeout: 10000 });
    await page.waitForTimeout(500);
    // Debug: see what buttons are available
    const buttons = await page.$$eval("#post_2 button", (btns) =>
      btns.map((b) => ({ class: b.className, title: b.title, text: b.innerText }))
    );
    console.log("Available buttons on post_2:", JSON.stringify(buttons));

    // Click edit - try various selectors
    console.log("Opening editor...");
    let editClicked = false;
    for (const selector of [
      "#post_2 button.widget-button[title='edit this post']",
      "#post_2 button.edit",
      "#post_2 .actions button:has-text('Edit')",
      "article#post_2 button.btn-flat.edit",
      ".shared-edit-button button",
    ]) {
      if (await page.isVisible(selector)) {
        console.log(`Found edit button with selector: ${selector}`);
        await page.click(selector, { timeout: 5000 });
        editClicked = true;
        break;
      }
    }
    if (!editClicked) {
      throw new Error("Could not find edit button");
    }
    await page.waitForSelector(".d-editor-preview, .ProseMirror", {
      timeout: 10000,
    });
    await page.waitForTimeout(1000);

    // Get editor element
    const isRichMode = await page.isVisible(".ProseMirror");
    console.log(`Editor mode: ${isRichMode ? "rich" : "markdown"}`);

    const editorSelector = isRichMode
      ? ".ProseMirror"
      : "textarea.d-editor-input";

    // Focus and type before-corruption text
    console.log("Typing before-corruption text...");
    await page.click(editorSelector);
    await page.keyboard.press("End");
    await page.keyboard.type(TEST_TEXT_BEFORE);
    await page.waitForTimeout(1000);

    // Get content before corruption
    const contentBefore = isRichMode
      ? await page.$eval(".ProseMirror", (el) => el.innerText.trim())
      : await page.$eval("textarea.d-editor-input", (el) => el.value);
    console.log("Content before corruption:", contentBefore.substring(0, 100));

    // Run state corruptor
    console.log("Running state corruptor...");
    try {
      execSync("support/state_corruptor 5/2", {
        cwd: "/var/www/discourse/plugins/discourse-shared-edits",
        timeout: 10000,
      });
      console.log("State corruptor completed");
    } catch (e) {
      console.error("State corruptor error:", e.message);
    }

    // Wait a moment for the corruption to be detected
    await page.waitForTimeout(2000);

    // Type after-corruption text
    console.log("Typing after-corruption text...");
    await page.click(editorSelector);
    await page.keyboard.press("End");
    await page.keyboard.type(TEST_TEXT_AFTER);
    await page.waitForTimeout(2000);

    // Get content in editor
    const contentAfterTyping = isRichMode
      ? await page.$eval(".ProseMirror", (el) => el.innerText.trim())
      : await page.$eval("textarea.d-editor-input", (el) => el.value);
    console.log(
      "Content after typing (in editor):",
      contentAfterTyping.substring(0, 200)
    );

    // Wait for any pending syncs
    await page.waitForTimeout(1000);

    // Click Done - try various selectors
    console.log("Clicking Done...");
    let doneClicked = false;

    // Take screenshot to see state before clicking Done
    await page.screenshot({ path: "/tmp/before-done-check.png" });
    console.log("Screenshot saved to /tmp/before-done-check.png");

    // First check if composer is even visible - try multiple selectors
    const composerVisible = await page.isVisible(".composer-fields");
    const replyControlVisible = await page.isVisible("#reply-control");
    const prosemirrorVisible = await page.isVisible(".ProseMirror");
    console.log("Composer visible (.composer-fields):", composerVisible);
    console.log("Reply control visible (#reply-control):", replyControlVisible);
    console.log("ProseMirror visible (.ProseMirror):", prosemirrorVisible);

    if (composerVisible || replyControlVisible || prosemirrorVisible) {
      // Take screenshot for debugging
      await page.screenshot({ path: "/tmp/before-done-click.png" });

      for (const selector of [
        "#reply-control button.btn-primary:has-text('Done')",
        ".save-or-cancel button.create",
        "button.create:has-text('Done')",
        ".composer-controls button.btn-primary",
        "button[title*='Done']",
      ]) {
        if (await page.isVisible(selector)) {
          console.log(`Found Done button with selector: ${selector}`);
          await page.click(selector, { timeout: 5000 });
          doneClicked = true;
          break;
        }
      }

      if (!doneClicked) {
        console.log("Could not find Done button, pressing Ctrl+Enter instead");
        await page.keyboard.press("Control+Enter");
      }

      // Wait for save to complete
      await page.waitForTimeout(3000);
    } else {
      console.log("Composer not visible - may have auto-closed after resync");
      await page.waitForTimeout(2000);
    }

    // Try to wait for composer to close (may already be closed)
    try {
      await page.waitForSelector(".composer-fields", {
        state: "detached",
        timeout: 5000,
      });
    } catch {
      console.log("Composer close wait timed out (may already be closed)");
    }

    // Reload page to see saved content
    console.log("Reloading page to verify saved content...");
    await page.reload();
    await page.waitForSelector("article#post_2", { timeout: 10000 });

    // Get saved content
    const savedContent = await page.$eval(
      "#post_2 .cooked",
      (el) => el.innerText
    );
    console.log("\n=== RESULTS ===");
    console.log("Content typed before corruption:", TEST_TEXT_BEFORE.trim());
    console.log("Content typed after corruption:", TEST_TEXT_AFTER);
    console.log("Saved content:", savedContent.substring(0, 300));
    console.log(
      "\nDoes saved contain BEFORE_CORRUPT?",
      savedContent.includes("BEFORE_CORRUPT")
    );
    console.log(
      "Does saved contain AFTER_CORRUPT_SUCCESS?",
      savedContent.includes("AFTER_CORRUPT_SUCCESS")
    );

    console.log("\n=== RELEVANT CONSOLE LOGS ===");
    consoleLogs
      .filter((log) => log.includes("[SharedEdits]") || log.includes("[error]") || log.includes("composer") || log.includes("Composer"))
      .forEach((log) => console.log(log));
  } catch (e) {
    console.error("Error:", e);
    consoleLogs.forEach((log) => console.log(log));
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
