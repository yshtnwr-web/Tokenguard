import crypto from "crypto";
import { calculateCost } from "./pricing.js";

const DEFAULT_PREFLIGHT = {
  enabled: true,
  warn_above_usd: 0.03,
  block_above_usd: 0.15,
  agentic_block_above_usd: 0.40,
  approval_timeout_minutes: 10,
  auto_approve_if_similar_approved: true,
  agentic_chain_multiplier: 8
};

const MODEL_OUTPUT_DEFAULTS = {
  "gpt-4o": 1024,
  "gpt-4o-mini": 1024
};

const similarApprovals = new Map();
const SIMILAR_TTL_MS = 60 * 60 * 1000;

export function getTeamPreflightConfig(config, team) {
  const teamConfig = config.teams?.[team] || config.teams?.default || {};
  return {
    ...DEFAULT_PREFLIGHT,
    ...(teamConfig.preflight || {})
  };
}

// Helper: find a cheaper model for the same provider based on classification
export function getCheaperFallback(originalModel, estimate, provider, classification) {
  // For OpenAI: try gpt-4o-mini or gpt-4.1-nano if original is expensive
  if (provider === "openai") {
    if (originalModel.includes("gpt-4o") && !originalModel.includes("mini")) {
      const cheaperModel = "gpt-4o-mini";
      const cheaperCost = calculateCost(cheaperModel, estimate.estimatedInputTokens, estimate.estimatedOutputTokens);
      const savings = estimate.estimatedCostUsd - cheaperCost;
      if (savings > 0.001) {
        return {
          model: cheaperModel,
          cost: cheaperCost,
          savings,
          qualityNote: "Good for simple to medium tasks; slightly less capable for complex reasoning or code."
        };
      }
    }
    if (originalModel === "gpt-4o-mini") {
      const cheaperModel = "gpt-4.1-nano";
      const cheaperCost = calculateCost(cheaperModel, estimate.estimatedInputTokens, estimate.estimatedOutputTokens);
      const savings = estimate.estimatedCostUsd - cheaperCost;
      if (savings > 0.0005) {
        return {
          model: cheaperModel,
          cost: cheaperCost,
          savings,
          qualityNote: "Very cheap, best for extremely simple extraction or classification."
        };
      }
    }
  }
  // For Anthropic: haiku is cheaper than sonnet/opus
  if (provider === "anthropic") {
    if (originalModel.includes("sonnet") || originalModel.includes("opus")) {
      const cheaperModel = "claude-haiku-4.5";
      const cheaperCost = calculateCost(cheaperModel, estimate.estimatedInputTokens, estimate.estimatedOutputTokens);
      const savings = estimate.estimatedCostUsd - cheaperCost;
      if (savings > 0.001) {
        return {
          model: cheaperModel,
          cost: cheaperCost,
          savings,
          qualityNote: "Fast and cheap; suitable for simple QA, summarisation, classification."
        };
      }
    }
  }
  return null;
}

