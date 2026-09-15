import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSubmitOnDoubleNewline, type ComposerEnterState } from '../src/renderer/src/chat-composer';

const enter = (overrides: Partial<ComposerEnterState> = {}): ComposerEnterState => ({
  key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
  repeat: false, isComposing: false, ...overrides,
});

test('submits a non-empty Admin draft on the second consecutive newline', () => {
  assert.equal(shouldSubmitOnDoubleNewline('Implement history lookup\n', 25, 25, enter()), true);
});

test('keeps the first newline and modified Enter combinations editable', () => {
  assert.equal(shouldSubmitOnDoubleNewline('Implement history lookup', 24, 24, enter()), false);
  assert.equal(shouldSubmitOnDoubleNewline('Implement history lookup\n', 25, 25, enter({ shiftKey: true })), false);
});

test('does not submit during IME composition, key repeat, or edits inside the draft', () => {
  const value = 'Implement\nmore context';
  assert.equal(shouldSubmitOnDoubleNewline('实现任务\n', 5, 5, enter({ isComposing: true })), false);
  assert.equal(shouldSubmitOnDoubleNewline('实现任务\n', 5, 5, enter({ repeat: true })), false);
  assert.equal(shouldSubmitOnDoubleNewline(value, 10, 10, enter()), false);
});
