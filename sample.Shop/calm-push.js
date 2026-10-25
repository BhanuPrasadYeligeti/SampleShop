'use strict';
/*
 * Pushes sample.Shop warnings/errors (approuter + browser UI) to SAP Cloud ALM
 * via the SAP Cloud ALM Raw Data Inbound Logs API (POST /api/calm-logs/v1/logs, OpenTelemetry logs JSON).
 * No OpenTelemetry library / SAP agent needed - plain HTTPS with the OAuth token of a BTP destination.
 *
 * Flow: calm.add(...) -> buffer -> every N seconds -> destination service (OAuth2 client credentials)
 *       -> POST <Cloud ALM>/api/calm-logs/v1/logs?useCase=exm.im&serviceId=<LMS ID> -> IEM -> Exceptions
 *
 * Settings (mta.yaml -> sample.Shop -> properties):
 *   SAP_CALM_PUSH_ENABLED      true/false (default false)
 *   SAP_CALM_PUSH_SERVICE_ID   LMS ID of the sample.Shop service in Cloud ALM Landscape Management (mandatory)
 *   SAP_CALM_PUSH_DESTINATION  BTP destination to the Cloud ALM API (default CALM_datacollector)
 *   SAP_CALM_PUSH_USE_CASE     exm.im (default; IEM exceptions)
 *   SAP_CALM_PUSH_DEV          true = synchronous dev mode with error details, max 100 calls / 24h (default false)
 *   SAP_CALM_PUSH_INTERVAL     flush interval in seconds (default 60, 900 in dev mode)
 *   SAP_CALM_PUSH_APP_NAME     service.name sent to Cloud ALM (default SAP_CALM_SERVICE_NAME or sample.Shop)
 * Needs a bound destination service instance (dest_Demo_MTA_Project) to read the destination.
 */
const env = process.env;

const ENABLED = /^true$/i.test(env.SAP_CALM_PUSH_ENABLED || '');
const SERVICE_ID = env.SAP_CALM_PUSH_SERVICE_ID;
const DESTINATION = env.SAP_CALM_PUSH_DESTINATION || 'CALM_datacollector';
const USE_CASE = env.SAP_CALM_PUSH_USE_CASE || 'exm.im';
const DEV = /^true$/i.test(env.SAP_CALM_PUSH_DEV || '');
const INTERVAL_S = Number(env.SAP_CALM_PUSH_INTERVAL) || (DEV ? 900 : 60); // dev mode: 100 calls / 24h
const APP_NAME = env.SAP_CALM_PUSH_APP_NAME || env.SAP_CALM_SERVICE_NAME || 'sample.Shop';

const MAX_BUFFER = 5000; // API limit: 5000 log records per request
const CHUNK = 200; // keep each request well below the 1 MB JSON payload limit
const MAX_TEXT = 8000; // cut very long messages / stack traces

const buffer = [];
let dropped = 0;
let timer;
let say = (level, msg) => console.log(`[calm-push] ${level}: ${msg}`); // replaced by server.js logger

const cut = s => (s && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + ' ...[truncated]' : s);
const str = (key, value) => ({ key, value: { stringValue: String(value) } });

/**
 * Queue one log record for SAP Cloud ALM.
 * @param {'error'|'warn'} level
 * @param {string} logger   e.g. 'sample.Shop.approuter' or 'sample.Shop.ui'
 * @param {string} message
 * @param {object} [extra]  { type, stack, user, correlationId, attributes: {key: value} }
 */
function add(level, logger, message, extra = {}) {
  if (!ENABLED) return;
  try {
    const now = `${Date.now()}000000`;
    const isError = level === 'error';
    const attributes = [str('sap.exm.user', extra.user || 'ANONYMOUS'), str('logger', logger)];
    if (extra.correlationId) attributes.push(str('correlation.id', extra.correlationId));
    if (extra.type) attributes.push(str('exception.type', extra.type));
    if (extra.type || extra.stack) attributes.push(str('exception.message', cut(String(message))));
    if (extra.stack) attributes.push(str('exception.stacktrace', cut(String(extra.stack))));
    for (const [k, v] of Object.entries(extra.attributes || {})) if (v !== undefined && v !== null && v !== '') attributes.push(str(k, cut(String(v))));
    if (buffer.length >= MAX_BUFFER) { buffer.shift(); dropped++; }
    buffer.push({
      logger,
      record: {
        timeUnixNano: now,
        observedTimeUnixNano: now,
        severityNumber: isError ? 'SEVERITY_NUMBER_ERROR' : 'SEVERITY_NUMBER_WARN',
        severityText: isError ? 'Error' : 'Warning',
        body: { stringValue: cut(String(message)) },
        attributes
      }
    });
  } catch (e) {
    /* never break the app because of monitoring */
  }
}

