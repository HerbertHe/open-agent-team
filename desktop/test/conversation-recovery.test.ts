import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTaskReply } from '../src/renderer/src/conversation-recovery';

test('durable final response survives an empty observability replay', () => {
  assert.equal(resolveTaskReply({ finalResponse: { content: 'persisted answer' } }, undefined, ''), 'persisted answer');
});

test('live stream wins while generating and legacy user_response remains recoverable', () => {
  assert.equal(resolveTaskReply({ finalResponse: { content: 'older answer' } }, undefined, 'live answer'), 'live answer');
  assert.equal(resolveTaskReply({ lastProgress: { stage: 'user_response', message: 'legacy answer' } }, undefined, ''), 'legacy answer');
  assert.equal(resolveTaskReply({ lastProgress: { stage: 'done', message: 'workflow complete' } }, undefined, ''), '');
});
