const DEFAULT_TIMEOUT_MS = 4000;

const checks = [
  {
    name: 'frontend-root',
    url: process.env.ALPHAPULSE_FRONTEND_URL || 'http://localhost:3000/',
    requiredStatus: 200,
  },
  {
    name: 'backend-health',
    url: process.env.ALPHAPULSE_BACKEND_HEALTH_URL || 'http://localhost:3001/health',
    requiredStatus: 200,
  },
  {
    name: 'backend-ready',
    url: process.env.ALPHAPULSE_BACKEND_READY_URL || 'http://localhost:3001/ready',
    requiredStatus: 200,
  },
  {
    name: 'compliance-summary',
    url: process.env.ALPHAPULSE_COMPLIANCE_SUMMARY_URL || 'http://localhost:3001/api/compliance/summary',
    requiredStatus: 200,
  },
  {
    name: 'quant-health',
    url: process.env.ALPHAPULSE_QUANT_HEALTH_URL || 'http://127.0.0.1:8000/health',
    requiredStatus: 200,
  },
];

function parseTimeoutMs() {
  const value = Number(process.env.ALPHAPULSE_HEALTH_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function summarizeJson(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const summary = {};
  for (const key of ['status', 'mode', 'success', 'reason', 'notice', 'timestamp']) {
    if (Object.hasOwn(payload, key)) {
      summary[key] = payload[key];
    }
  }
  if (payload.services && typeof payload.services === 'object') {
    summary.services = payload.services;
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

const SENSITIVE_QUERY_RE = /^(access_token|api[_-]?key|auth|code|credential|key|password|secret|sig|signature|token)$/i;

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = 'REDACTED';
    if (url.password) url.password = 'REDACTED';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_RE.test(key)) {
        url.searchParams.set(key, 'REDACTED');
      }
    }
    return url.toString();
  } catch {
    return String(rawUrl)
      .replace(/\/\/([^/:@\s]+):([^/@\s]+)@/g, '//REDACTED:REDACTED@')
      .replace(/([?&](?:access_token|api[_-]?key|auth|code|credential|key|password|secret|sig|signature|token)=)[^&\s"]+/gi, '$1REDACTED');
  }
}

function sanitizeError(error, rawUrl) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(rawUrl).join(sanitizeUrl(rawUrl));
}

async function runCheck(check, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const safeUrl = sanitizeUrl(check.url);

  try {
    const response = await fetch(check.url, { signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? summarizeJson(await response.json().catch(() => null))
      : null;
    const ok = response.status === check.requiredStatus;
    return {
      name: check.name,
      url: safeUrl,
      ok,
      status: response.status,
      expectedStatus: check.requiredStatus,
      durationMs: Date.now() - startedAt,
      summary: body,
    };
  } catch (error) {
    return {
      name: check.name,
      url: safeUrl,
      ok: false,
      status: null,
      expectedStatus: check.requiredStatus,
      durationMs: Date.now() - startedAt,
      error: sanitizeError(error, check.url),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

const timeoutMs = parseTimeoutMs();
const results = await Promise.all(checks.map((check) => runCheck(check, timeoutMs)));
const ok = results.every((result) => result.ok);

console.table(results.map((result) => ({
  check: result.name,
  ok: result.ok,
  status: result.status ?? 'n/a',
  expected: result.expectedStatus,
  durationMs: result.durationMs,
})));

console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  timeoutMs,
  results,
}, null, 2));

if (!ok) {
  process.exitCode = 1;
}