function payload(items) {
  const byLogger = new Map();
  for (const { logger, record } of items) {
    if (!byLogger.has(logger)) byLogger.set(logger, []);
    byLogger.get(logger).push(record);
  }
  return {
    resourceLogs: [{
      resource: { attributes: [str('service.name', APP_NAME)] },
      scopeLogs: [...byLogger].map(([name, logRecords]) => ({ scope: { name }, logRecords }))
    }]
  };
}

// --- destination lookup (BTP destination service, no SDK needed) ---
function destinationBinding() {
  const vcap = JSON.parse(env.VCAP_SERVICES || '{}');
  const list = vcap.destination || [];
  if (!list.length) throw new Error('no destination service instance bound to sample.Shop');
  return list[0].credentials;
}

async function serviceToken(cred) {
  const res = await fetch(`${cred.url.replace(/\/+$/, '')}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${cred.clientid}:${cred.clientsecret}`).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cred.clientid })
  });
  if (!res.ok) throw new Error(`destination service token: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function getDestination() {
  const cred = destinationBinding();
  const token = await serviceToken(cred);
  const res = await fetch(`${cred.uri.replace(/\/+$/, '')}/destination-configuration/v1/destinations/${encodeURIComponent(DESTINATION)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`destination ${DESTINATION}: HTTP ${res.status}`);
  return res.json(); // { destinationConfiguration: {URL, ...}, authTokens: [{type, value, http_header, error}] }
}

async function post(items) {
  const dest = await getDestination();
  const url = dest.destinationConfiguration && dest.destinationConfiguration.URL;
  if (!url) throw new Error(`destination ${DESTINATION} has no URL`);
  const headers = { 'content-type': 'application/json' };
  const token = (dest.authTokens || []).find(t => !t.error);
  if (token) headers.authorization = token.http_header ? token.http_header.value : `${token.type} ${token.value}`;
  else {
    const reason = (dest.authTokens && dest.authTokens[0] && dest.authTokens[0].error) || 'no token returned';
    throw new Error(`no OAuth token for destination ${DESTINATION}: ${reason}`);
  }
  // destination URL may be "https://<tenant>.<region>.alm.cloud.sap" or ".../api"
  const base = url.replace(/\/+$/, '').replace(/\/api$/, '');
  const q = new URLSearchParams({ useCase: USE_CASE, serviceId: SERVICE_ID, version: 'v1', tag: APP_NAME, dev: String(DEV) });
  const res = await fetch(`${base}/api/calm-logs/v1/logs?${q}`, { method: 'POST', headers, body: JSON.stringify(payload(items)) });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw Object.assign(new Error(`Cloud ALM answered HTTP ${res.status}: ${text.slice(0, 500)}`), { status: res.status });
  return { status: res.status, text };
}

let flushing = false;
async function flush() {
  if (flushing || !buffer.length) return;
  flushing = true;
  try {
    while (buffer.length) {
      const items = buffer.splice(0, CHUNK);
      try {
        const r = await post(items);
        say('info', `pushed ${items.length} log record(s) to SAP Cloud ALM (HTTP ${r.status})${DEV && r.text ? ': ' + r.text.slice(0, 300) : ''}`);
      } catch (e) {
        const retry = e.status === 429 || e.status >= 500 || !e.status;
        if (retry) buffer.unshift(...items);
        say('warn', `push to SAP Cloud ALM failed, ${retry ? 'will retry' : 'records dropped'}: ${e.message}`);
        break;
      }
    }
    if (dropped) { say('warn', `${dropped} log record(s) dropped (buffer full)`); dropped = 0; }
  } finally {
    flushing = false;
  }
}

function start(logFn) {
  if (logFn) say = logFn;
  if (!ENABLED) return say('info', 'SAP Cloud ALM log push disabled (SAP_CALM_PUSH_ENABLED != true)');
  if (!SERVICE_ID) return say('warn', 'SAP Cloud ALM log push disabled: SAP_CALM_PUSH_SERVICE_ID (LMS ID of the service in Cloud ALM) is not set');
  timer = setInterval(flush, INTERVAL_S * 1000);
  timer.unref();
  // push what is left when CF stops/restarts the app, then exit (a SIGTERM listener disables Node's default exit)
  process.once('SIGTERM', () => {
    setTimeout(() => process.exit(0), 5000).unref();
    flush().finally(() => process.exit(0));
  });
  say('info', `SAP Cloud ALM log push active: warnings + errors -> destination ${DESTINATION}, useCase=${USE_CASE}, serviceId=${SERVICE_ID}, every ${INTERVAL_S}s${DEV ? ' (dev mode)' : ''}`);
}

module.exports = { add, flush, start, enabled: () => ENABLED && !!SERVICE_ID, _payload: payload };
