// Token prices per 1 million tokens
export const MODEL_PRICING = {
  // OpenAI
  "gpt-4.1": { input: 2.00, output: 8.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "gpt-4.1-nano": { input: 0.10, output: 0.40 },
  "gpt-5-mini": { input: 0.25, output: 2.00 },
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-3.5-turbo": { input: 0.50, output: 1.50 },

  // Google Gemini
  "gemini-2.5-pro": { input: 1.25, output: 10.00 },
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.30 },

  // DeepSeek
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87 },   // after 75% discount
  "deepseek-v3": { input: 0.27, output: 1.10 },
  "deepseek-r1": { input: 0.55, output: 2.19 },

  // Anthropic (new and old)
  "claude-fable-5": { input: 10.00, output: 50.00 },
  "claude-opus-4.8": { input: 5.00, output: 25.00 },
  "claude-opus-4.7": { input: 5.00, output: 25.00 },
  "claude-opus-4.6": { input: 5.00, output: 25.00 },
  "claude-sonnet-4.6": { input: 3.00, output: 15.00 },
  "claude-haiku-4.5": { input: 1.00, output: 5.00 },
  "claude-sonnet-4.5": { input: 3.00, output: 15.00 },
  // Older aliases for compatibility
  "claude-opus-4": { input: 15.00, output: 75.00 },
  "claude-sonnet-4": { input: 3.00, output: 15.00 },
  "claude-haiku-4": { input: 0.80, output: 4.00 },

  // Meta Llama (via hosted APIs like Together, Groq)
  "llama-4-maverick": { input: 0.20, output: 0.60 },
  "llama-4-scout": { input: 0.10, output: 0.25 },
  "llama-3.3-70b": { input: 0.15, output: 0.45 },

  // Mistral
  "mistral-large-3": { input: 0.50, output: 1.50 },
  "mistral-small-3.2": { input: 0.06, output: 0.18 },

  // Other (add more as needed)
  "grok-2": { input: 2.00, output: 8.00 },     // example, adjust pricing
  "cohere-command-r-plus": { input: 0.50, output: 1.50 }
};

const FALLBACK_MODEL = "gpt-4o";

export function getPricing(model) {
  return MODEL_PRICING[model] || MODEL_PRICING[FALLBACK_MODEL];
}

export function hasPricing(model) {
  return Boolean(MODEL_PRICING[model]);
}

export function calculateCost(model, inputTokens = 0, outputTokens = 0) {
  const pricing = getPricing(model);
  const inputCost = (Number(inputTokens) / 1_000_000) * pricing.input;
  const outputCost = (Number(outputTokens) / 1_000_000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(8));
}

export function calculateGpt4oBaselineCost(inputTokens = 0, outputTokens = 0) {
  return calculateCost(FALLBACK_MODEL, inputTokens, outputTokens);
}

export function calculateSavingsVsGpt4o(model, inputTokens = 0, outputTokens = 0) {
  const baseline = calculateGpt4oBaselineCost(inputTokens, outputTokens);
  const actual = calculateCost(model, inputTokens, outputTokens);
  return Number(Math.max(0, baseline - actual).toFixed(8));
}