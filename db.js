import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { calculateCost } from "./pricing.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const db = new Database(path.join(__dirname, "tokenguard.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    provider TEXT NOT NULL,
    team TEXT NOT NULL,
    session_id TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    baseline_gpt4o_cost_usd REAL NOT NULL DEFAULT 0,
    savings_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    status_code INTEGER NOT NULL,
    success INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS blocked_loops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    team TEXT NOT NULL,
    session_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    request_count INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blocked_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    team TEXT NOT NULL,
    monthly_budget_usd REAL NOT NULL,
    current_spend_usd REAL NOT NULL,
    reason TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS routing_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    team TEXT NOT NULL,
    session_id TEXT,
    original_model TEXT NOT NULL,
    actual_model TEXT NOT NULL,
    was_routed INTEGER NOT NULL DEFAULT 0,
    routing_reason TEXT NOT NULL,
    classification_tier TEXT,
    classification_confidence REAL NOT NULL DEFAULT 0,
    is_agentic INTEGER NOT NULL DEFAULT 0,
    has_code INTEGER NOT NULL DEFAULT 0,
    input_tokens_estimated INTEGER NOT NULL DEFAULT 0,
    input_tokens_actual INTEGER NOT NULL DEFAULT 0,
    output_tokens_actual INTEGER NOT NULL DEFAULT 0,
    original_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    savings_usd REAL NOT NULL DEFAULT 0,
    quality_check_passed INTEGER NOT NULL DEFAULT 1,
    quality_fallback_used INTEGER NOT NULL DEFAULT 0,
    multi_provider_fallback_used INTEGER NOT NULL DEFAULT 0,
    fallback_reason TEXT,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    classification_duration_ms INTEGER NOT NULL DEFAULT 0,
    total_request_duration_ms INTEGER NOT NULL DEFAULT 0,
    stream_used INTEGER NOT NULL DEFAULT 0,
    preflight_enabled INTEGER NOT NULL DEFAULT 0,
    preflight_outcome TEXT,
    preflight_estimated_cost_usd REAL NOT NULL DEFAULT 0,
    preflight_actual_cost_usd REAL NOT NULL DEFAULT 0,
    preflight_accuracy_pct REAL,
    preflight_duration_ms INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pending_approvals (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    team TEXT NOT NULL,
    session_id TEXT,
    estimated_cost_usd REAL NOT NULL,
    estimated_input_tokens INTEGER NOT NULL,
    estimated_output_tokens INTEGER NOT NULL,
    model_requested TEXT NOT NULL,
    agentic_detected INTEGER NOT NULL DEFAULT 0,
    agentic_multiplier_applied REAL NOT NULL DEFAULT 1,
    request_summary TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_at TEXT,
    resolved_by TEXT,
    rejection_reason TEXT,
    actual_cost_usd REAL,
    was_accurate INTEGER,
    trigger_source TEXT,
    business_object TEXT,
    expected_outcome TEXT,
    actual_outcome TEXT,
    was_reused INTEGER DEFAULT 0,
    artifact_link TEXT
  );

  CREATE TABLE IF NOT EXISTS approval_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL,
    action TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approval_outcome_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (approval_id) REFERENCES pending_approvals(id)
  );
`);

const insertApiCall = db.prepare(`
  INSERT INTO api_calls (
    timestamp, provider, team, session_id, model, input_tokens, output_tokens,
    estimated_cost_usd, baseline_gpt4o_cost_usd, savings_usd, duration_ms,
    status_code, success
  ) VALUES (
    @timestamp, @provider, @team, @sessionId, @model, @inputTokens, @outputTokens,
    @estimatedCostUsd, @baselineGpt4oCostUsd, @savingsUsd, @durationMs,
    @statusCode, @success
  )
`);

const insertBlockedLoop = db.prepare(`
  INSERT INTO blocked_loops (timestamp, team, session_id, reason, request_count)
  VALUES (@timestamp, @team, @sessionId, @reason, @requestCount)
`);

const insertBlockedBudget = db.prepare(`
  INSERT INTO blocked_budgets (timestamp, team, monthly_budget_usd, current_spend_usd, reason)
  VALUES (@timestamp, @team, @monthlyBudgetUsd, @currentSpendUsd, @reason)
