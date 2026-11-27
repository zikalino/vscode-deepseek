// DeepSeek list prices, and when they apply.
//
// A request is billed three ways: cache-hit input, uncached input, and output.
// The published prices are the off-peak rates; peak hours cost a multiple of
// them. Kept free of `vscode` imports so the same rules can price a sample in a
// test (see `pricingSettings.ts` for the settings-backed wrapper).

export interface ModelRates {
  /** Dollars per million cache-hit input tokens. */
  cachedPerMillion: number;
  /** Dollars per million uncached input tokens. */
  inputPerMillion: number;
  /** Dollars per million output tokens. */
  outputPerMillion: number;
}

/** The token counts of one request. */
export interface TokenCounts {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/**
 * Off-peak prices in dollars per million tokens, by API model id. Peak hours
 * bill `peakMultiplier` times these.
 */
export const BASE_RATES: Readonly<Record<string, ModelRates>> = {
  'deepseek-v4-flash': { cachedPerMillion: 0.003, inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'deepseek-v4-pro': { cachedPerMillion: 0.022, inputPerMillion: 0.66, outputPerMillion: 1.98 },
  // The public API still names the same tiers `deepseek-chat` and `deepseek-reasoner`. They are
  // aliases, not a second price list: the native host uses `deepseek-chat` by default and must show
  // the same money as the v4 ids.
  'deepseek-chat': { cachedPerMillion: 0.003, inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'deepseek-reasoner': { cachedPerMillion: 0.022, inputPerMillion: 0.66, outputPerMillion: 1.98 },
};

export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const DEFAULT_PEAK_MULTIPLIER = 2;

/**
 * Peak windows as UTC hours, `[start, end)`. DeepSeek bills 01:00–04:00 and
 * 06:00–10:00 UTC on weekdays at peak rates; every other hour is off-peak, and
 * weekends and Chinese public holidays are off-peak in full.
 */
export const PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];

/** Everything needed to price a request. */
export interface PricingRules {
  /** Off-peak dollars per million tokens, keyed by API model id. */
  models: Record<string, ModelRates>;
  /** The model whose rates price a request whose model is not in `models`. */
  baseModel: string;
  /** Peak hours bill at this multiple of the off-peak rates; 1 disables peak pricing. */
  peakMultiplier: number;
  /** UTC dates (`YYYY-MM-DD`) billed at off-peak all day. */
  holidays: string[];
}

/** The built-in table, no settings applied. */
export function defaultRules(): PricingRules {
  return {
    models: { ...BASE_RATES },
    baseModel: DEFAULT_MODEL,
    peakMultiplier: DEFAULT_PEAK_MULTIPLIER,
    holidays: [],
  };
}

/** Apply per-model overrides; fields a caller leaves out keep their current value. */
export function withModelOverrides(
  rules: PricingRules,
  overrides: Record<string, Partial<ModelRates>> | undefined,
): PricingRules {
  const models: Record<string, ModelRates> = { ...rules.models };
  for (const [model, partial] of Object.entries(overrides ?? {})) {
    if (partial === null || typeof partial !== 'object') {
      continue;
    }
    const base = models[model] ?? rules.models[rules.baseModel] ?? {
      cachedPerMillion: 0,
      inputPerMillion: 0,
      outputPerMillion: 0,
    };
    models[model] = {
      cachedPerMillion: numberOr(partial.cachedPerMillion, base.cachedPerMillion),
      inputPerMillion: numberOr(partial.inputPerMillion, base.inputPerMillion),
      outputPerMillion: numberOr(partial.outputPerMillion, base.outputPerMillion),
    };
  }
  return { ...rules, models };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The UTC calendar date as `YYYY-MM-DD`. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** True when `atMs` falls in a peak window. */
export function isPeak(atMs: number, rules: PricingRules): boolean {
  if (!(rules.peakMultiplier > 1)) {
    return false;
  }
  const at = new Date(atMs);
  const day = at.getUTCDay();
  if (day === 0 || day === 6) {
    return false;
  }
  if (rules.holidays.includes(utcDate(at))) {
    return false;
  }
  const hour = at.getUTCHours();
  return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end);
}

/** Off-peak rates for a request's model, falling back to the base model. */
export function ratesFor(model: string, rules: PricingRules): ModelRates | undefined {
  return rules.models[model] ?? rules.models[rules.baseModel];
}

/** A request's cost split by the three token kinds, before it is turned into text. */
export interface CostParts {
  /** All three slices, in dollars. */
  total: number;
  /** Cache-hit input. */
  hit: number;
  /** Uncached input. */
  miss: number;
  /** Completion tokens. */
  out: number;
}

/**
 * One request's cost split by slice, or null when its model has no rates.
 *
 * The wasm Usage panel is handed the split rather than the token counts: it lays the money out but
 * does not own the rates, so the extension and the desktop shell can price the same sample.
 */
export function costPartsOf(
  model: string,
  atMs: number,
  tokens: TokenCounts,
  rules: PricingRules,
): CostParts | null {
  const rates = ratesFor(model, rules);
  if (!rates) {
    return null;
  }
  const multiplier = isPeak(atMs, rules) ? rules.peakMultiplier : 1;
  const hit = ((tokens.cacheHit * rates.cachedPerMillion) / 1_000_000) * multiplier;
  const miss = ((tokens.cacheMiss * rates.inputPerMillion) / 1_000_000) * multiplier;
  const out = ((tokens.output * rates.outputPerMillion) / 1_000_000) * multiplier;
  return { total: hit + miss + out, hit, miss, out };
}

/** Cost in dollars of one request, or null when its model has no rates. */
export function costOf(
  model: string,
  atMs: number,
  tokens: TokenCounts,
  rules: PricingRules,
): number | null {
  return costPartsOf(model, atMs, tokens, rules)?.total ?? null;
}

/** True when at least one model is priced, so a cost can be shown at all. */
export function hasRates(rules: PricingRules): boolean {
  return Object.values(rules.models).some(
    (rates) =>
      rates.cachedPerMillion > 0 || rates.inputPerMillion > 0 || rates.outputPerMillion > 0,
  );
}
