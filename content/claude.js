// content/claude.js — Runs on https://claude.ai/*
//
// Full flow (triggered when background has a pending context for this tab):
//   1. Signal CLAUDE_READY → get context block from background
//   2. Wait for Claude's input field to appear in the DOM
//   3. Inject the context block into the input field
//   4. Wait 300ms for injection to settle
//   5. Snapshot <main> innerText (AFTER injection so injected text is in baseline)
//   6. Auto-submit
//   7. Wait for Claude's response to appear and stabilize
//   8. Extract the response from the snapshot diff (scoped to <main>, excludes sidebar)
//   9. Send CLAUDE_RESPONSE to background → background forwards critique to ChatGPT

// ─── Signal readiness ─────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: "CLAUDE_READY" }, (response) => {
  if (chrome.runtime.lastError) {
    // No extension activity was in progress. Normal for regular claude.ai visits.
    return;
  }
  if (!response || response.type !== "INJECT" || !response.contextBlock) {
    return; // Regular visit — nothing to do.
  }
  runInjectionFlow(response.contextBlock).catch((err) => {
    console.error("[DuperMemory] Injection flow failed:", err.message);
  });
});

// ─── Orchestration ────────────────────────────────────────────────────────────

async function runInjectionFlow(contextBlock) {
  // Wait for Claude's input to exist (SPA — might not be rendered yet).
  const inputEl = await waitForInput();

  injectText(inputEl, contextBlock);

  // Wait for the framework to process the injected text before snapshotting.
  // The snapshot must be taken AFTER injection so the injected text is already
  // part of the baseline — otherwise it appears as "new content" in the diff.
  await delay(300);

  // Scope the snapshot to <main> rather than document.body.
  // Claude's sidebar (past conversation titles) lives outside <main> and
  // would otherwise pollute the response diff with unrelated text.
  const scopeEl = document.querySelector("main") || document.body;
  const snapshot = scopeEl.innerText;

  const submitted = submitClaudeInput(inputEl);
  if (!submitted) {
    throw new Error("Could not submit to Claude — no send button found.");
  }

  const claudeResponse = await waitForClaudeResponse(scopeEl, snapshot);

  if (!claudeResponse) {
    console.warn("[DuperMemory] Claude response captured was empty. Not sending back.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "CLAUDE_RESPONSE", content: claudeResponse },
    () => {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] CLAUDE_RESPONSE send failed:", chrome.runtime.lastError.message);
      }
    }
  );
}

// ─── Wait for input field ─────────────────────────────────────────────────────

function waitForInput() {
  return new Promise((resolve, reject) => {
    const existing = findClaudeInput();
    if (existing) {
      resolve(existing);
      return;
    }

    let settled = false;

    const observer = new MutationObserver(() => {
      const el = findClaudeInput();
      if (!el) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timeoutId);
      resolve(el);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const timeoutId = setTimeout(() => {
      if (settled) return;
      observer.disconnect();
      const el = findClaudeInput();
      if (el) resolve(el);
      else reject(new Error("Claude input field not found after 15 seconds."));
    }, 15_000);
  });
}

// ─── Find Claude's input field ────────────────────────────────────────────────

function findClaudeInput() {
  // Claude uses a contenteditable div, not a <textarea>.
  // Selectors tried in priority order — most semantic first.
  // Class names are avoided: they are generated and change between deployments.

  // Priority 1: role="textbox" — definitive ARIA signal for a text input widget.
  const byRole = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (byRole) return byRole;

  // Priority 2: any contenteditable with an explicit aria-label.
  const byAriaLabel = document.querySelector('[contenteditable="true"][aria-label]');
  if (byAriaLabel) return byAriaLabel;

  // Priority 3: plain <textarea> fallback.
  const textarea = document.querySelector("textarea");
  if (textarea) return textarea;

  // Priority 4: wide contenteditable in the lower half of the viewport.
  for (const el of document.querySelectorAll('[contenteditable="true"]')) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 200 && rect.bottom > window.innerHeight * 0.4) return el;
  }

  return null;
}

// ─── Inject text ──────────────────────────────────────────────────────────────

