// content/chatgpt.js — Runs on https://chatgpt.com/*
//
// Two responsibilities:
//
// 1. "Ask another AI" button
//    Captures + summarizes the conversation, sends to background, which opens
//    Claude in a new tab and orchestrates the full review loop.
//
// 2. INJECT_CRITIQUE listener
//    After Claude responds, background sends the critique here.
//    We inject it into ChatGPT's input and auto-submit so ChatGPT revises.
//
// Note: injectPromptIntoInput(), submitInput(), and delay() are globals
// from utils/summarize.js, which is loaded before this file in the manifest.

const BUTTON_ID = "dupermemory-ask-btn";

// ─── Entry point ──────────────────────────────────────────────────────────────

injectButton();

// ─── Button ───────────────────────────────────────────────────────────────────

function injectButton() {
  // Guard against double-injection (e.g. on SPA soft-navigations that
  // re-run content scripts, or if the extension reloads mid-session).
  if (document.getElementById(BUTTON_ID)) return;

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.textContent = "Ask another AI";

  // Fixed position keeps the button visible regardless of scroll position
  // and means we do not need to find a specific DOM anchor point.
  // This is intentional: ChatGPT's page structure changes frequently.
  // A fixed-position element in document.body survives all of those changes.
  Object.assign(btn.style, {
    position:     "fixed",
    top:          "12px",
    right:        "12px",
    zIndex:       "2147483647",   // max z-index — stays on top of ChatGPT's own modals
    padding:      "7px 14px",
    background:   "#7c3aed",
    color:        "#fff",
    border:       "none",
    borderRadius: "8px",
    fontSize:     "13px",
    fontWeight:   "600",
    cursor:       "pointer",
    boxShadow:    "0 2px 8px rgba(0,0,0,0.3)",
    fontFamily:   "inherit",
    lineHeight:   "1.4",
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.background = "#6d28d9";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "#7c3aed";
  });

  btn.addEventListener("click", handleClick);
  document.body.appendChild(btn);
}

async function handleClick() {
  const messages = captureMessages();

  if (messages.length === 0) {
    alert(
      "DuperMemory: No messages found.\n\n" +
      "Make sure you are on a ChatGPT conversation page with at least one message."
    );
    return;
  }

  const btn = document.getElementById(BUTTON_ID);
  setBusy(btn, true);

  try {
    // summarizeConversation() injects a prompt into ChatGPT, waits for the
    // streaming response to finish, and returns the parsed summary object.
    // The prompt and response will be visible in the ChatGPT conversation.
    const summary = await summarizeConversation();

    // No callback — background.js does not call sendResponse for CAPTURE.
    // Passing a callback when no response comes causes a spurious
    // "message port closed" error in the console.
    chrome.runtime.sendMessage({ type: "CAPTURE", summary });

  } catch (err) {
    console.error("[DuperMemory]", err);

    if (err.message && err.message.includes("Extension context invalidated")) {
      // The extension was reloaded while this tab was still open.
      // The content script is now orphaned and cannot talk to the runtime.
      // The only fix is a tab refresh — inform the user clearly.
      alert(
        "DuperMemory: Extension was reloaded.\n\n" +
        "Please refresh this tab (F5) and try again."
      );
    } else {
      alert("DuperMemory: Summarization failed.\n\n" + err.message);
    }
  } finally {
    setBusy(btn, false);
  }
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled        = busy;
  btn.textContent     = busy ? "Summarizing…" : "Ask another AI";
  btn.style.background = busy ? "#4c1d95" : "#7c3aed";
  btn.style.cursor     = busy ? "wait"     : "pointer";
}

// ─── Critique receiver ────────────────────────────────────────────────────────

// Background pushes INJECT_CRITIQUE after Claude's response is captured.
// We inject the formatted critique into ChatGPT's input and submit it
// so ChatGPT revises its answer without the user needing to do anything.

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "INJECT_CRITIQUE") {
    injectCritique(message.content).catch((err) => {
      console.error("[DuperMemory] Critique injection failed:", err.message);
    });
  }
});

async function injectCritique(content) {
  // injectPromptIntoInput and submitInput are global from utils/summarize.js.
  const injected = injectPromptIntoInput(content);
  if (!injected) {
    throw new Error("Could not find ChatGPT input field for critique injection.");
  }
  await delay(300);
  submitInput();
}

// ─── Message capture ──────────────────────────────────────────────────────────

function captureMessages() {
  // SELECTOR: [data-message-author-role]
  //
  // Why this attribute:
  //   ChatGPT adds `data-message-author-role` to every message container.
  //   It is a *semantic* data attribute — it describes what the element
  //   represents, not how it looks. That makes it stable across visual redesigns.
  //
  //   Class names in ChatGPT are generated (Tailwind/CSS Modules) and change
  //   constantly. Attributes like data-* and aria-* are tied to behaviour and
  //   meaning, so teams are reluctant to rename them — they'd break other things.
  //
  // Known values: "user" | "assistant" | "tool" (tool = function call output)
  // We only want "user" and "assistant".
  const containers = document.querySelectorAll("[data-message-author-role]");

  const messages = [];

  for (const el of containers) {
    const role = el.dataset.messageAuthorRole;

    // Skip "tool" role (code interpreter output, function results, etc.)
    if (role !== "user" && role !== "assistant") continue;

    const content = extractContent(el);

    // Skip empty turns (can happen with image-only messages or blank submissions)
    if (!content) continue;

    messages.push({ role, content });
  }

  return messages;
}

// ─── Content extraction ───────────────────────────────────────────────────────

function extractContent(messageEl) {
  // PROBLEM: reading messageEl.innerText directly includes button labels.
  //
  //   Each message container holds both the prose content AND action controls:
  //   "Copy", "Edit", "Regenerate", thumb icons, etc.
  //   Those labels appear in innerText alongside the actual message text.
  //
  // SOLUTION: clone the element, strip interactive controls, read innerText.
  //
  //   We remove `button` and `[role="button"]` elements from the clone.
  //   This is structural — it does not rely on any class names or visual hints.
  //   Whatever text remains is the message content.
  //
  //   We also remove `[data-testid]` elements that are known to be metadata
  //   overlays (e.g. copy-code overlays inside code blocks). If that attribute
  //   disappears from ChatGPT's DOM in the future, the line is harmless.

  const clone = messageEl.cloneNode(true);

  // Strip controls
  clone.querySelectorAll('button, [role="button"]').forEach((el) => el.remove());

  // Strip any visually-hidden accessibility hints that duplicate visible text
  // (e.g. sr-only spans). These have no visual representation but show up in
  // innerText and would corrupt the extracted content.
  clone.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());

  return clone.innerText.trim();
}