`);

const insertRoutingLog = db.prepare(`
  INSERT INTO routing_logs (
    timestamp, team, session_id, original_model, actual_model, was_routed,
    routing_reason, classification_tier, classification_confidence, is_agentic,
    has_code, input_tokens_estimated, input_tokens_actual, output_tokens_actual,
    original_cost_usd, actual_cost_usd, savings_usd, quality_check_passed,
    quality_fallback_used, multi_provider_fallback_used, fallback_reason,
    cache_hit, classification_duration_ms, total_request_duration_ms, stream_used,
    preflight_enabled, preflight_outcome, preflight_estimated_cost_usd,
    preflight_actual_cost_usd, preflight_accuracy_pct, preflight_duration_ms
  ) VALUES (
    @timestamp, @team, @sessionId, @originalModel, @actualModel, @wasRouted,
    @routingReason, @classificationTier, @classificationConfidence, @isAgentic,
    @hasCode, @inputTokensEstimated, @inputTokensActual, @outputTokensActual,
    @originalCostUsd, @actualCostUsd, @savingsUsd, @qualityCheckPassed,
    @qualityFallbackUsed, @multiProviderFallbackUsed, @fallbackReason,
    @cacheHit, @classificationDurationMs, @totalRequestDurationMs, @streamUsed,
    @preflightEnabled, @preflightOutcome, @preflightEstimatedCostUsd,
    @preflightActualCostUsd, @preflightAccuracyPct, @preflightDurationMs
  )
`);

const insertPendingApproval = db.prepare(`
  INSERT INTO pending_approvals (
    id, token, timestamp, team, session_id, estimated_cost_usd, estimated_input_tokens,
    estimated_output_tokens, model_requested, agentic_detected,
    agentic_multiplier_applied, request_summary, status,
    trigger_source, business_object, expected_outcome
  ) VALUES (
    @id, @token, @timestamp, @team, @sessionId, @estimatedCostUsd, @estimatedInputTokens,
    @estimatedOutputTokens, @modelRequested, @agenticDetected,
    @agenticMultiplierApplied, @requestSummary, @status,
    @triggerSource, @businessObject, @expectedOutcome
  )
`);

const getPendingApprovalById = db.prepare(`
  SELECT * FROM pending_approvals WHERE id = ?
`);

const stmtUpdateApproval = db.prepare(`
  UPDATE pending_approvals
  SET status = ?, resolved_at = ?, resolved_by = ?, rejection_reason = ?
  WHERE id = ?
`);

const stmtUpdateApprovalAccuracy = db.prepare(`
  UPDATE pending_approvals
  SET actual_cost_usd = ?, was_accurate = ?
  WHERE id = ?
`);

const stmtUpdateApprovalOutcome = db.prepare(`
  UPDATE pending_approvals
  SET actual_outcome = ?, was_reused = ?, artifact_link = ?
  WHERE id = ?
`);

const getPendingApprovalsByStatus = db.prepare(`
  SELECT * FROM pending_approvals WHERE status = ? ORDER BY timestamp ASC
`);

const getApprovalStats = db.prepare(`
  SELECT
    COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count,
    COUNT(CASE WHEN status = 'approved' THEN 1 END) AS approved_count,
    COUNT(CASE WHEN status = 'rejected' THEN 1 END) AS rejected_count,
    COUNT(CASE WHEN status = 'timeout' THEN 1 END) AS timeout_count,
    COALESCE(AVG(CASE WHEN status = 'approved' AND was_accurate = 1 THEN 1.0 ELSE 0 END), 0) AS accuracy_rate
  FROM pending_approvals
  WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
`);

const getAllPendingApprovals = db.prepare(`
  SELECT * FROM pending_approvals
  WHERE status = 'pending'
  ORDER BY timestamp ASC
`);

const getRecentApprovals = db.prepare(`
  SELECT * FROM pending_approvals
  WHERE status != 'pending'
  ORDER BY resolved_at DESC
  LIMIT 50
`);

const retroStmt = db.prepare(`
  SELECT id, team, estimated_cost_usd, actual_cost_usd, status, resolved_at, model_requested,
         trigger_source, business_object, expected_outcome, actual_outcome, was_reused, artifact_link
  FROM pending_approvals
  WHERE status = 'approved' AND resolved_at IS NOT NULL
  ORDER BY resolved_at DESC
  LIMIT ?
`);

const insertOutcomeTag = db.prepare(`
  INSERT INTO approval_outcome_tags (approval_id, tag, notes, created_at)
  VALUES (?, ?, ?, ?)
