const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  DEFAULT_PEAK_MULTIPLIER,
  costOf,
  costPartsOf,
  defaultRules,
  hasRates,
  isPeak,
  withModelOverrides,
} = require('../out/pricing.js');

// 2026-01-05 is a Monday; 2026-01-03 is the Saturday before it.
const MONDAY = (hour, minute = 0) => Date.UTC(2026, 0, 5, hour, minute);
const SATURDAY = (hour) => Date.UTC(2026, 0, 3, hour);

const ONE_MILLION_MISS = { cacheHit: 0, cacheMiss: 1_000_000, output: 0 };

function rules(overrides) {
  return { ...defaultRules(), ...overrides };
}

function approx(actual, expected) {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < 1e-12,
    `expected ${expected}, got ${actual}`,
  );
}

test('peak is the two weekday UTC windows, end exclusive', () => {
  assert.equal(new Date(MONDAY(2)).getUTCDay(), 1);

  assert.equal(isPeak(MONDAY(0), rules()), false);
  assert.equal(isPeak(MONDAY(1), rules()), true);
  assert.equal(isPeak(MONDAY(3, 59), rules()), true);
  assert.equal(isPeak(MONDAY(4), rules()), false);
  assert.equal(isPeak(MONDAY(6), rules()), true);
  assert.equal(isPeak(MONDAY(9, 59), rules()), true);
  assert.equal(isPeak(MONDAY(10), rules()), false);
  assert.equal(isPeak(MONDAY(23), rules()), false);
});

test('weekends and listed holidays are off-peak all day', () => {
  assert.equal(new Date(SATURDAY(2)).getUTCDay(), 6);
  assert.equal(isPeak(SATURDAY(2), rules()), false);

  const holiday = rules({ holidays: ['2026-01-05'] });
  assert.equal(isPeak(MONDAY(2), holiday), false);
});

test('peak bills the multiplier on top of the off-peak price', () => {
  assert.equal(DEFAULT_PEAK_MULTIPLIER, 2);

  approx(costOf('deepseek-v4-flash', MONDAY(12), ONE_MILLION_MISS, rules()), 0.15);
  approx(costOf('deepseek-v4-flash', MONDAY(2), ONE_MILLION_MISS, rules()), 0.3);
});

test('each model is priced from its own row', () => {
  const r = rules();
  approx(costOf('deepseek-v4-flash', MONDAY(12), { cacheHit: 1_000_000, cacheMiss: 0, output: 0 }, r), 0.003);
  approx(costOf('deepseek-v4-flash', MONDAY(12), { cacheHit: 0, cacheMiss: 1_000_000, output: 0 }, r), 0.15);
  approx(costOf('deepseek-v4-flash', MONDAY(12), { cacheHit: 0, cacheMiss: 0, output: 1_000_000 }, r), 0.6);
  approx(costOf('deepseek-v4-pro', MONDAY(12), { cacheHit: 0, cacheMiss: 1_000_000, output: 0 }, r), 0.66);
  approx(costOf('deepseek-v4-pro', MONDAY(12), { cacheHit: 0, cacheMiss: 0, output: 1_000_000 }, r), 1.98);
});

test('an unpriced model falls back to the base model', () => {
  const r = rules({ baseModel: 'deepseek-v4-pro' });
  approx(costOf('some-unpriced-model', MONDAY(12), ONE_MILLION_MISS, r), 0.66);
});

test('the public model ids are aliases of the v4 tiers', () => {
  approx(costOf('deepseek-chat', MONDAY(12), ONE_MILLION_MISS, rules()), 0.15);
  approx(costOf('deepseek-reasoner', MONDAY(12), ONE_MILLION_MISS, rules()), 0.66);
});

test('per-model overrides only replace the fields they name', () => {
  const overridden = withModelOverrides(rules(), {
    'deepseek-v4-pro': { inputPerMillion: 0.5 },
  });
  approx(overridden.models['deepseek-v4-pro'].inputPerMillion, 0.5);
  approx(overridden.models['deepseek-v4-pro'].outputPerMillion, 1.98);

  const added = withModelOverrides(rules(), {
    'deepseek-chat': { cachedPerMillion: 0.1, inputPerMillion: 1, outputPerMillion: 2 },
  });
  approx(added.models['deepseek-chat'].inputPerMillion, 1);
});

test('a multiplier of 1 disables peak pricing', () => {
  const flat = rules({ peakMultiplier: 1 });
  assert.equal(isPeak(MONDAY(2), flat), false);
  approx(costOf('deepseek-v4-flash', MONDAY(2), ONE_MILLION_MISS, flat), 0.15);
});

test('costs add up across all three token kinds', () => {
  approx(
    costOf(
      'deepseek-v4-flash',
      MONDAY(12),
      { cacheHit: 1_000_000, cacheMiss: 1_000_000, output: 1_000_000 },
      rules(),
    ),
    0.003 + 0.15 + 0.6,
  );
});

test('the per-slice split is the total and keeps peak on every slice', () => {
  const parts = costPartsOf(
    'deepseek-v4-flash',
    MONDAY(2),
    { cacheHit: 1_000_000, cacheMiss: 1_000_000, output: 1_000_000 },
    rules(),
  );
  assert.ok(parts !== null);
  approx(parts.hit, 0.006);
  approx(parts.miss, 0.3);
  approx(parts.out, 1.2);
  approx(parts.total, 0.006 + 0.3 + 1.2);
});

test('hasRates is false only when every rate is zero', () => {
  assert.equal(hasRates(rules()), true);
  const unpriced = rules({
    models: { 'deepseek-v4-flash': { cachedPerMillion: 0, inputPerMillion: 0, outputPerMillion: 0 } },
  });
  assert.equal(hasRates(unpriced), false);
});
