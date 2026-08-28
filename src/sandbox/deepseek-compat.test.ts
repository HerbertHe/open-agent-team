import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeepSeekReplaySignatures } from "./deepseek-compat";

test("normalizes Responses-style reasoning signatures for DeepSeek Chat Completions replay", () => {
  const message = {
    role: "assistant",
    content: [{
      type: "thinking",
      thinking: "full reasoning text",
      thinkingSignature: JSON.stringify({ id: "rs_example", type: "reasoning", encrypted_content: "" }),
    }],
  };
  const event = { type: "message_end", message };

  assert.equal(normalizeDeepSeekReplaySignatures(event, "openai-completions"), 1);
  assert.equal(message.content[0].thinkingSignature, "reasoning_content");
  assert.equal(message.content[0].thinking, "full reasoning text");
});

test("leaves native and unrelated signatures unchanged", () => {
  const native = { role: "assistant", content: [{ type: "thinking", thinking: "x", thinkingSignature: "reasoning_content" }] };
  const unrelated = { role: "assistant", content: [{ type: "thinking", thinking: "x", thinkingSignature: "opaque-signature" }] };

  assert.equal(normalizeDeepSeekReplaySignatures({ message: native }, "openai-completions"), 0);
  assert.equal(normalizeDeepSeekReplaySignatures({ message: unrelated }, "openai-completions"), 0);
  assert.equal(native.content[0].thinkingSignature, "reasoning_content");
  assert.equal(unrelated.content[0].thinkingSignature, "opaque-signature");
});

test("drops Chat Completions field names before Responses replay", () => {
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "x", thinkingSignature: "reasoning_content" }],
  };

  assert.equal(normalizeDeepSeekReplaySignatures({ message }, "openai-responses"), 1);
  assert.equal("thinkingSignature" in message.content[0], false);
});

test("keeps valid Responses reasoning items during Responses replay", () => {
  const signature = JSON.stringify({ id: "rs_example", type: "reasoning" });
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "x", thinkingSignature: signature }],
  };

  assert.equal(normalizeDeepSeekReplaySignatures({ message }, "openai-responses"), 0);
  assert.equal(message.content[0].thinkingSignature, signature);
});