export function estimatePreflightCost({ body, headers = {}, model, team, sessionRequestCount = 0, config, classification }) {
  const startedAt = Date.now();
  const preflightConfig = getTeamPreflightConfig(config, team);

  if (String(headers["x-proxy-no-preflight"] || "").toLowerCase() === "true") {
    return skippedResult(startedAt, "skipped");
  }

  // Extract business context from headers
  const triggerSource = headers["x-tokenguard-trigger"] || null;
  const businessObject = headers["x-tokenguard-object"] || null;
  const expectedOutcome = headers["x-tokenguard-expected-outcome"] || null;

  const inputTokensBase = estimateInputTokens(body);
  const outputTokens = estimateOutputTokens(body, model);
  const agentic = detectAgentic(body, sessionRequestCount);
  const multiplier = agentic ? Number(preflightConfig.agentic_chain_multiplier || 8) : 1;
  const baseCost = calculateCost(model, inputTokensBase, outputTokens);
  const estimatedCostUsd = Number((baseCost * multiplier).toFixed(6));
  const fingerprint = buildFingerprint({
    model,
    team,
    body,
    requestType: classification?.tier || "unknown"
  });
  const similarApproval = preflightConfig.auto_approve_if_similar_approved
    ? getSimilarApproval(fingerprint)
    : null;

  let outcome = "pass";
  let threshold = Number(preflightConfig.warn_above_usd);
  const blockThreshold = agentic
    ? Number(preflightConfig.agentic_block_above_usd)
    : Number(preflightConfig.block_above_usd);

  if (!preflightConfig.enabled) {
    outcome = "skipped";
  } else if (similarApproval && estimatedCostUsd >= blockThreshold) {
    outcome = "auto_approved";
  } else if (estimatedCostUsd >= blockThreshold) {
    outcome = "block";
    threshold = blockThreshold;
  } else if (estimatedCostUsd >= Number(preflightConfig.warn_above_usd)) {
    outcome = "warn";
  }

  // Compute cheaper fallback (only if outcome is block or warn, to show on approval page)
  let cheaperFallback = null;
  if (outcome === "block" || outcome === "warn") {
    cheaperFallback = getCheaperFallback(model, {
      estimatedInputTokens: inputTokensBase,
      estimatedOutputTokens: outputTokens,
      estimatedCostUsd
    }, providerForModel(model, "openai"), classification);
  }

  return {
    enabled: Boolean(preflightConfig.enabled),
    outcome,
    estimatedCostUsd,
    estimatedInputTokens: inputTokensBase,
    estimatedOutputTokens: outputTokens,
    agenticDetected: agentic,
    agenticMultiplierApplied: multiplier,
    thresholdUsd: threshold,
    blockThresholdUsd: blockThreshold,
    warnThresholdUsd: Number(preflightConfig.warn_above_usd),
    durationMs: Date.now() - startedAt,
    config: preflightConfig,
    requestSummary: requestSummary(body),
    fingerprint,
    similarApproval,
    triggerSource,
    businessObject,
    expectedOutcome,
    cheaperFallback
  };
}

function skippedResult(startedAt, outcome) {
  return {
    enabled: false,
    outcome,
    estimatedCostUsd: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    agenticDetected: false,
    agenticMultiplierApplied: 1,
    thresholdUsd: 0,
    blockThresholdUsd: 0,
    warnThresholdUsd: 0,
    durationMs: Date.now() - startedAt,
    config: DEFAULT_PREFLIGHT,
    requestSummary: "",
    fingerprint: null,
    similarApproval: null,
    triggerSource: null,
    businessObject: null,
    expectedOutcome: null,
    cheaperFallback: null
  };
}

export function estimateInputTokens(body) {
  let total = 0;
  const messages = Array.isArray(body?.messages) ? body.messages : [];

  for (const message of messages) {
    const content = normalizeContent(message.content);
    total += content.length / 4;
    total += 4;
    total += 3;
  }

  const separateSystem = normalizeContent(body?.system || "");
  if (separateSystem) {
    total += separateSystem.length / 4;
  } else if (messages[0]?.role === "system") {
    total += normalizeContent(messages[0].content).length / 4;
  }

  const toolCount = Array.isArray(body?.tools)
    ? body.tools.length
    : Array.isArray(body?.functions)
      ? body.functions.length
      : 0;
  total += toolCount * 100;

  return Math.ceil(total * 1.15);
}

export function estimateOutputTokens(body, model) {
  const explicit = Number(body?.max_tokens || body?.max_completion_tokens || 0);
  const maxTokens = explicit > 0 ? explicit : defaultOutputTokens(model);
  return Math.ceil(maxTokens * 0.7);
}

function defaultOutputTokens(model) {
  const name = String(model || "").toLowerCase();
  if (name.includes("o1") || name.startsWith("o")) return 4096;
  if (name.startsWith("claude-")) return 1024;
  return MODEL_OUTPUT_DEFAULTS[model] || 1024;
}

export function detectAgentic(body, sessionRequestCount = 0) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const hasToolHistory = messages.some((message) => {
    const role = String(message.role || "").toLowerCase();
    return role === "tool" || role === "tool_result" || Boolean(message.tool_call_id) || Boolean(message.tool_calls);
  });
  return (
    tools.length > 2 ||
    hasToolHistory ||
    Number(sessionRequestCount || 0) > 3 ||
    Boolean(body?.function_call)
  );
}

export function createApprovalId() {
  return `apr_${crypto.randomBytes(9).toString("hex")}`;
}