function injectText(el, text) {
  el.focus();

  if (el.tagName === "TEXTAREA") {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    ).set;
    nativeSetter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // contenteditable: execCommand fires the native InputEvent that
  // React/ProseMirror/Lexical listens for, keeping framework state in sync.
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  const ok = document.execCommand("insertText", false, text);

  if (!ok) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    console.warn("[DuperMemory] execCommand('insertText') failed; used textContent fallback.");
  }
}

// ─── Submit Claude's input ────────────────────────────────────────────────────

function submitClaudeInput(inputEl) {
  // Priority 1: aria-label containing "Send" (case-insensitive variants).
  // We don't know Claude's exact aria-label yet — run the console command
  // from the testing guide to find it and add it here once confirmed.
  const byAriaLabel = document.querySelector(
    'button[aria-label*="Send"]:not([disabled]),' +
    'button[aria-label*="send"]:not([disabled])'
  );
  if (byAriaLabel) { byAriaLabel.click(); return true; }

  // Priority 2: walk up from the input to find its nearest containing button.
  // The send button is almost always a sibling or near-sibling of the input.
  // This works regardless of what aria-label or test-id Claude uses.
  if (inputEl) {
    const container = inputEl.closest("form") || inputEl.parentElement;
    if (container) {
      const btn = container.querySelector("button:not([disabled])");
      if (btn) { btn.click(); return true; }
    }
  }

  // Priority 3: Enter keydown with composed:true (helps cross shadow DOM).
  // Must ensure the input has focus first.
  if (inputEl) {
    inputEl.focus();
    inputEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13,
      bubbles: true, cancelable: true, composed: true,
    }));
    return true;
  }

  return false;
}

// ─── Wait for Claude's response ───────────────────────────────────────────────

// Two-phase poll on scopeEl.innerText length:
//   Phase 1 — wait for meaningful new content (> MIN_NEW_CHARS added).
//   Phase 2 — wait for the text to stop changing (streaming complete).
//
// scopeEl is <main> when available, document.body otherwise.
// Scoping to <main> excludes Claude's sidebar (past conversation titles)
// which also appear in body.innerText and would pollute the diff.

function waitForClaudeResponse(scopeEl, snapshot) {
  const POLL_MS       = 500;
  const STABLE_NEEDED = 4;       // 4 × 500ms = 2s of no change → done streaming
  const MIN_NEW_CHARS = 50;      // ignore tiny UI state changes, wait for real content
  const TIMEOUT_MS    = 90_000;

  return new Promise((resolve, reject) => {
    let phase       = 1;
    let lastLength  = scopeEl.innerText.length;
    let stableCount = 0;
    let elapsed     = 0;

    const tick = () => {
      if (elapsed >= TIMEOUT_MS) {
        reject(new Error("Timed out waiting for Claude's response."));
        return;
      }

      const currentText = scopeEl.innerText;

      if (phase === 1) {
        if (currentText.length > snapshot.length + MIN_NEW_CHARS) {
          phase = 2;
          lastLength = currentText.length;
        }
      } else {
        if (currentText.length === lastLength) {
          stableCount++;
          if (stableCount >= STABLE_NEEDED) {
            resolve(extractResponse(snapshot, currentText));
            return;
          }
        } else {
          stableCount = 0;
          lastLength  = currentText.length;
        }
      }

      elapsed += POLL_MS;
      setTimeout(tick, POLL_MS);
    };

    setTimeout(tick, POLL_MS);
  });
}

// ─── Extract response from snapshot diff ─────────────────────────────────────

function extractResponse(beforeText, afterText) {
  // The snapshot was taken before submission.
  // Claude's response is appended after the snapshot point in body.innerText.
  // Slicing by the original length gives us the delta.
  const raw = afterText.slice(beforeText.length).trim();

  // Filter out short lines: button labels ("Copy", "Share"), status indicators,
  // single-character tokens that appear in the DOM during streaming.
  // Claude's actual response paragraphs will be far longer than these.
  const meaningful = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 10);

  return meaningful.join("\n").trim();
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
