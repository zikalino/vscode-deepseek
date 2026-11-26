const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MISSING_REASONING_CONTENT,
} = require('../out/types.js');
const {
  compareWireMessages,
  countSerializedReasoning,
} = require('../out/provider/debug/diagnostics.js');

const system = { role: 'system', content: 'system' };

test('identical wire messages overlap completely', () => {
  const previous = [system, { role: 'user', content: 'hi' }];
  const current = [...previous, { role: 'assistant', content: 'hello' }];

  const comparison = compareWireMessages(previous, current);
  assert.equal(comparison.ratio, 1);
  assert.equal(comparison.divergedAt, undefined);
});

test('a changed reasoning_content is visible even when the text is identical', () => {
  const previous = [
    system,
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'answer', reasoning_content: 'real reasoning' },
  ];
  const current = [
    system,
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'answer', reasoning_content: MISSING_REASONING_CONTENT },
  ];

  const comparison = compareWireMessages(previous, current);
  assert.equal(comparison.ratio, 2 / 3);
  assert.equal(comparison.divergedAt?.index, 2);
  assert.equal(comparison.divergedAt?.reason, 'reasoning');
});

test('changed tool-call arguments are detected', () => {
  const call = (args) => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'view', arguments: args } }],
  });

  const comparison = compareWireMessages([system, call('{"path":"a"}')], [system, call('{"path":"b"}')]);
  assert.equal(comparison.divergedAt?.index, 1);
  assert.equal(comparison.divergedAt?.reason, 'toolCalls');
});

test('a tool result keep its identity in the comparison', () => {
  const previous = [system, { role: 'tool', content: 'out', tool_call_id: 'call_0' }];
  const current = [system, { role: 'tool', content: 'out', tool_call_id: 'call_1' }];

  const comparison = compareWireMessages(previous, current);
  assert.equal(comparison.divergedAt?.index, 1);
  assert.equal(comparison.divergedAt?.reason, 'toolCallId');
});

test('there is nothing to compare without a previous request', () => {
  assert.equal(compareWireMessages(undefined, [system]), undefined);
  assert.equal(compareWireMessages([], [system]), undefined);
});

test('reasoning sources are counted separately', () => {
  const counts = countSerializedReasoning([
    system,
    { role: 'assistant', content: 'a', reasoning_content: 'thinking' },
    { role: 'assistant', content: 'b', reasoning_content: MISSING_REASONING_CONTENT },
    { role: 'assistant', content: 'c' },
  ]);

  assert.deepEqual(counts, { injected: 1, marker: 1 });
  // With tools, a turn without reasoning is serialized with the marker too.
  assert.deepEqual(
    countSerializedReasoning(
      [
        system,
        { role: 'assistant', content: 'a', reasoning_content: 'thinking' },
        { role: 'assistant', content: 'c' },
      ],
      true,
    ),
    { injected: 1, marker: 1 },
  );
});
