import crypto from "crypto";
import { calculateCost } from "./pricing.js";

const TIER_ORDER = ["simple", "medium", "complex"];
const CACHE_MAX_SIZE = 1000;

const CODE_PATTERNS = [
  "function", "class", "import", "export", "const ", "let ", "var ", "def ",
  "return", "```", "syntax", "error", "bug", "debug", "refactor", "implement",
  "typescript", "javascript", "python", "code"
];

const COMPLEX_PATTERNS = [
  "analyze", "architecture", "design system", "trade-off", "compare and contrast",
  "pros and cons", "legal", "medical", "financial advice", "strategy", "deep dive",
  "comprehensive", "in depth", "explain why", "reason through"
];

const SIMPLE_PATTERNS = [
  "summarize", "tldr", "tag", "classify", "extract", "yes or no", "true or false",
  "autocomplete", "complete this", "fill in", "translate", "fix spelling", "fix grammar"
];

const AGENTIC_PATTERNS = [
  "tool_call", "function_call", "<tool>", "agent", "step", "previous step",
  "next step", "task complete"
];

const ROUTING_DEFAULTS = {
  enabled: true,
  min_confidence_threshold: 0.65,
  allow_code_downgrade: true,
  allow_agentic_downgrade: false,
  quality_check_enabled: true,
  auto_retry_on_quality_fail: true,
  classifier_cache_enabled: true,
  classifier_cache_ttl_minutes: 60,
  min_savings_threshold_usd: 0.001,
  multi_provider_fallback_enabled: true
};

// Tier lists – cheapest to most expensive per provider
const OPENAI_TIERS = ["gpt-4.1-nano", "gpt-4o-mini", "gpt-4.1-mini", "gpt-4o", "gpt-4.1", "gpt-5-mini"];
const ANTHROPIC_TIERS = ["claude-haiku-4.5", "claude-sonnet-4.6", "claude-opus-4.8", "claude-fable-5"];
const GEMINI_TIERS = ["gemini-2.0-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"];
const DEEPSEEK_TIERS = ["deepseek-v4-flash", "deepseek-v3", "deepseek-v4-pro", "deepseek-r1"];
const LLAMA_TIERS = ["llama-4-scout", "llama-3.3-70b", "llama-4-maverick"];
const MISTRAL_TIERS = ["mistral-small-3.2", "mistral-large-3"];

// Cross‑provider equivalents for fallback (simplified)
const PROVIDER_EQUIVALENTS = {
  "gpt-4o-mini": "claude-haiku-4.5",
  "gpt-4o": "claude-sonnet-4.6",
  "gpt-4.1-mini": "claude-haiku-4.5",
  "gpt-4.1": "claude-sonnet-4.6",
  "claude-haiku-4.5": "gpt-4o-mini",
  "claude-sonnet-4.6": "gpt-4o",
  "claude-opus-4.8": "gpt-4.1",
  "gemini-2.5-flash": "gpt-4o-mini",
  "gemini-2.5-pro": "gpt-4o",
  "deepseek-v4-flash": "gpt-4o-mini",
  "llama-4-scout": "gpt-4o-mini",
  "mistral-small-3.2": "gpt-4o-mini"
};

const classificationCache = new Map();

export function routingConfig(config) {
  return { ...ROUTING_DEFAULTS, ...(config.routing || {}) };
}

export function providerForModel(model, fallbackProvider) {
  const m = String(model || "").toLowerCase();
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1")) return "openai";
  if (m.startsWith("gemini-")) return "gemini";
  if (m.startsWith("deepseek-")) return "deepseek";
  if (m.startsWith("llama-")) return "llama";
  if (m.startsWith("mistral-")) return "mistral";
  return fallbackProvider;
}

export function providerUrl(provider) {
  // TESTING – redirect all to mock. Change to real endpoints for production.
  return 'http://localhost:4000/v1/chat/completions';
  
  /* Production endpoints (uncomment when ready):
  switch(provider) {
    case "anthropic": return "https://api.anthropic.com/v1/messages";
    case "gemini": return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    case "deepseek": return "https://api.deepseek.com/v1/chat/completions";
    case "llama": return "https://api.together.ai/v1/chat/completions"; // example
    case "mistral": return "https://api.mistral.ai/v1/chat/completions";
    default: return "https://api.openai.com/v1/chat/completions";
  }
  */
}

