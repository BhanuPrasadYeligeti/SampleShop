'use strict';
/*
 * calm-otel.js - send sample.Shop application logs to SAP Cloud ALM via OpenTelemetry (OTLP).
 *
 * Loaded before the approuter:
 *   node -r ./calm-otel.js node_modules/@sap/approuter/approuter.js
 *
 * What it does
 *  1. Reads the bound Destination service (VCAP_SERVICES) and looks up the destination
 *     CALM_DESTINATION (default "CALM_datacollector") -> Cloud ALM URL + OAuth token.
 *  2. Copies every line the app writes to stdout/stderr and sends it as an OpenTelemetry
 *     log record (OTLP protobuf over HTTP) to
 *        <Cloud ALM URL>/calm-logs/v1/logs?serviceId=<CALM_SERVICE_ID>&useCase=exm&tag=<CALM_TAG>
 *  3. At startup it sends one ERROR test record ("Cloud ALM connectivity test ...") so that
 *     something shows up in Cloud ALM even if the app itself logs no errors.
 *  4. DIAGNOSTICS: every problem and the first successful send are written to the app log
 *     with the prefix [calm-otel] (BTP cockpit -> sample.Shop -> Logs), including the HTTP
 *     status and response text returned by Cloud ALM. Secrets are never printed.
 *
 * Env vars (mta.yaml -> properties):
 *  CALM_SERVICE_ID   (required) service ID from Cloud ALM Landscape Management
 *  CALM_DESTINATION  (optional) destination name, default CALM_datacollector
 *  CALM_MIN_LEVEL    (optional) debug | info | warning | error, default info
 *  CALM_TAG          (optional) tag shown in Cloud ALM, default sample-shop
 *  CALM_SEND_TEST    (optional) "false" to skip the startup test record
 *
 * It never stops or slows down the app: any problem is printed and the app keeps running.
 */

const SERVICE_ID = process.env.CALM_SERVICE_ID;
const DEST_NAME = process.env.CALM_DESTINATION || 'CALM_datacollector';
const TAG = process.env.CALM_TAG || 'sample-shop';
const SEND_TEST = String(process.env.CALM_SEND_TEST || 'true').toLowerCase() !== 'false';
const LEVELS = { trace: 1, debug: 5, info: 9, warning: 13, warn: 13, error: 17, fatal: 21 };
const MIN_LEVEL_NAME = (process.env.CALM_MIN_LEVEL || 'info').toLowerCase();
const MIN_LEVEL = LEVELS[MIN_LEVEL_NAME] || LEVELS.info;

const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
const say = (msg) => origOut(`[calm-otel] ${msg}\n`);

