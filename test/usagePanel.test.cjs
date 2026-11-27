const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const wasmPath = path.join(__dirname, '..', 'media', 'advance_usage.wasm');

test(
  'the wasm usage panel draws a priced sample',
  { skip: !fs.existsSync(wasmPath) && 'advance_usage.wasm is not built' },
  () => {
    const { Guest } = require('../out/advance/guest.js');
    const guest = Guest.load(fs.readFileSync(wasmPath), {
      hostCall: () => '',
      netBegin: () => 0,
      netPoll: () => '',
      netClose: () => undefined,
    });

    guest.input({
      op: 'usageReset',
      samples: [
        {
          at: Date.UTC(2026, 0, 5, 12),
          model: 'deepseek-v4-flash',
          cacheHit: 96_000,
          cacheMiss: 52_000,
          output: 9_100,
          total: 157_100,
          cost: 0.0312,
          costHit: 0.000288,
          costMiss: 0.0078,
          costOut: 0.00546,
        },
      ],
    });

    const scene = guest.frame(900, 600);
    assert.ok(scene !== null, 'the panel produced a frame');
    assert.match(scene, /Token usage/, 'the module drew its title');
    assert.match(scene, /\$0\.0312/, 'the module drew the priced total');
  },
);