export function extractTextFromBody(provider, body) {
  const parts = [];
  let systemText = "";

  // OpenAI‑compatible request shape (used by most providers)
  for (const message of body?.messages || []) {
    const content = normalizeContent(message.content);
    if (message.role === "system") systemText += content;
    parts.push(content);
  }
  // Anthropic has separate system field; handle if provider === "anthropic" and body.system exists
  if (provider === "anthropic" && body?.system) {
    systemText += normalizeContent(body.system);
  }

  return {
    allText: parts.join("\n"),
    totalCharacters: parts.join("").length,
    systemCharacters: systemText.length,
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0
  };
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      return item?.text || item?.content || JSON.stringify(item);
    }).join(" ");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function containsAny(text, patterns) {
  const lower = text.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function cacheKeyFor(body) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(body?.messages || []))
    .digest("hex");
}

function readCache(key, config) {
  const cached = classificationCache.get(key);
  if (!cached) return null;
  const ttlMs = Number(config.classifier_cache_ttl_minutes) * 60 * 1000;
  if (Date.now() - cached.createdAt > ttlMs) {
    classificationCache.delete(key);
    return null;
  }
  classificationCache.delete(key);
  classificationCache.set(key, cached);
  return cached.value;
}

function writeCache(key, value) {
  if (classificationCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = classificationCache.keys().next().value;
    classificationCache.delete(oldestKey);
  }
  classificationCache.set(key, { createdAt: Date.now(), value });
}

export function classifyRequest(provider, body) {
  const startedAt = Date.now();
  const signals = extractTextFromBody(provider, body);
  const hasCode = containsAny(signals.allText, CODE_PATTERNS);
  const hasComplex = containsAny(signals.allText, COMPLEX_PATTERNS);
  const hasSimple = containsAny(signals.allText, SIMPLE_PATTERNS);
  const isAgentic = containsAny(signals.allText, AGENTIC_PATTERNS);

  let tier = "medium";
  const reasons = [];

  if (
    signals.totalCharacters > 1500 ||
    hasComplex ||
    (hasCode && signals.totalCharacters > 500) ||
    signals.systemCharacters > 800 ||
    signals.messageCount > 6
  ) {
    tier = "complex";
    reasons.push("complex signal");
  } else if (
    (signals.totalCharacters < 300 && !hasCode && !hasComplex) ||
    (hasSimple && !hasCode && signals.totalCharacters < 500)
  ) {
    tier = "simple";
    reasons.push("simple short request");
  } else {
    tier = "medium";
    reasons.push("medium request");
  }

  if (hasCode) reasons.push("code signal");
  if (hasSimple) reasons.push("simple task signal");
  if (isAgentic) reasons.push("agentic signal");

  const clearSignals = [hasCode, hasComplex, hasSimple, isAgentic].filter(Boolean).length;
  let confidence = 0.75;
  if ((tier === "complex" && (hasComplex || signals.totalCharacters > 1500 || signals.messageCount > 6)) ||
      (tier === "simple" && hasSimple && signals.totalCharacters < 500)) {
    confidence = 0.9;
  }
  if (clearSignals > 1 && ((hasSimple && hasComplex) || (hasSimple && hasCode))) {
    confidence = 0.6;
  }
  if (!hasCode && !hasComplex && !hasSimple && !isAgentic && signals.totalCharacters < 300) {
    confidence = 0.75;
  }

  return {
    tier,
    confidence,
    hasCode,
    isAgentic,
    totalCharacters: signals.totalCharacters,
    systemCharacters: signals.systemCharacters,
    messageCount: signals.messageCount,
    reason: reasons.join(", ") || `${tier} length signal`,
    durationMs: Date.now() - startedAt
  };
}

export function estimateInputTokens(provider, body) {
  const { totalCharacters } = extractTextFromBody(provider, body);
  return Math.ceil((totalCharacters / 4) * 1.1);
}

export function estimateOutputTokens(body) {
  const explicitMax = Number(body?.max_completion_tokens || body?.max_tokens || 0);
  if (explicitMax > 0) return explicitMax;
  return 300;
}

export function projectedSavings(originalModel, actualModel, inputTokens, outputTokens) {
  const originalCost = calculateCost(originalModel, inputTokens, outputTokens);
  const actualCost = calculateCost(actualModel, inputTokens, outputTokens);
  return {
    originalCostUsd: originalCost,
    actualCostUsd: actualCost,
    savingsUsd: Number(Math.max(0, originalCost - actualCost).toFixed(8))
  };
}

function enforceMinTier(tier, minTier) {
  if (!minTier || !TIER_ORDER.includes(minTier)) return tier;
  return TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(minTier) ? minTier : tier;
}

