// Tracks request bursts by session so runaway agents can be stopped before spend explodes.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_WITHOUT_SUCCESS = 10;

export class LoopDetector {
  constructor() {
    this.sessions = new Map();
  }

  registerRequest(sessionId) {
    if (!sessionId) {
      return { blocked: false, requestCount: 0 };
    }

    const now = Date.now();
    const session = this.sessions.get(sessionId) || { requests: [], lastSuccessAt: 0 };

    session.requests = session.requests.filter((timestamp) => {
      const insideWindow = now - timestamp <= WINDOW_MS;
      const afterLastSuccess = timestamp > session.lastSuccessAt;
      return insideWindow && afterLastSuccess;
    });

    session.requests.push(now);
    this.sessions.set(sessionId, session);

    return {
      blocked: session.requests.length > MAX_REQUESTS_WITHOUT_SUCCESS,
      requestCount: session.requests.length
    };
  }

  markSuccess(sessionId) {
    if (!sessionId) return;

    const session = this.sessions.get(sessionId) || { requests: [], lastSuccessAt: 0 };
    session.lastSuccessAt = Date.now();
    session.requests = [];
    this.sessions.set(sessionId, session);
  }
}
