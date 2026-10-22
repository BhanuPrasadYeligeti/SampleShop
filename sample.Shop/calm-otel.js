'use strict';
/*
 * calm-otel.js - send sample.Shop application logs to SAP Cloud ALM (Exception Monitoring).
 *
 * Loaded before the approuter:  node -r ./calm-otel.js node_modules/@sap/approuter/approuter.js
 *
 * How it works
 *  1. Reads the bound Destination service credentials (VCAP_SERVICES).
 *  2. Looks up the destination "CALM_datacollector" -> Cloud ALM API URL + OAuth token.
 *  3. Copies every log line the app writes to stdout/stderr (the same lines you see in
 *     BTP cockpit -> Logs) and sends them as OpenTelemetry logs to
 *     <CALM URL>/calm-logs/v1/logs?serviceId=<CALM_SERVICE_ID>&useCase=exm
 *
 * Env vars (set in mta.yaml):
 *  CALM_SERVICE_ID   (required) ID of the service in Cloud ALM Landscape Management
 *  CALM_DESTINATION  (optional) destination name, default CALM_datacollector
 *  CALM_MIN_LEVEL    (optional) debug | info | warning | error, default info
 *  CALM_TAG          (optional) tag shown in Cloud ALM, default sample-shop
 *
 * It never stops the app: any problem is printed once and the app keeps running.
 */

const SERVICE_ID = process.env.CALM_SERVICE_ID;
const DEST_NAME = process.env.CALM_DESTINATION || 'CALM_datacollector';
const TAG = process.env.CALM_TAG || 'sample-shop';
const LEVELS = { trace: 1, debug: 5, info: 9, warning: 13, warn: 13, error: 17, fatal: 21 };
const MIN_LEVEL = LEVELS[(process.env.CALM_MIN_LEVEL || 'info').toLowerCase()] || LEVELS.info;

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
  if (!destCreds) { say('no destination service bound - Cloud ALM log export disabled'); return; }

  let otel;
  try {
    otel = {
      logs: require('@opentelemetry/sdk-logs'),
      exporter: require('@opentelemetry/exporter-logs-otlp-proto'),
      resources: require('@opentelemetry/resources'),
    };
  } catch (e) { say(`OpenTelemetry packages missing (${e.message}) - export disabled`); return; }

  // ---- Destination lookup with token cache --------------------------------------------
  let cache = { url: null, token: null, expires: 0 };

  async function postForm(url, user, pass, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
    return res.json();
  }

  async function refresh() {
    const t = await postForm(`${destCreds.url}/oauth/token`, destCreds.clientid, destCreds.clientsecret,
      'grant_type=client_credentials');
    const res = await fetch(`${destCreds.uri}/destination-configuration/v1/destinations/${DEST_NAME}`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    if (!res.ok) throw new Error(`destination ${DEST_NAME} lookup failed: HTTP ${res.status}`);
    const d = await res.json();
    const tok = (d.authTokens || [])[0];
    if (!tok || tok.error || !tok.value) {
      throw new Error(`destination ${DEST_NAME} returned no token: ${(tok && tok.error) || 'unknown'}`);
    }
    const expiresIn = Number(tok.expires_in || 3600);
    cache = {
      url: String(d.destinationConfiguration.URL).replace(/\/+$/, ''),
      token: `${tok.type || 'Bearer'} ${tok.value}`,
      expires: Date.now() + Math.max(60, expiresIn - 300) * 1000, // renew 5 min early
    };
    return cache;
  }

  async function current() {
    if (!cache.token || Date.now() > cache.expires) await refresh();
    return cache;
  }

  // ---- OpenTelemetry pipeline -----------------------------------------------------------
  // The exporter URL is only known after the first destination lookup, so the exporter is
  // created lazily; until then records are queued.
  let provider = null;
  let logger = null;
  const pending = [];
  let lastError = '';

  function reportOnce(err) {
    const m = err && err.message ? err.message : String(err);
    if (m !== lastError) { lastError = m; say(`export problem: ${m}`); }
  }

  async function init() {
    const c = await refresh();
    const url = `${c.url}/calm-logs/v1/logs?serviceId=${encodeURIComponent(SERVICE_ID)}` +
      `&useCase=exm&dev=false&tag=${encodeURIComponent(TAG)}`;
    const exporter = new otel.exporter.OTLPLogExporter({
      url,
      headers: async () => {
        try { const k = await current(); return { Authorization: k.token }; }
        catch (e) { reportOnce(e); return {}; }
      },
    });
    const origExport = exporter.export.bind(exporter);
    exporter.export = (records, cb) => origExport(records, (r) => {
      if (r && r.code !== 0) reportOnce(r.error || new Error('export failed'));
      cb(r);
    });

    const appName = (() => {
      try { return JSON.parse(process.env.VCAP_APPLICATION || '{}').application_name; } catch (e) { return null; }
    })() || 'sample.Shop';

    provider = new otel.logs.LoggerProvider({
      resource: otel.resources.resourceFromAttributes({
        'service.name': appName,
        'calm.service.id': SERVICE_ID,
      }),
      processors: [new otel.logs.BatchLogRecordProcessor({ exporter, scheduledDelayMillis: 5000 })],
    });
    logger = provider.getLogger('calm-otel');
    say(`exporting logs (min level ${process.env.CALM_MIN_LEVEL || 'info'}) to Cloud ALM service ${SERVICE_ID}`);
    pending.splice(0).forEach((r) => logger.emit(r));
  }

  // ---- Turn a log line into a log record --------------------------------------------------
  function toRecord(line, fromStderr) {
    let level = fromStderr ? 'warning' : 'info';
    let body = line;
    const attributes = { 'log.stream': fromStderr ? 'stderr' : 'stdout' };
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        level = String(j.level || level).toLowerCase();
        body = j.msg || line;
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

  function emit(rec) {
    if (logger) logger.emit(rec);
    else if (pending.length < 1000) pending.push(rec);
  }

  function hook(stream, orig, fromStderr) {
    let buf = '';
    stream.write = function (chunk, encoding, cb) {
      try {
        buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding && typeof encoding === 'string' ? encoding : 'utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line && !line.startsWith('[calm-otel]')) {
            const rec = toRecord(line, fromStderr);
            if (rec) emit(rec);
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
    emit({ severityNumber: LEVELS.fatal, severityText: 'FATAL', body: String(err && err.stack || err),
      attributes: { 'exception.type': err && err.name || 'Error' } });
  });

  const flush = () => { if (provider) provider.forceFlush().catch(() => {}); };
  process.on('SIGTERM', flush);
  process.on('beforeExit', flush);

  init().catch((e) => {
    reportOnce(e);
    // retry every minute until the destination works
    const timer = setInterval(() => {
      init().then(() => clearInterval(timer)).catch(reportOnce);
    }, 60000);
    timer.unref();
  });
}

try { start(); } catch (e) { say(`disabled: ${e.message}`); }