export function expiresAtFor(preflight) {
  const minutes = Math.min(Number(preflight.config.approval_timeout_minutes || 10), 10);
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function approvalErrorBody({ approvalId, preflight, baseUrl, expiresAt = null }) {
  return {
    error: {
      type: "preflight_blocked",
      message: `Request blocked: estimated cost $${preflight.estimatedCostUsd.toFixed(2)} exceeds team threshold of $${preflight.blockThresholdUsd.toFixed(2)}`,
      approval_id: approvalId,
      estimated_cost_usd: preflight.estimatedCostUsd,
      approval_url: `${baseUrl}/approve/${approvalId}`,
      expires_at: expiresAt || expiresAtFor(preflight)
    }
  };
}

export function rememberSimilarApproval(fingerprint) {
  if (!fingerprint) return;
  similarApprovals.set(fingerprint, { approvedAt: Date.now() });
}

export function getSimilarApproval(fingerprint) {
  if (!fingerprint) return null;
  const approval = similarApprovals.get(fingerprint);
  if (!approval) return null;
  if (Date.now() - approval.approvedAt > SIMILAR_TTL_MS) {
    similarApprovals.delete(fingerprint);
    return null;
  }
  return approval;
}

export function minutesSince(timestampMs) {
  return Math.max(0, Math.floor((Date.now() - timestampMs) / 60000));
}

export function buildFingerprint({ model, team, body, requestType }) {
  const system = firstSystemPrompt(body).slice(0, 100);
  return crypto
    .createHash("sha256")
    .update(`${model}|${team}|${system}|${requestType}`)
    .digest("hex");
}

export function requestSummary(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return normalizeContent(lastUser?.content || messages[messages.length - 1]?.content || "").slice(0, 200);
}

function firstSystemPrompt(body) {
  if (body?.system) return normalizeContent(body.system);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.find((message) => message.role === "system");
  return normalizeContent(system?.content || "");
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

// Helper to infer provider from model name (simple version)
function providerForModel(model, fallback) {
  if (model && (model.startsWith("gpt-") || model.startsWith("o1"))) return "openai";
  if (model && model.startsWith("claude-")) return "anthropic";
  return fallback;
}

// ========== WRAPPER FUNCTIONS FOR INDEX.JS COMPATIBILITY ==========
export function calculatePreflightEstimate({ body, provider, model, sessionId, sessionHistory, loopDetector, teamConfig }) {
  // This function is called from index.js – we map its parameters to estimatePreflightCost
  const sessionRequestCount = sessionId ? (loopDetector?.sessions?.get(sessionId)?.requests?.length || 0) : 0;
  const result = estimatePreflightCost({
    body,
    headers: body?._headers || {},  // headers are passed separately in index.js; we'll need to adjust index.js to pass headers. For now, we assume they are in body._headers. We'll fix index.js separately.
    model,
    team: teamConfig?.team || "default",
    sessionRequestCount,
    config: { teams: { default: { preflight: teamConfig } } },
    classification: { tier: "unknown" }
  });
  return {
    success: true,
    estimatedCostUsd: result.estimatedCostUsd,
    estimatedInputTokens: result.estimatedInputTokens,
    estimatedOutputTokens: result.estimatedOutputTokens,
    agenticDetected: result.agenticDetected,
    agenticMultiplierApplied: result.agenticMultiplierApplied,
    durationMs: result.durationMs,
    triggerSource: result.triggerSource,
    businessObject: result.businessObject,
    expectedOutcome: result.expectedOutcome,
    cheaperFallback: result.cheaperFallback,
    error: null
  };
}

export function evaluatePreflightThresholds(estimate, teamPreflightConfig) {
  const blockThreshold = estimate.agenticDetected 
    ? teamPreflightConfig.agentic_block_above_usd 
    : teamPreflightConfig.block_above_usd;
  
  let outcome = "pass";
  if (estimate.estimatedCostUsd >= blockThreshold) {
    outcome = "block";
  } else if (estimate.estimatedCostUsd >= teamPreflightConfig.warn_above_usd) {
    outcome = "warn";
  }
  
  return {
    outcome,
    reason: outcome === "block" ? `estimated cost exceeds block threshold $${blockThreshold}` : null,
    effectiveBlockThreshold: blockThreshold
  };
}

export function generateFingerprint(body, team, model) {
  return buildFingerprint({ model, team, body, requestType: "unknown" });
}

export function checkSimilarApproved(fingerprint) {
  return getSimilarApproval(fingerprint);
}

export function storeApprovedFingerprint(fingerprint) {
  rememberSimilarApproval(fingerprint);
}

export function shouldSkipPreflight(headers) {
  return String(headers["x-proxy-no-preflight"] || "").toLowerCase() === "true";
}

export function invalidateTeamConfigCache() {
  console.log("[PREFLIGHT] Team config cache invalidated (no-op in current version)");
}