function start() {
  if (!SERVICE_ID) { say('CALM_SERVICE_ID not set - Cloud ALM log export disabled'); return; }

  let destCreds;
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    destCreds = (vcap.destination || [])[0] && vcap.destination[0].credentials;
  } catch (e) { /* handled below */ }
  if (!destCreds) { say('no destination service bound (VCAP_SERVICES.destination) - export disabled'); return; }

  let otel;
  try {
    otel = {
      logs: require('@opentelemetry/sdk-logs'),
      resources: require('@opentelemetry/resources'),
      transformer: require('@opentelemetry/otlp-transformer'),
    };
  } catch (e) { say(`OpenTelemetry packages missing (${e.message}) - export disabled`); return; }

  const appName = (() => {
    try { return JSON.parse(process.env.VCAP_APPLICATION || '{}').application_name; } catch (e) { return null; }
  })() || 'sample.Shop';

  say(`starting: service ${SERVICE_ID}, destination ${DEST_NAME}, min level ${MIN_LEVEL_NAME}, tag ${TAG}`);

  // ---- Destination lookup with token cache ----------------------------------------------
  let cache = { url: null, token: null, expires: 0 };

  async function refresh() {
    const tokRes = await fetch(`${destCreds.url}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${destCreds.clientid}:${destCreds.clientsecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!tokRes.ok) throw new Error(`destination service token request failed: HTTP ${tokRes.status}`);
    const t = await tokRes.json();

    const res = await fetch(`${destCreds.uri}/destination-configuration/v1/destinations/${DEST_NAME}`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    if (res.status === 404) throw new Error(`destination "${DEST_NAME}" not found in subaccount/instance`);
    if (!res.ok) throw new Error(`destination "${DEST_NAME}" lookup failed: HTTP ${res.status}`);
    const d = await res.json();
    const tok = (d.authTokens || [])[0];
    if (!tok || tok.error || !tok.value) {
      throw new Error(`destination "${DEST_NAME}" returned no token: ${(tok && tok.error) || 'check its Client ID / Secret / Token Service URL'}`);
    }
    const url = String(d.destinationConfiguration.URL || '').replace(/\/+$/, '');
    if (!url) throw new Error(`destination "${DEST_NAME}" has no URL`);
    const firstTime = !cache.url;
    cache = {
      url,
      token: `${tok.type || 'Bearer'} ${tok.value}`,
      expires: Date.now() + Math.max(60, Number(tok.expires_in || 3600) - 300) * 1000, // renew 5 min early
    };
    if (firstTime) say(`destination OK -> Cloud ALM host ${new URL(url).host}`);
    return cache;
  }

  async function current() {
    if (!cache.token || Date.now() > cache.expires) await refresh();
    return cache;
  }

  // ---- Exporter: OTLP protobuf over HTTP, with full status reporting ----------------------
  const stats = { sent: 0, failed: 0, firstOk: false, lastProblem: '' };

  function problem(msg) {
    stats.failed++;
    if (msg !== stats.lastProblem) { stats.lastProblem = msg; say(`EXPORT PROBLEM: ${msg}`); }
  }

  class CalmExporter {
    export(records, resultCallback) {
      (async () => {
        const c = await current();
        const endpoint = `${c.url}/calm-logs/v1/logs?serviceId=${encodeURIComponent(SERVICE_ID)}` +
          `&useCase=exm&dev=false&tag=${encodeURIComponent(TAG)}`;
        const body = otel.transformer.ProtobufLogsSerializer.serializeRequest(records);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: c.token, 'Content-Type': 'application/x-protobuf' },
          body,
        });
        const text = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) cache.token = null; // force new token next time
          throw new Error(`Cloud ALM answered HTTP ${res.status} for ${new URL(endpoint).pathname} ${text ? `- ${text}` : ''}`);
        }
        stats.sent += records.length;
        if (!stats.firstOk) {
          stats.firstOk = true;
          say(`first export OK: HTTP ${res.status}, ${records.length} record(s) accepted by Cloud ALM ${text ? `- ${text}` : ''}`);
        }
      })().then(() => resultCallback({ code: 0 }), (e) => {
        problem(e && e.message ? e.message : String(e));
        resultCallback({ code: 1, error: e });
      });
    }
    shutdown() { return Promise.resolve(); }
    forceFlush() { return Promise.resolve(); }
  }

  const provider = new otel.logs.LoggerProvider({
    resource: otel.resources.resourceFromAttributes({
      'service.name': appName,
      'calm.service.id': SERVICE_ID,
    }),
    processors: [new otel.logs.BatchLogRecordProcessor({ exporter: new CalmExporter(), scheduledDelayMillis: 5000 })],
  });
  const logger = provider.getLogger('calm-otel');

  // Summary every 10 minutes so the cockpit log shows whether export keeps working.
  setInterval(() => {
    say(`status: ${stats.sent} record(s) sent, ${stats.failed} failed batch(es)${stats.lastProblem ? `, last problem: ${stats.lastProblem}` : ''}`);
  }, 10 * 60 * 1000).unref();

  // ---- Turn a log line into a log record ---------------------------------------------------
  function toRecord(line, fromStderr) {
    let level = fromStderr ? 'warning' : 'info';
    let body = line;
    const attributes = { 'log.stream': fromStderr ? 'stderr' : 'stdout' };
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        level = String(j.level || j.severity || level).toLowerCase();
        body = j.msg || j.message || line;
        ['logger', 'layer', 'correlation_id', 'request_id', 'component_name', 'space_name']
          .forEach((k) => { if (j[k] !== undefined && j[k] !== '-') attributes[k] = String(j[k]); });
      } catch (e) { /* plain text line */ }
    } else if (/\b(error|exception|failed|unhandled)\b/i.test(line)) {
      level = 'error';
    }
    const severityNumber = LEVELS[level] || LEVELS.info;
    if (severityNumber < MIN_LEVEL) return null;
    return { severityNumber, severityText: level.toUpperCase(), body, attributes };
  }

  function hook(stream, orig, fromStderr) {
    let buf = '';
    stream.write = function (chunk, encoding, cb) {
      try {
        buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line && !line.startsWith('[calm-otel]')) {
            const rec = toRecord(line, fromStderr);
            if (rec) logger.emit(rec);
          }
        }
        if (buf.length > 64 * 1024) buf = '';
      } catch (e) { /* never break app logging */ }
      return orig(chunk, encoding, cb);
    };
  }

  hook(process.stdout, origOut, false);
  hook(process.stderr, origErr, true);

  process.on('uncaughtExceptionMonitor', (err) => {
    logger.emit({ severityNumber: LEVELS.fatal, severityText: 'FATAL', body: String((err && err.stack) || err),
      attributes: { 'exception.type': (err && err.name) || 'Error' } });
  });

  if (SEND_TEST) {
    const inst = process.env.CF_INSTANCE_INDEX || '0';
    logger.emit({
      severityNumber: LEVELS.error,
      severityText: 'ERROR',
      body: `Cloud ALM connectivity test from ${appName} (instance ${inst}) at ${new Date().toISOString()}`,
      attributes: { 'exception.type': 'CalmConnectivityTest', 'log.stream': 'calm-otel' },
    });
  }

  // Check the destination right away so problems show in the log within seconds of start.
  refresh().catch((e) => problem(e.message));

  const flush = () => { provider.forceFlush().catch(() => {}); };
  process.on('SIGTERM', flush);
  process.on('beforeExit', flush);
}

try { start(); } catch (e) { say(`disabled: ${e.message}`); }