`);

const getOutcomeTags = db.prepare(`
  SELECT tag, notes, created_at FROM approval_outcome_tags WHERE approval_id = ?
`);

const monthlySpendByTeam = db.prepare(`
  SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
  FROM api_calls
  WHERE team = ?
    AND strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
`);

const recentCalls = db.prepare(`
  SELECT timestamp, provider, team, model, input_tokens, output_tokens,
         estimated_cost_usd, savings_usd, duration_ms, status_code
  FROM api_calls
  ORDER BY id DESC
  LIMIT ?
`);

const spendPerTeamThisMonth = db.prepare(`
  SELECT team, COALESCE(SUM(estimated_cost_usd), 0) AS total_spend_usd
  FROM api_calls
  WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
  GROUP BY team
  ORDER BY total_spend_usd DESC
`);

const totalSavingsThisMonth = db.prepare(`
  SELECT COALESCE(SUM(savings_usd), 0) AS total
  FROM api_calls
  WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
`);

const routingSummaryThisMonth = db.prepare(`
  SELECT
    COALESCE(SUM(savings_usd), 0) AS total_saved_usd,
    COALESCE(SUM(CASE WHEN was_routed = 1 THEN 1 ELSE 0 END), 0) AS routed_requests,
    COUNT(*) AS total_requests,
    COALESCE(AVG(classification_confidence), 0) AS avg_confidence,
    COALESCE(AVG(CASE WHEN quality_fallback_used = 1 THEN 1.0 ELSE 0 END), 0) AS quality_fallback_rate,
    COALESCE(AVG(CASE WHEN cache_hit = 1 THEN 1.0 ELSE 0 END), 0) AS cache_hit_rate,
    COALESCE(AVG(CASE WHEN quality_check_passed = 1 THEN 1.0 ELSE 0 END), 0) AS routing_success_rate
  FROM routing_logs
  WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
`);

const routingDailySavings = db.prepare(`
  SELECT date(timestamp) AS day, COALESCE(SUM(savings_usd), 0) AS savings_usd
  FROM routing_logs
  WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
  GROUP BY date(timestamp)
  ORDER BY day ASC
`);

const routingTierDistribution = db.prepare(`
  SELECT classification_tier AS tier, COUNT(*) AS count
  FROM routing_logs
  WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
  GROUP BY classification_tier
  ORDER BY classification_tier ASC
`);

const routingEfficiency = db.prepare(`
  SELECT date(timestamp) AS day,
         COALESCE(SUM(savings_usd), 0) AS savings_usd,
         COALESCE(SUM(original_cost_usd), 0) AS original_cost_usd,
         CASE
           WHEN COALESCE(SUM(original_cost_usd), 0) = 0 THEN 0
           ELSE COALESCE(SUM(savings_usd), 0) / SUM(original_cost_usd)
         END AS efficiency
  FROM routing_logs
  WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')
  GROUP BY date(timestamp)
  ORDER BY day ASC
`);

const recentRoutingLogs = db.prepare(`
  SELECT id, timestamp, team, session_id, original_model, actual_model, was_routed,
         routing_reason, classification_tier, classification_confidence,
         is_agentic, has_code, input_tokens_estimated, input_tokens_actual,
         output_tokens_actual, original_cost_usd, actual_cost_usd, savings_usd,
         quality_check_passed, quality_fallback_used, multi_provider_fallback_used,
         fallback_reason, cache_hit, classification_duration_ms,
         total_request_duration_ms, stream_used, preflight_outcome,
         preflight_estimated_cost_usd, preflight_actual_cost_usd, preflight_accuracy_pct
  FROM routing_logs
  ORDER BY id DESC
  LIMIT ? OFFSET ?
`);

const insertApprovalAudit = db.prepare(`
  INSERT INTO approval_audit (approval_id, action, ip, user_agent, timestamp)
  VALUES (?, ?, ?, ?, ?)
