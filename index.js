import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import basicAuth from "express-basic-auth";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import cors from "cors";
import { calculateCost } from "./pricing.js";
import { LoopDetector } from "./loop-detector.js";
import {
  getDashboardData,
  getMonthlySpend,
  getRoutingLogs,
  getRoutingStats,
  getPendingApproval,
  getAllPendingApprovalsList,
  getRecentApprovalsList,
  getApprovalStatsSummary,
  createPendingApproval,
  updateApprovalStatus,
  updateApprovalAccuracy,
  updateApprovalOutcome,
  getApprovalsForRetrospective,
  addOutcomeTag,
  logApiCall,
  logBlockedBudget,
  logBlockedLoop,
  logRoutingDecision,
  logApprovalAudit,
  deleteOldLogs,
  getSavingsBreakdown
} from "./db.js";
import {
  analyzeRouting,
  buildFallbackModels,
  checkQuality,
  equivalentOtherProviderModel,
  extractResponseContent,
  providerForModel,
  providerUrl,
  routingConfig
} from "./router.js";
import {
  getTeamPreflightConfig,
  calculatePreflightEstimate,
  evaluatePreflightThresholds,
  generateFingerprint,
  checkSimilarApproved,
  storeApprovedFingerprint,
  shouldSkipPreflight,
  invalidateTeamConfigCache,
  getCheaperFallback,
  createApprovalId
} from "./preflight.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, "config.json");
const PORT = Number(process.env.PORT || 3000);

const app = express();
const loopDetector = new LoopDetector();

// Middleware
app.use(express.json({ limit: "25mb" }));

// CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:3001'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Basic auth
const dashboardAuth = basicAuth({
  users: { [process.env.DASHBOARD_USER || "admin"]: process.env.DASHBOARD_PASS || "tokenguard" },
  challenge: true,
  realm: "TokenGuard Dashboard"
});
app.use("/dashboard", dashboardAuth);
app.use("/api", dashboardAuth);

// Rate limiter for approval decisions
const approvalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: { message: "Too many approval requests, please try again later." } }
});

// Config cache
let cachedConfig = null;
let configLastLoaded = 0;
const CONFIG_CACHE_TTL_MS = 60000;

function loadConfig() {
  const now = Date.now();
  if (cachedConfig && (now - configLastLoaded) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  configLastLoaded = now;
  return cachedConfig;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  cachedConfig = config;
  configLastLoaded = Date.now();
  invalidateTeamConfigCache();
}

function getProviderKey(providerName, config) {
  const envKey = `${providerName.toUpperCase()}_API_KEY`;
  if (process.env[envKey]) return process.env[envKey];
  const configKey = config.providers?.[providerName]?.apiKey;
  if (configKey && configKey !== `ENV_${envKey}`) return configKey;
  return null;
}

function hasConfiguredProvider(config, providerName) {
  const key = getProviderKey(providerName, config);
  return Boolean(key && !key.startsWith("YOUR_") && !key.startsWith("sk-fake"));
}

function getTeamBudget(config, team) {
  const teamConfig = config.teams[team] || config.teams.default || { monthlyBudget: 0 };
  return Number(teamConfig.monthlyBudget || 0);
}

function extractTeam(req) {
  return String(req.header("x-proxy-team") || req.header("x-tokenguard-team") || "default").trim() || "default";
}

function extractSession(req) {
  return req.header("x-tokenguard-session") || req.header("x-proxy-session") || null;
}

function redactPrompt(content, config) {
  if (config.privacy?.redact_prompts) {
    return crypto.createHash("sha256").update(content).digest("hex");
  }
  return content;
}

function validateRequest(req, providerName) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return "Request body must be a JSON object.";
  }
  if (!req.body.model || typeof req.body.model !== "string") {
    return "Request body must include a model string.";
  }
  if (!Array.isArray(req.body.messages)) {
    return "Request body must include a messages array.";
  }
  if (providerName === "anthropic" && !req.body.max_tokens && !req.body.stream) {
    return "Anthropic requests should include max_tokens.";
  }
  return null;
}

function providerHeaders(req, providerConfig, providerName) {
  const headers = {};
  const blockedHeaders = new Set([
    "authorization",
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "x-api-key"
  ]);
  for (const [name, value] of Object.entries(req.headers)) {
    if (!blockedHeaders.has(name.toLowerCase())) headers[name] = value;
  }
  headers["content-type"] = "application/json";
  if (providerName === "openai") {
    headers.authorization = `Bearer ${providerConfig.apiKey}`;
  } else {
    headers["x-api-key"] = providerConfig.apiKey;
    headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
  }
  return headers;
}

function copyProviderResponseHeaders(providerResponse, res) {
  providerResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!["content-encoding", "transfer-encoding", "content-length", "connection"].includes(lowerKey)) {
      res.setHeader(key, value);
    }
  });
}

function extractUsage(providerName, responseBody) {
  if (providerName === "openai") {
    return {
      inputTokens: Number(responseBody?.usage?.prompt_tokens || 0),
      outputTokens: Number(responseBody?.usage?.completion_tokens || 0)
    };
  }
  return {
    inputTokens: Number(responseBody?.usage?.input_tokens || 0),
    outputTokens: Number(responseBody?.usage?.output_tokens || 0)
  };
}

function sendJsonError(res, status, message) {
  return res.status(status).json({ error: { message } });
}

function buildBodyForModel(body, model) {
  return { ...body, model };
}

