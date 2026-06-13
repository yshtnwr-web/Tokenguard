import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000';
const TEAMS = ['engineering', 'marketing', 'default'];

// Use the same credentials as your dashboard (from .env or defaults)
const AUTH_USER = process.env.DASHBOARD_USER || 'admin';
const AUTH_PASS = process.env.DASHBOARD_PASS || 'changeme';
const AUTH_HEADER = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendRequest(team, prompt, model = 'gpt-4o', extraHeaders = {}) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tokenguard-team': team,
      ...extraHeaders
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] })
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch(e) {}
  return { status: res.status, body: json || text, headers: res.headers };
}

async function autoApproveAllPending() {
  // Add auth header for API call
  const res = await fetch(`${BASE_URL}/api/pending-approvals`, {
    headers: { 'Authorization': AUTH_HEADER }
  });
  if (!res.ok) {
    console.error(`Failed to fetch pending approvals: ${res.status}`);
    return;
  }
  const data = await res.json();
  for (const pending of data.pending || []) {
    const approveRes = await fetch(`${BASE_URL}/approve/${pending.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': AUTH_HEADER },
      body: JSON.stringify({ decision: 'approved', token: pending.token, resolved_by: 'test-script' })
    });
    console.log(`   Auto-approved ${pending.id}: ${approveRes.status}`);
    await sleep(500);
  }
}

async function run() {
  console.log('=== Populating dashboard with test data ===\n');
  console.log('1. Sending simple requests...');
  for (let i = 0; i < 3; i++) {
    for (const team of TEAMS) {
      await sendRequest(team, 'Say hello in one word');
      await sleep(100);
    }
  }
  console.log('2. Sending code requests...');
  await sendRequest('engineering', 'Write a function to sum two numbers in Python');
  await sendRequest('engineering', 'Fix this bug: `for i in range(10): print(i`', 'gpt-4o');
  await sleep(500);
  console.log('3. Sending complex reasoning requests...');
  await sendRequest('marketing', 'Analyze the pros and cons of our Q3 marketing strategy in detail');
  await sendRequest('default', 'Explain the architecture of a transformer model in depth');
  await sleep(500);
  console.log('4. Sending agentic-like requests...');
  const sessionId = `agent-session-${Date.now()}`;
  for (let i = 0; i < 5; i++) {
    await sendRequest('engineering', 'Step 1: do X', 'gpt-4o', { 'x-tokenguard-session': sessionId });
    await sleep(50);
  }
  await sleep(500);
  console.log('5. Sending requests that trigger pre‑flight block (long prompts)...');
  const longPrompt = 'x'.repeat(3000);
  for (let i = 0; i < 2; i++) {
    await sendRequest('default', longPrompt);
    await sleep(500);
  }
  await autoApproveAllPending();
  console.log('6. Sending requests that may trigger quality fallback...');
  await sendRequest('engineering', 'Explain quantum computing in detail', 'gpt-4o-mini');
  await sleep(500);
  console.log('7. Sending duplicate requests to test cache...');
  const duplicatePrompt = 'What is the capital of France?';
  for (let i = 0; i < 3; i++) {
    await sendRequest('default', duplicatePrompt);
    await sleep(100);
  }
  console.log('8. Sending requests with different original models...');
  await sendRequest('marketing', 'Summarize this', 'gpt-4o-mini');
  await sendRequest('engineering', 'Translate to French', 'claude-sonnet-4-6');
  await sleep(500);
  console.log('\n=== Test data generation complete. ===');
  console.log('Refresh your dashboard to see populated tables and charts.');
}

run().catch(console.error);