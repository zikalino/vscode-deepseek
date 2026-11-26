const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MAX_POSITIONAL_REASONING_ENTRIES,
  lookupReasoning,
  pruneReasoningCache,
  reasoningIndexKey,
  reasoningTextKey,
  reasoningToolCallKey,
} = require('../out/provider/reasoningCache.js');

function lookup(cache, overrides) {
  return lookupReasoning(cache, {
    toolCallIds: [],
    text: '',
    conversationId: 'conv-a',
    turnIndex: 0,
    hasTextKeys: false,
    ...overrides,
  });
}

test('pruning never evicts content-addressed reasoning', () => {
  const cache = new Map();
  for (let i = 0; i < MAX_POSITIONAL_REASONING_ENTRIES + 100; i++) {
    const entry = { text: `reasoning-${i}`, timestamp: i };
    cache.set(reasoningToolCallKey(`call_${i}`), entry);
    cache.set(reasoningIndexKey('conv-a', i), entry);
  }
  cache.set(reasoningTextKey('assistant text'), { text: 'text reasoning', timestamp: 0 });

  pruneReasoningCache(cache);

  // Every tool-call key and text-hash key survives, no matter how old it is.
  assert.equal(cache.get(reasoningToolCallKey('call_0'))?.text, 'reasoning-0');
  assert.equal(
    cache.get(reasoningToolCallKey(`call_${MAX_POSITIONAL_REASONING_ENTRIES + 99}`))?.text,
    `reasoning-${MAX_POSITIONAL_REASONING_ENTRIES + 99}`,
  );
  assert.equal(cache.get(reasoningTextKey('assistant text'))?.text, 'text reasoning');

  // Only the positional fallback is bounded.
  const positional = [...cache.keys()].filter((key) => key.startsWith('idx:'));
  assert.equal(positional.length, MAX_POSITIONAL_REASONING_ENTRIES);
});

test('the earliest turn keeps its reasoning after the cache is pruned', () => {
  // Regression: a long agent turn used to evict the oldest entries wholesale,
  // which re-serialized the first assistant message without reasoning_content
  // and dropped DeepSeek's prompt cache from that point on.
  const cache = new Map();
  const first = { text: 'turn 0 reasoning', timestamp: 1 };
  cache.set(reasoningToolCallKey('call_0'), first);
  cache.set(reasoningIndexKey('conv-a', 0), first);

  for (let i = 1; i < MAX_POSITIONAL_REASONING_ENTRIES + 100; i++) {
    const entry = { text: `reasoning-${i}`, timestamp: i + 1 };
    cache.set(reasoningToolCallKey(`call_${i}`), entry);
    cache.set(reasoningIndexKey('conv-a', i), entry);
  }

  pruneReasoningCache(cache);

  const found = lookup(cache, { toolCallIds: ['call_0'], turnIndex: 0 });
  assert.equal(found?.text, 'turn 0 reasoning');
});

test('positional reasoning never decides the serialized history', () => {
  // Regression: the positional fallback was pruned as the conversation grew, so
  // an old turn could flip from its real reasoning to the placeholder and
  // invalidate DeepSeek's cached prefix. Only content-addressed keys may decide
  // what is sent back.
  const cache = new Map();
  cache.set(reasoningIndexKey('conv-a', 0), { text: 'positional only', timestamp: 1 });

  assert.equal(lookup(cache, { conversationId: 'conv-a', turnIndex: 0 }), undefined);

  pruneReasoningCache(cache);
  assert.equal(lookup(cache, { conversationId: 'conv-a', turnIndex: 0 }), undefined);
});

test('a content-addressed turn wins over a colliding positional entry', () => {
  const cache = new Map();
  cache.set(reasoningIndexKey('conv-a', 0), { text: 'wrong', timestamp: 1 });
  cache.set(reasoningToolCallKey('call_0'), { text: 'right', timestamp: 2 });

  assert.equal(lookup(cache, { toolCallIds: ['call_0'] })?.text, 'right');
});
