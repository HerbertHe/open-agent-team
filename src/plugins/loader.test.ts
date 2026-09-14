import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchema } from './loader.js';

test('validates OpenClaw channel account schemas including integer and enum fields', () => {
  const schema = {
    type: 'object', required: ['token', 'mode'], properties: {
      token: { type: 'string' }, mode: { type: 'string', enum: ['bot', 'webhook'] }, retries: { type: 'integer' },
    },
  };
  assert.equal(validateSchema(schema, { token: 'secret', mode: 'bot', retries: 2 }).valid, true);
  assert.equal(validateSchema(schema, { token: 'secret', mode: 'invalid', retries: 2.5 }).valid, false);
});

test('rejects missing required channel fields', () => {
  const result = validateSchema({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }, {});
  assert.equal(result.valid, false);
  assert.match(result.errors?.join('\n') ?? '', /token is required/);
});
