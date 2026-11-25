// The settings-backed pricing rules, shared by the usage graph and the Zero
// panel so both show the same money.

import * as vscode from 'vscode';

import {
  DEFAULT_MODEL,
  DEFAULT_PEAK_MULTIPLIER,
  type ModelRates,
  type PricingRules,
  defaultRules,
  withModelOverrides,
} from './pricing';

const PRICING_SETTINGS = 'deepseek.advance';

/** The flat triple the harness understands. */
const NO_RATES: ModelRates = { cachedPerMillion: 0, inputPerMillion: 0, outputPerMillion: 0 };

/**
 * Read the pricing rules from settings.
 *
 * `pricing.models` adds or overrides one model at a time. The older flat
 * `pricing.*PerMillion` triple predates per-model rates: when set it replaces
 * the whole table, so an existing configuration keeps billing exactly as
 * before, and per-model entries still win over it.
 */
export function readPricingRules(): PricingRules {
  const pricing = vscode.workspace.getConfiguration(PRICING_SETTINGS);
  const baseModel =
    vscode.workspace.getConfiguration('deepseek').get<string>('model', DEFAULT_MODEL) || DEFAULT_MODEL;

  let rules: PricingRules = { ...defaultRules(), baseModel };

  const flat: ModelRates = {
    cachedPerMillion: pricing.get<number>('pricing.cachedPerMillion', 0) || 0,
    inputPerMillion: pricing.get<number>('pricing.inputPerMillion', 0) || 0,
    outputPerMillion: pricing.get<number>('pricing.outputPerMillion', 0) || 0,
  };
  if (flat.cachedPerMillion > 0 || flat.inputPerMillion > 0 || flat.outputPerMillion > 0) {
    rules = {
      ...rules,
      models: Object.fromEntries(Object.keys(rules.models).map((model) => [model, flat])),
    };
  }

  rules = withModelOverrides(
    rules,
    pricing.get<Record<string, Partial<ModelRates>>>('pricing.models', {}),
  );

  const multiplier = pricing.get<number>('pricing.peakMultiplier', DEFAULT_PEAK_MULTIPLIER);
  rules.peakMultiplier =
    typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier >= 1
      ? multiplier
      : DEFAULT_PEAK_MULTIPLIER;

  const holidays = pricing.get<string[]>('pricing.holidays', []);
  rules.holidays = Array.isArray(holidays)
    ? holidays.filter((date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
    : [];

  return rules;
}

/** Off-peak rates for the configured model, for the harness's cost divider. */
export function harnessPricing(): ModelRates {
  const rules = readPricingRules();
  return rules.models[rules.baseModel] ?? NO_RATES;
}
