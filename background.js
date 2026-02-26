// background.js — Service Worker
//
// Message protocol:
//   chatgpt.js → background:   { type: "CAPTURE",        summary: {...} }
//   claude.js  → background:   { type: "CLAUDE_READY" }
//   background → claude.js:    { type: "INJECT",         contextBlock: "..." }  ← sendResponse
//   claude.js  → background:   { type: "CLAUDE_RESPONSE", content: "..." }
//   background → chatgpt.js:   { type: "INJECT_CRITIQUE", content: "..." }      ← tabs.sendMessage
//
// State lifecycle:
//
//   pendingContext[claudeTabId] = { contextBlock, sourceTabId }
//     Set:     when handleCapture opens the Claude tab
//     Cleared: when CLAUDE_READY is received (context delivered)
//
//   pendingReview[claudeTabId] = sourceTabId
//     Set:     when CLAUDE_READY is received (so we remember where to send the critique)
//     Cleared: when CLAUDE_RESPONSE is received (critique sent back to ChatGPT)

importScripts("utils/format.js");

const pendingContext = {}; // claudeTabId → { contextBlock, sourceTabId }
const pendingReview  = {}; // claudeTabId → sourceTabId

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab && sender.tab.id;

  if (message.type === "CAPTURE") {
    handleCapture(message.summary, senderTabId);
    return false;
  }

  if (message.type === "CLAUDE_READY") {
    if (senderTabId && pendingContext[senderTabId]) {
      const { contextBlock, sourceTabId } = pendingContext[senderTabId];
      delete pendingContext[senderTabId];

      // Remember which ChatGPT tab originated this so we can relay the review back.
      pendingReview[senderTabId] = sourceTabId;

      sendResponse({ type: "INJECT", contextBlock });
    } else {
      sendResponse(null); // regular claude.ai visit, no pending context
    }
    // sendResponse is synchronous — no need to return true.
    return false;
  }

  if (message.type === "CLAUDE_RESPONSE") {
    if (senderTabId && pendingReview[senderTabId]) {
      const sourceTabId = pendingReview[senderTabId];
      delete pendingReview[senderTabId];

      sendCritiqueToTab(sourceTabId, message.content);
    }
    return false;
  }
});

// ─── Capture + open Claude ────────────────────────────────────────────────────

function handleCapture(summary, sourceTabId) {
  if (!summary || typeof summary !== "object") {
    console.error("[DuperMemory] handleCapture: invalid summary", summary);
    return;
  }
  if (!sourceTabId) {
    console.error("[DuperMemory] handleCapture: could not identify source tab");
    return;
  }

  const contextBlock = formatContextBlock(summary);

  chrome.tabs.create({ url: "https://claude.ai" }, (tab) => {
    if (chrome.runtime.lastError) {
      console.error("[DuperMemory] Failed to open Claude tab:", chrome.runtime.lastError.message);
      return;
    }
    pendingContext[tab.id] = { contextBlock, sourceTabId };
  });
}

// ─── Relay Claude's response back to ChatGPT ──────────────────────────────────

function sendCritiqueToTab(tabId, claudeResponse) {
  const content =
    "Another AI reviewed your answer. Revise your response considering this critique:\n\n" +
    claudeResponse;

  chrome.tabs.sendMessage(tabId, { type: "INJECT_CRITIQUE", content }, () => {
    if (chrome.runtime.lastError) {
      // Tab was closed or navigated away between the click and Claude's response.
      console.warn(
        "[DuperMemory] Could not deliver critique to ChatGPT tab " + tabId + ": ",
        chrome.runtime.lastError.message
      );
    }
  });
}