function modelForClassification(provider, classification, originalModel, config) {
  if (classification.isAgentic && !config.allow_agentic_downgrade) {
    return { model: originalModel, reason: "agentic request detected" };
  }
  if (classification.confidence < Number(config.min_confidence_threshold)) {
    return { model: originalModel, reason: "classification confidence below threshold" };
  }
  if (classification.hasCode && !config.allow_code_downgrade) {
    return { model: originalModel, reason: "code downgrade disabled" };
  }

  // OpenAI routing
  if (provider === "openai") {
    if (classification.tier === "complex") return { model: "gpt-4.1", reason: "complex request" };
    if (classification.tier === "medium") {
      return classification.hasCode
        ? { model: "gpt-4o", reason: "medium complexity with code" }
        : { model: "gpt-4.1-mini", reason: "medium complexity no code" };
    }
    if (classification.hasCode && classification.confidence <= 0.8) {
      return { model: "gpt-4o-mini", reason: "simple code request with moderate confidence" };
    }
    return { model: "gpt-4.1-nano", reason: "simple request" };
  }

  // Anthropic
  if (provider === "anthropic") {
    if (classification.tier === "complex") return { model: "claude-fable-5", reason: "complex request" };
    if (classification.tier === "medium") {
      return classification.hasCode
        ? { model: "claude-sonnet-4.6", reason: "medium complexity with code" }
        : { model: "claude-haiku-4.5", reason: "medium complexity no code" };
    }
    if (classification.hasCode && classification.confidence <= 0.8) {
      return { model: "claude-haiku-4.5", reason: "simple code request" };
    }
    return { model: "claude-haiku-4.5", reason: "simple request" };
  }

  // Gemini (simplified)
  if (provider === "gemini") {
    if (classification.tier === "complex") return { model: "gemini-2.5-pro", reason: "complex request" };
    if (classification.tier === "medium") return { model: "gemini-2.5-flash", reason: "medium request" };
    return { model: "gemini-2.0-flash-lite", reason: "simple request" };
  }

  // DeepSeek
  if (provider === "deepseek") {
    if (classification.tier === "complex") return { model: "deepseek-v4-pro", reason: "complex request" };
    if (classification.tier === "medium") return { model: "deepseek-v3", reason: "medium request" };
    return { model: "deepseek-v4-flash", reason: "simple request" };
  }

  // Llama
  if (provider === "llama") {
    if (classification.tier === "complex") return { model: "llama-4-maverick", reason: "complex request" };
    if (classification.tier === "medium") return { model: "llama-3.3-70b", reason: "medium request" };
    return { model: "llama-4-scout", reason: "simple request" };
  }

  // Mistral
  if (provider === "mistral") {
    if (classification.tier === "complex") return { model: "mistral-large-3", reason: "complex request" };
    return { model: "mistral-small-3.2", reason: "simple or medium request" };
  }

  // Fallback: keep original model
  return { model: originalModel, reason: "provider not specifically routed" };
}

export function analyzeRouting({ provider, body, headers, config }) {
  const routeConfig = routingConfig(config);
  const originalModel = body?.model || "unknown";
  const noRoute = String(headers["x-proxy-no-route"] || "").toLowerCase() === "true";
  const noCache = String(headers["x-proxy-no-cache"] || "").toLowerCase() === "true";
  const forcedModel = headers["x-proxy-force-model"];
  const minTier = headers["x-proxy-min-tier"];
  const estimatedInputTokens = estimateInputTokens(provider, body);
  const estimatedOutputTokens = estimateOutputTokens(body);
  const key = cacheKeyFor(body);
  let cacheHit = false;
  let classification;

  if (!routeConfig.enabled) {
    classification = classifyRequest(provider, body);
    return skippedDecision("routing disabled", classification);
  }

  if (forcedModel) {
    classification = classifyRequest(provider, body);
    classification.tier = enforceMinTier(classification.tier, minTier);
    return buildDecision(String(forcedModel), "forced model override", classification, false);
  }

  if (noRoute) {
    classification = classifyRequest(provider, body);
    classification.tier = enforceMinTier(classification.tier, minTier);
    return skippedDecision("no-route override", classification);
  }

  if (routeConfig.classifier_cache_enabled && !noCache) {
    const cached = readCache(key, routeConfig);
    if (cached) {
      cacheHit = true;
      classification = { ...cached.classification, durationMs: 0 };
      console.log("[ROUTER] Cache hit - skipping classification for known request");
    }
  }

  if (!classification) {
    classification = classifyRequest(provider, body);
    classification.tier = enforceMinTier(classification.tier, minTier);
    if (routeConfig.classifier_cache_enabled && !noCache && classification.confidence > 0.75) {
      writeCache(key, { classification });
    }
  }

  if (classification.isAgentic && !routeConfig.allow_agentic_downgrade) {
    console.log("[ROUTER] Agentic request detected - keeping original model");
  }

  const candidate = modelForClassification(provider, classification, originalModel, routeConfig);
  const projected = projectedSavings(
    originalModel,
    candidate.model,
    estimatedInputTokens,
    estimatedOutputTokens
  );

  if (projected.savingsUsd < Number(routeConfig.min_savings_threshold_usd) && candidate.model !== originalModel) {
    console.log(`[ROUTER] Routing skipped - savings below threshold ($${projected.savingsUsd.toFixed(4)})`);
    return {
      ...skippedDecision("savings below threshold", classification),
      projected,
      cacheHit,
      estimatedInputTokens,
      estimatedOutputTokens
    };
  }

  return {
    ...buildDecision(candidate.model, candidate.reason, classification, candidate.model !== originalModel),
    projected,
    cacheHit,
    estimatedInputTokens,
    estimatedOutputTokens
  };

  function skippedDecision(reason, localClassification) {
    return buildDecision(originalModel, reason, localClassification, false);
  }

  function buildDecision(actualModel, reason, localClassification, wasRouted) {
    const projectedCost = projectedSavings(originalModel, actualModel, estimatedInputTokens, estimatedOutputTokens);
    return {
      originalModel,
      actualModel,
      actualProvider: providerForModel(actualModel, provider),
      wasRouted,
      routingReason: reason,
      classification: localClassification,
      projected: projectedCost,
      cacheHit,
      estimatedInputTokens,
      estimatedOutputTokens
    };
  }
}

