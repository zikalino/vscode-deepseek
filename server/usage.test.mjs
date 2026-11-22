import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UsageMeter, usageTotal } from './usage.mjs';

test('usageTotal prefers total_tokens', () => {
  assert.equal(usageTotal({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), 15);
});

test('usageTotal falls back to the sum', () => {
  assert.equal(usageTotal({ prompt_tokens: 10, completion_tokens: 5 }), 15);
});

test('usageTotal ignores missing and malformed usage', () => {
  assert.equal(usageTotal(undefined), 0);
  assert.equal(usageTotal(null), 0);
  assert.equal(usageTotal({}), 0);
  assert.equal(usageTotal({ prompt_tokens: 'nope' }), 0);
});

test('UsageMeter reads the final usage frame and ignores [DONE]', () => {
  const meter = new UsageMeter();
  meter.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  meter.push('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n');
  meter.push('data: [DONE]\n\n');
  assert.equal(meter.flush(), 10);
});

test('UsageMeter survives arbitrary chunk boundaries and CRLF', () => {
  const meter = new UsageMeter();
  const stream = 'data: {"choices":[],"usage":{"total_tokens":42}}\r\n\r\n';
  for (const character of stream) {
    meter.push(character);
  }
  assert.equal(meter.flush(), 42);
});

test('UsageMeter charges a trailing frame without a newline', () => {
  const meter = new UsageMeter();
  meter.push('data: {"usage":{"total_tokens":7}}');
  assert.equal(meter.flush(), 7);
});

test('UsageMeter ignores malformed JSON and unrelated lines', () => {
  const meter = new UsageMeter();
  meter.push(': keep-alive\n');
  meter.push('data: not json\n');
  meter.push('data: {"usage":{"total_tokens":3}}\n');
  assert.equal(meter.flush(), 3);
});
