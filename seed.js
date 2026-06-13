import { logApiCall } from './db.js';

const calls = [
  { timestamp: new Date().toISOString(), provider: 'openai', team: 'engineering', sessionId: 'demo-1', model: 'gpt-4o', inputTokens: 1200, outputTokens: 800, estimatedCostUsd: 0.018, baselineGpt4oCostUsd: 0.018, savingsUsd: 0, durationMs: 420, statusCode: 200, success: 1 },
  { timestamp: new Date().toISOString(), provider: 'openai', team: 'marketing', sessionId: 'demo-2', model: 'gpt-4o-mini', inputTokens: 3000, outputTokens: 1500, estimatedCostUsd: 0.0014, baselineGpt4oCostUsd: 0.0375, savingsUsd: 0.036, durationMs: 310, statusCode: 200, success: 1 },
  { timestamp: new Date().toISOString(), provider: 'anthropic', team: 'engineering', sessionId: 'demo-3', model: 'claude-haiku-4', inputTokens: 5000, outputTokens: 2000, estimatedCostUsd: 0.012, baselineGpt4oCostUsd: 0.055, savingsUsd: 0.043, durationMs: 280, statusCode: 200, success: 1 },
  { timestamp: new Date().toISOString(), provider: 'openai', team: 'engineering', sessionId: 'demo-4', model: 'gpt-4o-mini', inputTokens: 8000, outputTokens: 4000, estimatedCostUsd: 0.0036, baselineGpt4oCostUsd: 0.1, savingsUsd: 0.096, durationMs: 650, statusCode: 200, success: 1 },
  { timestamp: new Date().toISOString(), provider: 'anthropic', team: 'marketing', sessionId: 'demo-5', model: 'claude-sonnet-4', inputTokens: 2000, outputTokens: 1000, estimatedCostUsd: 0.021, baselineGpt4oCostUsd: 0.025, savingsUsd: 0.004, durationMs: 390, statusCode: 200, success: 1 },
];

calls.forEach(c => logApiCall(c));
console.log('Done! Refresh dashboard.');