export function nextHigherModel(provider, model) {
  let tiers;
  switch(provider) {
    case "anthropic": tiers = ANTHROPIC_TIERS; break;
    case "gemini": tiers = GEMINI_TIERS; break;
    case "deepseek": tiers = DEEPSEEK_TIERS; break;
    case "llama": tiers = LLAMA_TIERS; break;
    case "mistral": tiers = MISTRAL_TIERS; break;
    default: tiers = OPENAI_TIERS;
  }
  const index = tiers.indexOf(model);
  if (index >= 0 && index < tiers.length - 1) return tiers[index + 1];
  return null;
}

export function equivalentOtherProviderModel(model) {
  return PROVIDER_EQUIVALENTS[model] || null;
}

export function buildFallbackModels({ provider, actualModel, originalModel, config }) {
  if (!routingConfig(config).multi_provider_fallback_enabled) return [originalModel].filter(Boolean);

  const fallbacks = [];
  const next = nextHigherModel(provider, actualModel);
  if (next) fallbacks.push(next);

  const equivalent = equivalentOtherProviderModel(next || actualModel);
  if (equivalent) fallbacks.push(equivalent);

  fallbacks.push(originalModel);
  return [...new Set(fallbacks.filter((model) => model && model !== actualModel))];
}

export function checkQuality({ provider, body, responseBody, classification }) {
  const content = extractResponseContent(provider, responseBody);
  const lower = content.toLowerCase();
  const isShortAllowed = containsAny(extractTextFromBody(provider, body).allText, [
    "yes or no", "true or false", "classify", "tag"
  ]);
  const estimatedTokens = Math.ceil(content.length / 4);
  const finishReason = extractFinishReason(provider, responseBody);
  const trimmed = content.trim();
  const hasTerminalPunctuation = /[.!?。！？)"'\]]$/.test(trimmed);
  const reviewPhrases = [
    "i cannot", "i don't have the ability", "as a language model i"
  ];
  const reviewFlagged = reviewPhrases.some((phrase) => lower.includes(phrase));

  if (estimatedTokens < 15 && !isShortAllowed) {
    return { passed: false, reason: "empty_or_too_short", reviewFlagged };
  }
  if (trimmed && !hasTerminalPunctuation && finishReason && finishReason !== "stop") {
    return { passed: false, reason: "truncated", reviewFlagged };
  }
  return {
    passed: true,
    reason: reviewFlagged ? "review_phrase_detected" : "passed",
    reviewFlagged,
    tier: classification?.tier
  };
}

export function extractResponseContent(provider, responseBody) {
  // OpenAI-compatible format (also works for Gemini, DeepSeek, etc.)
  if (responseBody?.choices) {
    return (responseBody.choices || [])
      .map((choice) => choice?.message?.content || choice?.delta?.content || "")
      .join("");
  }
  // Anthropic format
  if (responseBody?.content) {
    return (responseBody.content || [])
      .map((item) => item?.text || "")
      .join("");
  }
  return "";
}

export function extractFinishReason(provider, responseBody) {
  if (responseBody?.choices?.[0]?.finish_reason) {
    return responseBody.choices[0].finish_reason;
  }
  return responseBody?.stop_reason || null;
}