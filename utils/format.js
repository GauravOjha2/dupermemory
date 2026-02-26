// utils/format.js — Context block formatter
//
// Loaded into the service worker via importScripts("utils/format.js").
// Must not use ES module syntax (no import/export).
// Must not reference the DOM or any browser APIs.
//
// Input:  Summary object { topic, user_goal, important_facts, decisions_made, current_task }
// Output: Plain-text string injected into Claude's input field.
//
// Output format:
//
//   I am continuing a conversation from another AI. Here is the structured context:
//
//   {
//     "topic": "...",
//     "user_goal": "...",
//     "important_facts": [...],
//     "decisions_made": [...],
//     "current_task": "..."
//   }
//
//   Please help me continue with: <current_task>

function formatContextBlock(summary) {
  // Emit the summary as indented JSON so Claude can parse both the structure
  // and the human-readable content without ambiguity.
  const contextJson = JSON.stringify(
    {
      topic:           summary.topic           || "",
      user_goal:       summary.user_goal        || "",
      important_facts: summary.important_facts  || [],
      decisions_made:  summary.decisions_made   || [],
      current_task:    summary.current_task     || "",
    },
    null,
    2
  );

  // The closing question gives Claude a concrete starting point.
  // If current_task is empty (e.g. parse failure), fall back to a generic prompt.
  const question = summary.current_task
    ? "Please help me continue with: " + summary.current_task
    : "What are your thoughts on the above context?";

  return [
    "I am continuing a conversation from another AI. Here is the structured context:",
    "",
    contextJson,
    "",
    question,
  ].join("\n");
}