`);

// ---------- EXPORTED FUNCTIONS ----------

export function logApiCall(call) {
  insertApiCall.run(call);
}

export function logBlockedLoop(event) {
  insertBlockedLoop.run(event);
}

export function logBlockedBudget(event) {
  insertBlockedBudget.run(event);
}

export function logRoutingDecision(event) {
  insertRoutingLog.run(event);
}

export function createPendingApproval(approval) {
  insertPendingApproval.run(approval);
}

export function getPendingApproval(id) {
  return getPendingApprovalById.get(id);
}

export function updateApprovalStatus(id, status, resolvedBy, rejectionReason) {
  const now = new Date().toISOString();
  stmtUpdateApproval.run(status, now, resolvedBy, rejectionReason || null, id);
}

export function updateApprovalOutcome(id, actualOutcome, wasReused, artifactLink) {
  stmtUpdateApprovalOutcome.run(actualOutcome || null, wasReused ? 1 : 0, artifactLink || null, id);
}

export function getPendingApprovals(status) {
  return getPendingApprovalsByStatus.all(status);
}

export function getAllPendingApprovalsList() {
  return getAllPendingApprovals.all();
}

export function getRecentApprovalsList() {
  return getRecentApprovals.all();
}

export function getApprovalsForRetrospective(limit = 100) {
  return retroStmt.all(limit);
}

export function addOutcomeTag(approvalId, tag, notes) {
  insertOutcomeTag.run(approvalId, tag, notes || null, new Date().toISOString());
}

export function getOutcomeTagsForApproval(approvalId) {
  return getOutcomeTags.all(approvalId);
}

export function getApprovalStatsSummary() {
  return getApprovalStats.get();
}

export function updateApprovalAccuracy(id, actualCostUsd, wasAccurate) {
  stmtUpdateApprovalAccuracy.run(actualCostUsd, wasAccurate ? 1 : 0, id);
}

export function getMonthlySpend(team) {
  const row = monthlySpendByTeam.get(team);
  return Number(row?.total || 0);
}

export function getDashboardData(limit = 100) {
  return {
    recentCalls: recentCalls.all(limit),
    spendByTeam: spendPerTeamThisMonth.all(),
    totalSavingsUsd: Number(totalSavingsThisMonth.get().total || 0),
    approvalStats: getApprovalStatsSummary(),
    pendingApprovals: getAllPendingApprovals.all()
  };
}

export function getRoutingStats() {
  return {
    summary: routingSummaryThisMonth.get(),
    dailySavings: routingDailySavings.all(),
    tierDistribution: routingTierDistribution.all(),
    efficiencyOverTime: routingEfficiency.all(),
    recentDecisions: recentRoutingLogs.all(25, 0)
  };
}

export function getRoutingLogs({ limit = 50, offset = 0 } = {}) {
  return recentRoutingLogs.all(Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0));
}

export function logApprovalAudit(approvalId, action, ip, userAgent) {
  insertApprovalAudit.run(approvalId, action, ip || null, userAgent || null, new Date().toISOString());
}

export function deleteOldLogs(days = 90) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM api_calls WHERE timestamp < ?`).run(cutoff);
  db.prepare(`DELETE FROM routing_logs WHERE timestamp < ?`).run(cutoff);
  db.prepare(`DELETE FROM pending_approvals WHERE status != 'pending' AND timestamp < ?`).run(cutoff);
  db.prepare(`DELETE FROM approval_audit WHERE timestamp < ?`).run(cutoff);
  console.log(`[DB] Deleted logs older than ${days} days`);
}

export function getSavingsBreakdown(baselineModel, startDate, endDate) {
  const rows = db.prepare(`
    SELECT team, actual_model, input_tokens_actual, output_tokens_actual, actual_cost_usd, date(timestamp) as day
    FROM routing_logs
    WHERE timestamp >= ? AND timestamp <= ?
  `).all(startDate, endDate);

  const teams = {};
  const models = {};
  const dailySavings = {};

  for (const row of rows) {
    const baselineCost = calculateCost(baselineModel, row.input_tokens_actual, row.output_tokens_actual);
    const savings = baselineCost - row.actual_cost_usd;
    if (savings <= 0) continue;
    teams[row.team] = (teams[row.team] || 0) + savings;
    models[row.actual_model] = (models[row.actual_model] || 0) + savings;
    const day = row.day;
    dailySavings[day] = (dailySavings[day] || 0) + savings;
  }

  const cumulative = [];
  let running = 0;
  const sortedDays = Object.keys(dailySavings).sort();
  for (const day of sortedDays) {
    running += dailySavings[day];
    cumulative.push({ day, cumulative_savings: running });
  }

  return {
    teams: Object.entries(teams).map(([team, savings]) => ({ team, savings })),
    models: Object.entries(models).map(([model, savings]) => ({ model, savings })),
    cumulative
  };
}