async function fetchProvider({ req, config, providerName, model, body }) {
  const apiKey = getProviderKey(providerName, config);
  if (!apiKey) throw new Error(`${providerName} API key is not configured`);
  console.log(`[TokenGuard] Forwarding to ${providerName}`, { model });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(providerUrl(providerName), {
      method: "POST",
      headers: providerHeaders(req, { apiKey }, providerName),
      body: JSON.stringify(buildBodyForModel(body, model)),
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function fetchJsonProvider({ req, config, providerName, model, body }) {
  const response = await fetchProvider({ req, config, providerName, model, body });
  const rawText = await response.text();
  let responseBody = null;
  try { responseBody = rawText ? JSON.parse(rawText) : {}; } catch { responseBody = null; }
  return { response, rawText, responseBody, providerName, model };
}

async function attemptJsonWithFallbacks({ req, config, initialProvider, initialModel, originalProvider, originalModel, body }) {
  const fallbackModels = buildFallbackModels({
    provider: initialProvider,
    actualModel: initialModel,
    originalModel,
    config
  });
  const attempts = [initialModel, ...fallbackModels];
  const failures = [];
  for (const model of attempts) {
    const providerName = providerForModel(model, initialProvider);
    if (!hasConfiguredProvider(config, providerName)) {
      failures.push(`${providerName}:${model}: missing API key`);
      continue;
    }
    try {
      const result = await fetchJsonProvider({ req, config, providerName, model, body });
      if (result.response.ok) {
        if (model !== initialModel) console.log(`[ROUTER] Multi-provider fallback - ${initialProvider} failed, trying ${providerName}`);
        return {
          ...result,
          multiProviderFallbackUsed: providerName !== initialProvider,
          fallbackReason: failures.length ? failures.join(" | ") : null,
          attemptedModel: model
        };
      }
      failures.push(`${providerName}:${model}: HTTP ${result.response.status}`);
      console.log(`[ROUTER] Fallback attempt failed - ${providerName} ${model} HTTP ${result.response.status}`);
    } catch (error) {
      failures.push(`${providerName}:${model}: ${error.message}`);
      console.log(`[ROUTER] Fallback attempt failed - ${providerName} ${model}: ${error.message}`);
    }
  }
  const originalProviderName = providerForModel(originalModel, originalProvider);
  if (hasConfiguredProvider(config, originalProviderName) && !attempts.includes(originalModel)) {
    return fetchJsonProvider({ req, config, providerName: originalProviderName, model: originalModel, body });
  }
  throw new Error(failures.join(" | ") || "all provider attempts failed");
}

async function retryForQuality({ req, config, currentModel, originalModel, providerName, body }) {
  const nextModel = equivalentOtherProviderModel(currentModel) && providerForModel(currentModel, providerName) !== "openai"
    ? "gpt-4o"
    : null;
  const fallbackModels = buildFallbackModels({
    provider: providerName,
    actualModel: currentModel,
    originalModel,
    config
  });
  const models = [...new Set([...(nextModel ? [nextModel] : []), ...fallbackModels])];
  for (const model of models) {
    const nextProvider = providerForModel(model, providerName);
    if (!hasConfiguredProvider(config, nextProvider)) continue;
    console.log(`[ROUTER] Quality fail - retrying with ${model}`);
    try {
      const result = await fetchJsonProvider({ req, config, providerName: nextProvider, model, body });
      if (result.response.ok) {
        return {
          ...result,
          qualityFallbackUsed: true,
          multiProviderFallbackUsed: nextProvider !== providerName,
          fallbackReason: `quality fallback from ${currentModel}`
        };
      }
    } catch (error) {
      console.log(`[ROUTER] Quality retry failed - ${nextProvider} ${model}: ${error.message}`);
    }
  }
  return null;
}

function baseRoutingLog({ team, sessionId, decision, startedAt, streamUsed }) {
  return {
    timestamp: new Date().toISOString(),
    team,
    sessionId,
    originalModel: decision.originalModel,
    actualModel: decision.actualModel,
    wasRouted: decision.wasRouted ? 1 : 0,
    routingReason: decision.routingReason,
    classificationTier: decision.classification?.tier || null,
    classificationConfidence: Number(decision.classification?.confidence || 0),
    isAgentic: decision.classification?.isAgentic ? 1 : 0,
    hasCode: decision.classification?.hasCode ? 1 : 0,
    inputTokensEstimated: Number(decision.estimatedInputTokens || 0),
    inputTokensActual: 0,
    outputTokensActual: 0,
    originalCostUsd: Number(decision.projected?.originalCostUsd || 0),
    actualCostUsd: Number(decision.projected?.actualCostUsd || 0),
    savingsUsd: Number(decision.projected?.savingsUsd || 0),
    qualityCheckPassed: 1,
    qualityFallbackUsed: 0,
    multiProviderFallbackUsed: 0,
    fallbackReason: null,
    cacheHit: decision.cacheHit ? 1 : 0,
    classificationDurationMs: Number(decision.classification?.durationMs || 0),
    totalRequestDurationMs: Date.now() - startedAt,
    streamUsed: streamUsed ? 1 : 0,
    preflightEnabled: 0,
    preflightOutcome: null,
    preflightEstimatedCostUsd: 0,
    preflightActualCostUsd: 0,
    preflightAccuracyPct: null,
    preflightDurationMs: 0
  };
}

function writeApiCall({ providerName, team, sessionId, model, usage, cost, durationMs, statusCode, success }) {
  logApiCall({
    timestamp: new Date().toISOString(),
    provider: providerName,
    team,
    sessionId,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: cost,
    baselineGpt4oCostUsd: calculateCost("gpt-4o", usage.inputTokens, usage.outputTokens),
    savingsUsd: Math.max(0, calculateCost("gpt-4o", usage.inputTokens, usage.outputTokens) - cost),
    durationMs,
    statusCode,
    success: success ? 1 : 0
  });
}

function applyProxyHeaders(res, decision, actualModel, savingsUsd, routingReason) {
  res.setHeader("x-proxy-model-used", actualModel);
  res.setHeader("x-proxy-original-model", decision.originalModel);
  res.setHeader("x-proxy-savings-usd", Number(savingsUsd || 0).toFixed(8));
  res.setHeader("x-proxy-routing-reason", routingReason);
}

async function waitForApproval(approvalId, approvalTimeoutMinutes, req, res, originalHandler) {
  const startTime = Date.now();
  const timeoutMs = approvalTimeoutMinutes * 60 * 1000;
  const pollInterval = 2000;
  while (Date.now() - startTime < timeoutMs) {
    if (req.socket.destroyed || res.writableEnded) {
      console.log(`[PREFLIGHT] Client disconnected while waiting for approval ${approvalId}`);
      return;
    }
    const approval = getPendingApproval(approvalId);
    if (!approval) return sendJsonError(res, 402, `Approval request ${approvalId} not found`);
    if (approval.status === "approved") {
      console.log(`[PREFLIGHT] Approval received for ${approvalId} — forwarding request`);
      return originalHandler();
    }
    if (approval.status === "rejected") {
      console.log(`[PREFLIGHT] Request rejected for ${approvalId}`);
      return sendJsonError(res, 402, `Request rejected: ${approval.rejection_reason || "No reason provided"}`);
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  console.log(`[PREFLIGHT] Timeout waiting for approval ${approvalId} — returning 402`);
  updateApprovalStatus(approvalId, "timeout", "system", "Approval timeout exceeded");
  return sendJsonError(res, 402, `Approval timeout after ${approvalTimeoutMinutes} minutes`);
}

async function handleStreaming({ req, res, config, decision, team, sessionId, startedAt, monthlyBudget, preflightData }) {
  const providerName = providerForModel(decision.actualModel, decision.actualProvider);
  const response = await fetchProvider({ req, config, providerName, model: decision.actualModel, body: { ...req.body, stream: true } });
  if (!response.ok) {
    const fallbackResult = await attemptJsonWithFallbacks({
      req, config, initialProvider: providerName, initialModel: decision.actualModel,
      originalProvider: providerName, originalModel: decision.originalModel,
      body: { ...req.body, stream: false }
    });
    return sendNormalResponse({
      req, res, config, result: fallbackResult, decision, team, sessionId, startedAt, monthlyBudget,
      qualityFallbackUsed: false, multiProviderFallbackUsed: true,
      fallbackReason: `streaming initial HTTP ${response.status}`, preflightData
    });
  }
  copyProviderResponseHeaders(response, res);
  applyProxyHeaders(res, decision, decision.actualModel, decision.projected.savingsUsd, decision.routingReason);
  if (preflightData && preflightData.outcome === "warn") res.setHeader("x-preflight-warning", `estimated-cost-${preflightData.estimatedCostUsd.toFixed(4)}`);
  if (preflightData && preflightData.autoApproved) res.setHeader("x-preflight-auto-approved", "true");
  res.status(response.status);
  const routingLog = baseRoutingLog({ team, sessionId, decision, startedAt, streamUsed: true });
  if (preflightData) {
    routingLog.preflightEnabled = 1;
    routingLog.preflightOutcome = preflightData.outcome;
    routingLog.preflightEstimatedCostUsd = preflightData.estimatedCostUsd;
    routingLog.preflightDurationMs = preflightData.durationMs;
  }
  try {
    for await (const chunk of response.body) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
    res.end();
    routingLog.totalRequestDurationMs = Date.now() - startedAt;
    logRoutingDecision(routingLog);
    loopDetector.markSuccess(sessionId);
    console.log("[ROUTER] Total request time:", `${routingLog.totalRequestDurationMs}ms`);
  } catch (error) {
    console.log(`[ROUTER] Streaming failed mid-stream: ${error.message}`);
    routingLog.qualityCheckPassed = 0;
    routingLog.fallbackReason = `streaming failed mid-stream: ${error.message}`;
    routingLog.totalRequestDurationMs = Date.now() - startedAt;
    logRoutingDecision(routingLog);
    if (!res.headersSent) sendJsonError(res, 502, "TokenGuard: Provider stream failed.");
    else res.end();
  }
}

async function sendNormalResponse({
  req, res, config, result, decision, team, sessionId, startedAt, monthlyBudget,
  qualityFallbackUsed = false, multiProviderFallbackUsed = false, fallbackReason = null, preflightData = null
}) {
  const durationMs = Date.now() - startedAt;
  const model = result.responseBody?.model || result.model;
  const usage = result.responseBody ? extractUsage(result.providerName, result.responseBody) : {
    inputTokens: decision.estimatedInputTokens,
    outputTokens: 0
  };
  const actualCostUsd = calculateCost(model, usage.inputTokens, usage.outputTokens);
  const originalCostUsd = calculateCost(decision.originalModel, usage.inputTokens, usage.outputTokens);
  const savingsUsd = Number(Math.max(0, originalCostUsd - actualCostUsd).toFixed(8));
  let finalResult = result;
  let quality = { passed: true, reason: "skipped" };
  let qualityFallback = qualityFallbackUsed;
  let providerFallback = multiProviderFallbackUsed || Boolean(result.multiProviderFallbackUsed);
  let finalFallbackReason = fallbackReason || result.fallbackReason || null;
  const routeConfig = routingConfig(config);
  if (routeConfig.quality_check_enabled && result.response.ok && result.responseBody && !req.body.stream) {
    quality = checkQuality({
      provider: result.providerName,
      body: req.body,
      responseBody: result.responseBody,
      classification: decision.classification
    });
    console.log(`[ROUTER] Response received - quality check: ${quality.passed ? "passed" : "failed"}`);
    if (!quality.passed && routeConfig.auto_retry_on_quality_fail) {
      const retry = await retryForQuality({
        req, config, currentModel: model, originalModel: decision.originalModel,
        providerName: result.providerName, body: req.body
      });
      if (retry) {
        finalResult = retry;
        qualityFallback = true;
        providerFallback = providerFallback || Boolean(retry.multiProviderFallbackUsed);
        finalFallbackReason = retry.fallbackReason || quality.reason;
      } else if (model !== decision.originalModel) {
        const originalProvider = providerForModel(decision.originalModel, result.providerName);
        try {
          console.log(`[ROUTER] Quality fail - retrying with original model ${decision.originalModel}`);
          const originalRetry = await fetchJsonProvider({
            req, config, providerName: originalProvider, model: decision.originalModel, body: req.body
          });
          if (originalRetry.response.ok) {
            finalResult = originalRetry;
            qualityFallback = true;
            providerFallback = providerFallback || originalProvider !== result.providerName;
            finalFallbackReason = `quality fallback to original: ${quality.reason}`;
          }
        } catch (error) {
          console.log(`[ROUTER] Quality fallback to original failed: ${error.message}`);
        }
      }
    }
  }
  const finalModel = finalResult.responseBody?.model || finalResult.model;
  const finalUsage = finalResult.responseBody ? extractUsage(finalResult.providerName, finalResult.responseBody) : usage;
  const finalActualCostUsd = calculateCost(finalModel, finalUsage.inputTokens, finalUsage.outputTokens);
  const finalOriginalCostUsd = calculateCost(decision.originalModel, finalUsage.inputTokens, finalUsage.outputTokens);
  const finalSavingsUsd = Number(Math.max(0, finalOriginalCostUsd - finalActualCostUsd).toFixed(8));
  writeApiCall({
    providerName: finalResult.providerName, team, sessionId, model: finalModel,
    usage: finalUsage, cost: finalActualCostUsd, durationMs,
    statusCode: finalResult.response.status, success: finalResult.response.ok
  });
  if (finalResult.response.ok) loopDetector.markSuccess(sessionId);
  const spendAfterCall = getMonthlySpend(team);
  if (monthlyBudget > 0 && spendAfterCall >= monthlyBudget * 0.8) res.setHeader("x-tokenguard-warning", "budget-80-percent");
  if (qualityFallback) res.setHeader("x-proxy-quality-fallback", "true");
  applyProxyHeaders(res, decision, finalModel, finalSavingsUsd, decision.routingReason);
  if (preflightData) {
    res.setHeader("x-preflight-estimated-cost", preflightData.estimatedCostUsd.toFixed(6));
    if (preflightData.outcome === "warn") res.setHeader("x-preflight-warning", `estimated-cost-${preflightData.estimatedCostUsd.toFixed(4)}`);
    if (preflightData.autoApproved) res.setHeader("x-preflight-auto-approved", "true");
  }
  copyProviderResponseHeaders(finalResult.response, res);
  res.status(finalResult.response.status);
  const routingLog = {
    ...baseRoutingLog({ team, sessionId, decision, startedAt, streamUsed: false }),
    actualModel: finalModel,
    inputTokensActual: finalUsage.inputTokens,
    outputTokensActual: finalUsage.outputTokens,
    originalCostUsd: finalOriginalCostUsd,
    actualCostUsd: finalActualCostUsd,
    savingsUsd: finalSavingsUsd,
    qualityCheckPassed: quality.passed ? 1 : 0,
    qualityFallbackUsed: qualityFallback ? 1 : 0,
    multiProviderFallbackUsed: providerFallback ? 1 : 0,
    fallbackReason: finalFallbackReason,
    totalRequestDurationMs: Date.now() - startedAt,
    preflightEnabled: preflightData ? 1 : 0,
    preflightOutcome: preflightData?.outcome || null,
    preflightEstimatedCostUsd: preflightData?.estimatedCostUsd || 0,
    preflightActualCostUsd: finalActualCostUsd,
    preflightAccuracyPct: preflightData ? (preflightData.estimatedCostUsd > 0 ? (1 - Math.abs(finalActualCostUsd - preflightData.estimatedCostUsd) / preflightData.estimatedCostUsd) * 100 : null) : null,
    preflightDurationMs: preflightData?.durationMs || 0
  };
  logRoutingDecision(routingLog);
  if (preflightData?.approvalId) {
    const accuracy = preflightData.estimatedCostUsd > 0 ? (1 - Math.abs(finalActualCostUsd - preflightData.estimatedCostUsd) / preflightData.estimatedCostUsd) >= 0.7 : false;
    updateApprovalAccuracy(preflightData.approvalId, finalActualCostUsd, accuracy ? 1 : 0);
  }
  console.log("[ROUTER] Total request time:", `${routingLog.totalRequestDurationMs}ms`);
  if (finalResult.responseBody) return res.json(finalResult.responseBody);
  return res.send(finalResult.rawText);
}

async function proxyRequest(req, res, providerName) {
  const startedAt = Date.now();
  const config = loadConfig();
  const team = extractTeam(req);
  const sessionId = extractSession(req);
  const validationError = validateRequest(req, providerName);
  if (validationError) return sendJsonError(res, 400, validationError);
  console.log(`[ROUTER] Analyzing request - team: ${team}, session: ${sessionId || "none"}`);

  // Business context headers
  const triggerSource = req.header("x-tokenguard-trigger") || null;
  const businessObject = req.header("x-tokenguard-object") || null;
  const expectedOutcome = req.header("x-tokenguard-expected-outcome") || null;

  const originalModel = req.body.model;
  const monthlyBudget = getTeamBudget(config, team);
  const currentSpend = getMonthlySpend(team);

  // 1. Budget check
  if (monthlyBudget > 0 && currentSpend >= monthlyBudget) {
    console.log(`[TokenGuard] Budget block for team ${team}: $${currentSpend.toFixed(4)} / $${monthlyBudget}.`);
    logBlockedBudget({
      timestamp: new Date().toISOString(), team, monthlyBudgetUsd: monthlyBudget,
      currentSpendUsd: currentSpend, reason: "monthly_budget_exceeded"
    });
    return sendJsonError(res, 402, "TokenGuard: Monthly budget exceeded for this team.");
  }

  // 2. Loop detection
  const loopCheck = loopDetector.registerRequest(sessionId);
  if (loopCheck.blocked) {
    console.log(`[TokenGuard] Loop block for session ${sessionId}.`);
    logBlockedLoop({
      timestamp: new Date().toISOString(), team, sessionId,
      reason: "potential_agent_loop", requestCount: loopCheck.requestCount
    });
    return sendJsonError(res, 429, "TokenGuard: Potential agent loop detected. Request blocked to prevent cost overrun.");
  }

  // 3. Routing decision
  let decision;
  try {
    decision = analyzeRouting({ provider: providerName, body: req.body, headers: req.headers, config });
  } catch (error) {
    console.log(`[ROUTER] Routing analysis failed - using original model: ${error.message}`);
    decision = {
      originalModel, actualModel: originalModel, actualProvider: providerName, wasRouted: false,
      routingReason: "routing analysis failed",
      classification: { tier: null, confidence: 0, isAgentic: false, hasCode: false, durationMs: 0 },
      projected: { originalCostUsd: 0, actualCostUsd: 0, savingsUsd: 0 },
      cacheHit: false, estimatedInputTokens: 0, estimatedOutputTokens: 0
    };
  }
  console.log(`[ROUTER] Classification: ${decision.classification?.tier || "unknown"}, has_code: ${Boolean(decision.classification?.hasCode)}, is_agentic: ${Boolean(decision.classification?.isAgentic)}, confidence: ${Number(decision.classification?.confidence || 0).toFixed(2)} (${decision.classification?.durationMs || 0}ms)`);
  console.log(`[ROUTER] Decision: ${decision.wasRouted ? `routing ${decision.originalModel} -> ${decision.actualModel}` : `keeping ${decision.originalModel}`} - reason: ${decision.routingReason}`);
  console.log(`[ROUTER] Estimated savings: $${Number(decision.projected?.savingsUsd || 0).toFixed(4)}`);

  // 4. Pre‑flight estimation with business context
  const skipPreflight = shouldSkipPreflight(req.headers);
  const teamPreflightConfig = getTeamPreflightConfig(config, team);
  let preflightData = null;
  let approvalId = null;
  let approvalToken = null;

  if (!skipPreflight && teamPreflightConfig.enabled) {
    // Pass headers as a separate object to calculatePreflightEstimate
    const estimate = calculatePreflightEstimate({
      body: req.body,
      provider: providerName,
      model: originalModel,
      sessionId,
      sessionHistory: null,
      loopDetector,
      teamConfig: teamPreflightConfig,
      headers: { "x-tokenguard-trigger": triggerSource, "x-tokenguard-object": businessObject, "x-tokenguard-expected-outcome": expectedOutcome }
    });
    if (estimate.success) {
      const evaluation = evaluatePreflightThresholds(estimate, teamPreflightConfig);
      console.log(`[PREFLIGHT] Estimating cost for team: ${team}, model: ${originalModel}`);
      console.log(`[PREFLIGHT] Estimated: $${estimate.estimatedCostUsd} input: ${estimate.estimatedInputTokens} tokens, output: ${estimate.estimatedOutputTokens} tokens (took ${estimate.durationMs}ms)`);
      if (estimate.agenticDetected) console.log(`[PREFLIGHT] Agentic call detected — applying ${estimate.agenticMultiplierApplied}x chain multiplier — revised estimate: $${estimate.estimatedCostUsd}`);
      if (evaluation.outcome === "block") {
        console.log(`[PREFLIGHT] Estimated: $${estimate.estimatedCostUsd} — BLOCK — above threshold of $${evaluation.effectiveBlockThreshold} for team: ${team}`);
        const fingerprint = generateFingerprint(req.body, team, originalModel);
        const similarApproved = checkSimilarApproved(fingerprint);
        if (similarApproved && teamPreflightConfig.auto_approve_if_similar_approved) {
          console.log(`[PREFLIGHT] Auto-approved — fingerprint match found from ${Math.floor((Date.now() - similarApproved.timestamp) / 60000)} minutes ago`);
          preflightData = {
            outcome: "pass", estimatedCostUsd: estimate.estimatedCostUsd, estimatedInputTokens: estimate.estimatedInputTokens,
            estimatedOutputTokens: estimate.estimatedOutputTokens, agenticDetected: estimate.agenticDetected,
            agenticMultiplierApplied: estimate.agenticMultiplierApplied, durationMs: estimate.durationMs, autoApproved: true
          };
        } else {
          approvalId = createApprovalId();
          approvalToken = crypto.randomBytes(32).toString("hex");
          let requestSummary = req.body.messages.filter(m => m.role === "user").slice(-1)[0]?.content?.slice(0, 200) || "No user message found";
          requestSummary = redactPrompt(requestSummary, config);
          createPendingApproval({
            id: approvalId, token: approvalToken, timestamp: new Date().toISOString(), team,
            sessionId: sessionId || null, estimatedCostUsd: estimate.estimatedCostUsd,
            estimatedInputTokens: estimate.estimatedInputTokens, estimatedOutputTokens: estimate.estimatedOutputTokens,
            modelRequested: originalModel, agenticDetected: estimate.agenticDetected ? 1 : 0,
            agenticMultiplierApplied: estimate.agenticMultiplierApplied, requestSummary, status: "pending",
            triggerSource: estimate.triggerSource, businessObject: estimate.businessObject, expectedOutcome: estimate.expectedOutcome
          });
          console.log(`[PREFLIGHT] Approval request created: ${approvalId} — holding connection`);
          const originalHandler = async () => {
            const finalEstimate = calculatePreflightEstimate({
              body: req.body, provider: providerName, model: originalModel, sessionId,
              sessionHistory: null, loopDetector, teamConfig: teamPreflightConfig,
              headers: { "x-tokenguard-trigger": triggerSource, "x-tokenguard-object": businessObject, "x-tokenguard-expected-outcome": expectedOutcome }
            });
            return completeRequest(req, res, providerName, config, team, sessionId, startedAt, monthlyBudget, decision, {
              ...finalEstimate, outcome: "approved", approvalId,
              estimatedCostUsd: finalEstimate.estimatedCostUsd, estimatedInputTokens: finalEstimate.estimatedInputTokens,
              estimatedOutputTokens: finalEstimate.estimatedOutputTokens, agenticDetected: finalEstimate.agenticDetected,
              agenticMultiplierApplied: finalEstimate.agenticMultiplierApplied, durationMs: finalEstimate.durationMs,
              cheaperFallback: finalEstimate.cheaperFallback
            });
          };
          return waitForApproval(approvalId, teamPreflightConfig.approval_timeout_minutes, req, res, originalHandler);
        }
      } else if (evaluation.outcome === "warn") {
        console.log(`[PREFLIGHT] Estimated: $${estimate.estimatedCostUsd} — WARN — above threshold of $${teamPreflightConfig.warn_above_usd} for team: ${team}`);
        preflightData = {
          outcome: "warn", estimatedCostUsd: estimate.estimatedCostUsd, estimatedInputTokens: estimate.estimatedInputTokens,
          estimatedOutputTokens: estimate.estimatedOutputTokens, agenticDetected: estimate.agenticDetected,
          agenticMultiplierApplied: estimate.agenticMultiplierApplied, durationMs: estimate.durationMs,
          cheaperFallback: estimate.cheaperFallback
        };
      } else {
        console.log(`[PREFLIGHT] Estimated: $${estimate.estimatedCostUsd} — PASS — below warn threshold of $${teamPreflightConfig.warn_above_usd}`);
        preflightData = {
          outcome: "pass", estimatedCostUsd: estimate.estimatedCostUsd, estimatedInputTokens: estimate.estimatedInputTokens,
          estimatedOutputTokens: estimate.estimatedOutputTokens, agenticDetected: estimate.agenticDetected,
          agenticMultiplierApplied: estimate.agenticMultiplierApplied, durationMs: estimate.durationMs,
          cheaperFallback: estimate.cheaperFallback
        };
      }
    } else {
      console.error(`[PREFLIGHT] Estimation failed: ${estimate.error} — allowing call to proceed`);
      preflightData = { outcome: "skipped", error: estimate.error };
    }
  } else {
    preflightData = { outcome: "skipped", reason: skipPreflight ? "header override" : "preflight disabled" };
  }

  // 5. Provider forward
  return completeRequest(req, res, providerName, config, team, sessionId, startedAt, monthlyBudget, decision, preflightData);
}

async function completeRequest(req, res, providerName, config, team, sessionId, startedAt, monthlyBudget, decision, preflightData) {
  const streamUsed = req.body.stream === true;
  try {
    if (streamUsed) {
      return await handleStreaming({ req, res, config, decision, team, sessionId, startedAt, monthlyBudget, preflightData });
    }
    const result = await attemptJsonWithFallbacks({
      req, config, initialProvider: decision.actualProvider, initialModel: decision.actualModel,
      originalProvider: providerName, originalModel: decision.originalModel, body: req.body
    });
    return await sendNormalResponse({
      req, res, config, result, decision, team, sessionId, startedAt, monthlyBudget, preflightData
    });
  } catch (error) {
    console.error(`[TokenGuard] Provider forwarding failed: ${error.message}`);
    try {
      const originalProvider = providerForModel(decision.originalModel, providerName);
      const originalResult = await fetchJsonProvider({
        req, config, providerName: originalProvider, model: decision.originalModel, body: req.body
      });
      return await sendNormalResponse({
        req, res, config, result: originalResult,
        decision: { ...decision, actualModel: decision.originalModel, wasRouted: false, routingReason: "fallback to original after routing failure" },
        team, sessionId, startedAt, monthlyBudget, multiProviderFallbackUsed: false, fallbackReason: error.message, preflightData
      });
    } catch (originalError) {
      console.error(`[TokenGuard] Original provider fallback failed: ${originalError.message}`);
      return sendJsonError(res, 502, `TokenGuard: Provider request failed. ${originalError.message}`);
    }
  }
}

// ========== API ENDPOINTS ==========
app.post("/v1/chat/completions", (req, res) => { proxyRequest(req, res, "openai"); });
app.post("/v1/messages", (req, res) => { proxyRequest(req, res, "anthropic"); });

// Approval page (with business context and cheaper fallback)
app.get("/approve/:id", (req, res) => {
  const { id } = req.params;
  const { token } = req.query;
  const approval = getPendingApproval(id);
  if (!approval) {
    return res.status(404).send(`<!DOCTYPE html><html><head><title>Approval Not Found</title></head><body style="font-family: system-ui; text-align: center; padding: 50px;"><h1>❌ Approval Not Found</h1><p>This approval request does not exist or has been removed.</p></body></html>`);
  }
  if (approval.token !== token) {
    logApprovalAudit(approval.id, 'unauthorized_view', req.ip, req.headers['user-agent']);
    return res.status(403).send(`<!DOCTYPE html><html><head><title>Unauthorized</title></head><body style="font-family: system-ui; text-align: center; padding: 50px;"><h1>🔒 Unauthorized</h1><p>Invalid approval link. Please check the URL.</p></body></html>`);
  }
  logApprovalAudit(approval.id, 'view', req.ip, req.headers['user-agent']);
  const isExpired = approval.status !== "pending";
  // Compute cheaper fallback if not already present (we can compute from approval data)
  let cheaperFallbackHtml = '';
  // For simplicity, we can compute a cheaper alternative using the same logic as preflight
  // We'll just show a message if no context; but we can also call a helper
  // We'll add a button that, when clicked, redirects to a new approval with the cheaper model
  if (approval.estimated_cost_usd > 0.001) {
    cheaperFallbackHtml = `<div class="info-row"><span class="info-label">Cheaper alternative</span><span class="info-value"><button id="cheaperBtn" class="btn" style="background: #6c757d;">Use cheaper model (est. $0.00)</button></span></div>`;
  }
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Approve Request - TokenGuard</title><style>:root{--bg:#f6f7f9;--panel:#fff;--ink:#17202a;--muted:#667085;--line:#d8dee8;--success:#10b981;--error:#ef4444;--warning:#f59e0b;}*{box-sizing:border-box;}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--ink);padding:20px;}.container{max-width:700px;margin:0 auto;}.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:32px;margin-bottom:20px;}h1{margin:0 0 8px;font-size:28px;}.cost{font-size:48px;font-weight:700;color:var(--warning);margin:20px 0;}.info-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--line);}.info-label{color:var(--muted);font-weight:500;}.info-value{font-weight:600;}.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;}.badge-agentic{background:#fef3c7;color:#92400e;}.button-group{display:flex;gap:16px;margin-top:32px;}.btn{flex:1;padding:14px 24px;font-size:16px;font-weight:600;border:none;border-radius:12px;cursor:pointer;}.btn-approve{background:var(--success);color:white;}.btn-approve:hover{background:#059669;}.btn-reject{background:var(--error);color:white;}.btn-reject:hover{background:#dc2626;}.rejection-reason{margin-top:16px;display:none;}.rejection-reason textarea{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;font-family:inherit;resize:vertical;}.status-badge{display:inline-block;padding:8px 16px;border-radius:8px;font-weight:600;margin-bottom:20px;}.status-pending{background:#fef3c7;color:#92400e;}.status-approved{background:#d1fae5;color:#065f46;}.status-rejected{background:#fee2e2;color:#991b1b;}.status-timeout{background:#f3f4f6;color:#374151;}.countdown{font-size:14px;color:var(--muted);margin-top:16px;}</style></head><body><div class="container"><div class="card"><h1>💰 Request Approval Required</h1><p>A request from <strong>${escapeHtml(approval.team)}</strong> needs your approval before it can proceed.</p><div class="cost">$${approval.estimated_cost_usd.toFixed(4)}</div><div class="info-row"><span class="info-label">Model</span><span class="info-value">${escapeHtml(approval.model_requested)}</span></div><div class="info-row"><span class="info-label">Estimated Input Tokens</span><span class="info-value">${approval.estimated_input_tokens.toLocaleString()}</span></div><div class="info-row"><span class="info-label">Estimated Output Tokens</span><span class="info-value">${approval.estimated_output_tokens.toLocaleString()}</span></div>${approval.trigger_source ? `<div class="info-row"><span class="info-label">Trigger</span><span class="info-value">${escapeHtml(approval.trigger_source)}</span></div>` : ''}${approval.business_object ? `<div class="info-row"><span class="info-label">Business object</span><span class="info-value">${escapeHtml(approval.business_object)}</span></div>` : ''}${approval.expected_outcome ? `<div class="info-row"><span class="info-label">Expected outcome</span><span class="info-value">${escapeHtml(approval.expected_outcome)}</span></div>` : ''}${cheaperFallbackHtml}<div class="info-row"><span class="info-label">Agentic Detected</span><span class="info-value">${approval.agentic_detected ? '<span class="badge badge-agentic">Yes</span>' : 'No'}</span></div><div class="info-row"><span class="info-label">Session ID</span><span class="info-value">${escapeHtml(approval.session_id || 'N/A')}</span></div><div class="info-row"><span class="info-label">Request Summary</span><span class="info-value">${escapeHtml(approval.request_summary || 'N/A')}</span></div><div id="statusContainer">${isExpired ? `<div class="status-badge status-${approval.status}">${approval.status.toUpperCase()}${approval.status === 'rejected' ? `: ${escapeHtml(approval.rejection_reason || 'No reason provided')}` : ''}</div>` : `<div id="approvalButtons"><div class="button-group"><button class="btn btn-approve" onclick="submitDecision('approved')">✅ Approve Request</button><button class="btn btn-reject" onclick="showRejectReason()">❌ Reject Request</button></div><div id="rejectReason" class="rejection-reason"><label>Reason for rejection (optional):</label><textarea id="rejectionText" rows="3" placeholder="Why is this request being rejected?"></textarea><div class="button-group" style="margin-top:12px;"><button class="btn btn-reject" onclick="submitDecision('rejected')">Confirm Rejection</button><button class="btn" onclick="hideRejectReason()" style="background:var(--line);">Cancel</button></div></div></div><div class="countdown" id="countdown"></div>`}</div></div></div><script>const approvalId="${req.params.id}";const approvalToken="${token}";let countdownInterval=null;function updateCountdown(){fetch("/api/pending-approvals").then(r=>r.json()).then(data=>{const approval=data.pending.find(a=>a.id===approvalId);if(!approval){location.reload();return;}const remaining=approval.remaining_ms;if(remaining<=0){location.reload();return;}const seconds=Math.ceil(remaining/1000);document.getElementById("countdown").textContent=\`⏱️ Auto-rejects in \${seconds} seconds\`;});}function showRejectReason(){document.getElementById("rejectReason").style.display="block";document.getElementById("approvalButtons").style.opacity="0.5";}function hideRejectReason(){document.getElementById("rejectReason").style.display="none";document.getElementById("approvalButtons").style.opacity="1";}async function submitDecision(decision){const body={decision,token:approvalToken};if(decision==="rejected"){const reason=document.getElementById("rejectionText").value;if(reason)body.reason=reason;}const response=await fetch("/approve/"+approvalId+"/decision",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(response.ok){location.reload();}else{const error=await response.json();alert("Failed to submit decision: "+(error.error?.message||"Unknown error"));}}document.getElementById("cheaperBtn")?.addEventListener("click",async()=>{const fallbackRes=await fetch("/approve/"+approvalId+"/fallback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:approvalToken})});if(fallbackRes.ok){location.reload();}else{alert("Failed to switch to cheaper model.");}});if(!${isExpired}){updateCountdown();countdownInterval=setInterval(updateCountdown,1000);setInterval(()=>location.reload(),5000);}</script></body></html>`);
});

// New endpoint: switch to cheaper fallback
app.post("/approve/:id/fallback", approvalLimiter, (req, res) => {
  const { id } = req.params;
  const { token } = req.body;
  const approval = getPendingApproval(id);
  if (!approval) return res.status(404).json({ error: { message: "Approval not found" } });
  if (approval.token !== token) return res.status(403).json({ error: { message: "Invalid token" } });
  if (approval.status !== "pending") return res.status(400).json({ error: { message: `Approval already ${approval.status}` } });
  // Compute cheaper fallback model (re-use logic from preflight)
  const config = loadConfig();
  const teamConfig = config.teams[approval.team] || config.teams.default;
  const provider = providerForModel(approval.model_requested, "openai");
  const estimate = { estimatedInputTokens: approval.estimated_input_tokens, estimatedOutputTokens: approval.estimated_output_tokens, estimatedCostUsd: approval.estimated_cost_usd };
  const fallback = getCheaperFallback(approval.model_requested, estimate, provider, { tier: "unknown" });
  if (!fallback) return res.status(400).json({ error: { message: "No cheaper alternative available" } });
  // Create a new pending approval for the fallback model (or update existing)
  const newId = `apr_${crypto.randomBytes(9).toString("hex")}`;
  const newToken = crypto.randomBytes(32).toString("hex");
  createPendingApproval({
    id: newId, token: newToken, timestamp: new Date().toISOString(), team: approval.team,
    sessionId: approval.session_id, estimatedCostUsd: fallback.cost, estimatedInputTokens: approval.estimated_input_tokens,
    estimatedOutputTokens: approval.estimated_output_tokens, modelRequested: fallback.model,
    agenticDetected: approval.agentic_detected, agenticMultiplierApplied: approval.agentic_multiplier_applied,
    requestSummary: approval.request_summary, status: "pending",
    triggerSource: approval.trigger_source, businessObject: approval.business_object, expectedOutcome: approval.expected_outcome
  });
  // Optionally reject the original approval
  updateApprovalStatus(id, "rejected", "system", "Switched to cheaper fallback");
  res.json({ success: true, new_approval_id: newId, new_approval_url: `/approve/${newId}?token=${newToken}` });
});

// Decision endpoint
app.post("/approve/:id/decision", approvalLimiter, (req, res) => {
  const { id } = req.params;
  const { token, decision, reason } = req.body;
  const approval = getPendingApproval(id);
  if (!approval) return res.status(404).json({ error: { message: "Approval not found" } });
  if (approval.token !== token) {
    logApprovalAudit(approval.id, 'unauthorized_decision', req.ip, req.headers['user-agent']);
    return res.status(403).json({ error: { message: "Invalid approval token" } });
  }
  if (approval.status !== "pending") {
    logApprovalAudit(approval.id, `decision_${decision}_ignored`, req.ip, req.headers['user-agent']);
    return res.status(400).json({ error: { message: `Approval already ${approval.status}` } });
  }
  if (decision !== "approved" && decision !== "rejected") {
    return res.status(400).json({ error: { message: "Decision must be 'approved' or 'rejected'" } });
  }
  logApprovalAudit(approval.id, `decision_${decision}`, req.ip, req.headers['user-agent']);
  const resolvedBy = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  updateApprovalStatus(id, decision, resolvedBy, reason || null);
  if (decision === "approved") {
    const config = loadConfig();
    const teamConfig = config.teams[approval.team] || config.teams.default;
    if (teamConfig?.preflight?.auto_approve_if_similar_approved) {
      const fingerprint = generateFingerprint(
        { messages: [{ role: "user", content: approval.request_summary || "" }] },
        approval.team, approval.model_requested
      );
      storeApprovedFingerprint(fingerprint);
    }
  }
  res.json({ success: true, status: decision });
});

// Retrospective endpoints
app.get("/api/retrospective", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const approvals = getApprovalsForRetrospective(limit);
  res.json({ approvals });
});

app.post("/api/approval-outcome", (req, res) => {
  const { approval_id, actual_outcome, was_reused, artifact_link, tag, notes } = req.body;
  if (!approval_id) return res.status(400).json({ error: { message: "approval_id required" } });
  updateApprovalOutcome(approval_id, actual_outcome, was_reused, artifact_link);
  if (tag && (tag === "valuable" || tag === "waste")) {
    addOutcomeTag(approval_id, tag, notes);
  }
  res.json({ success: true });
});

// Dashboard and stats endpoints (unchanged)
app.get("/api/dashboard", (req, res) => { res.json(getDashboardData(100)); });
app.get("/api/routing-stats", (req, res) => { res.json(getRoutingStats()); });
app.get("/api/routing-logs", (req, res) => { res.json({ logs: getRoutingLogs({ limit: req.query.limit, offset: req.query.offset }) }); });
app.get("/api/routing-config", (req, res) => { res.json(routingConfig(loadConfig())); });
app.post("/api/routing-config", (req, res) => { const config = loadConfig(); config.routing = { ...routingConfig(config), ...(req.body || {}) }; saveConfig(config); res.json(config.routing); });
app.get("/api/pending-approvals", (req, res) => {
  const pending = getAllPendingApprovalsList();
  const now = Date.now();
  const config = loadConfig();
  const enriched = pending.map(p => {
    const teamConfig = config.teams[p.team] || config.teams.default;
    const timeoutMinutes = teamConfig?.preflight?.approval_timeout_minutes || 10;
    const createdAt = new Date(p.timestamp).getTime();
    const remainingMs = Math.max(0, createdAt + (timeoutMinutes * 60 * 1000) - now);
    return { ...p, remaining_ms: remainingMs };
  });
  res.json({ pending: enriched });
});
app.get("/api/approval-stats", (req, res) => { const stats = getApprovalStatsSummary(); const recent = getRecentApprovalsList(); res.json({ stats, recent }); });
app.get("/api/savings-breakdown", (req, res) => {
  const baseline = req.query.baseline || "gpt-4o";
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
  const breakdown = getSavingsBreakdown(baseline, startOfMonth, endOfMonth);
  res.json(breakdown);
});
app.get("/dashboard", (req, res) => {
 res.sendFile(path.join(__dirname, "dashboard.html"));
 });
app.get("/health", (req, res) => { res.json({ ok: true, service: "tokenguard" }); });

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/[&<>]/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" })[m]);
}

// Data retention cron
function scheduleDataRetention() {
  const retentionDays = 90;
  setTimeout(() => {
    deleteOldLogs(retentionDays);
    setInterval(() => deleteOldLogs(retentionDays), 7 * 24 * 60 * 60 * 1000);
  }, 10 * 1000);
}
scheduleDataRetention();

process.on("SIGTERM", () => { console.log("[TokenGuard] SIGTERM received, shutting down gracefully..."); process.exit(0); });
process.on("SIGINT", () => { console.log("[TokenGuard] SIGINT received, shutting down gracefully..."); process.exit(0); });

app.listen(PORT, () => {
  console.log(`[TokenGuard] Proxy server listening on http://localhost:${PORT}`);
  console.log(`[TokenGuard] Dashboard available at http://localhost:${PORT}/dashboard`);
});