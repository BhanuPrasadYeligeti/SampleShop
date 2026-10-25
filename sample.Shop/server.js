'use strict';
/*
 * sample.Shop application router with SAP Cloud ALM exception monitoring - without OpenTelemetry.
 *
 * - calm-push.js sends warnings/errors straight to the SAP Cloud ALM Raw Data Inbound Logs API
 *   (destination CALM_datacollector, OAuth2 client credentials) -> Integration & Exception Monitoring -> Exceptions
 * - approuter side: every failed request (4xx = warning, 5xx = error) and every unexpected exception
 * - UI side: webapp/calm-ui-logger.js catches browser errors (window.onerror, unhandled promise rejections,
 *   UI5 Log errors/warnings) and posts them to POST /calm/ui-log on this approuter, which forwards them
 * All of it is also written to the application log with cf-nodejs-logging-support.
 */
const log = require('cf-nodejs-logging-support');
const approuter = require('@sap/approuter');
const calm = require('./calm-push');

log.setLoggingLevel(process.env.LOG_LEVEL || 'info');
const logger = log.createLogger({ component: 'sample.Shop' });
calm.start((level, msg) => logger[level](`[calm-push] ${msg}`));

const ar = approuter();

// --- browser (UI) logs -> SAP Cloud ALM ---
const UI_MAX_BODY = 32 * 1024; // bytes per request
const UI_MAX_RECORDS = 20; // records per request
const UI_MAX_PER_MINUTE = 300; // protects Cloud ALM quota if a browser loops on an error
let uiWindowStart = Date.now();
let uiCount = 0;

ar.beforeRequestHandler.use('/calm/ui-log', (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > UI_MAX_BODY) { res.statusCode = 413; res.end(); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let records = [];
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      records = Array.isArray(body.records) ? body.records.slice(0, UI_MAX_RECORDS) : [];
    } catch (e) {
      res.statusCode = 400;
      return res.end();
    }
    if (Date.now() - uiWindowStart > 60000) { uiWindowStart = Date.now(); uiCount = 0; }
    for (const r of records) {
      if (++uiCount > UI_MAX_PER_MINUTE) break;
      const level = r.level === 'error' ? 'error' : 'warn';
      const message = String(r.message || 'UI error').slice(0, 2000);
      logger[level](`UI ${level} in sample.Shop: ${message}${r.stack ? '\n' + String(r.stack).slice(0, 4000) : ''}`);
      calm.add(level, 'sample.Shop.ui', `UI: ${message}`, {
        type: r.type,
        stack: r.stack,
        attributes: { 'ui.page': r.page, 'ui.source': r.source, 'ui.component': r.component, 'user_agent.original': req.headers['user-agent'] }
      });
    }
    res.statusCode = 204;
    res.end();
  });
});

// --- approuter: failed requests -> application log + SAP Cloud ALM ---
ar.beforeRequestHandler.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (res.statusCode < 400 || req.originalUrl === '/calm/ui-log') return;
    const msg = `${req.method} ${req.originalUrl || req.url} failed with HTTP ${res.statusCode} (${Date.now() - started} ms)`;
    const level = res.statusCode >= 500 ? 'error' : 'warn';
    logger[level](msg);
    calm.add(level, 'sample.Shop.approuter', msg, {
      correlationId: req.headers['x-vcap-request-id'],
      attributes: { 'http.status_code': res.statusCode }
    });
  });
  next();
});

// --- unexpected exceptions: log, push to Cloud ALM immediately, then let CF restart the app ---
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception in sample.Shop: ${err && err.stack ? err.stack : err}`);
  calm.add('error', 'sample.Shop.approuter', `Uncaught exception: ${err && err.message ? err.message : err}`, {
    type: (err && err.name) || 'Error',
    stack: err && err.stack
  });
  process.exitCode = 1;
  calm.flush().finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection in sample.Shop: ${reason && reason.stack ? reason.stack : reason}`);
  calm.add('error', 'sample.Shop.approuter', `Unhandled promise rejection: ${reason && reason.message ? reason.message : reason}`, {
    type: (reason && reason.name) || 'UnhandledRejection',
    stack: reason && reason.stack
  });
});

ar.start();
logger.info(calm.enabled()
  ? 'sample.Shop started - warnings/errors (approuter + UI) are pushed to SAP Cloud ALM'
  : 'sample.Shop started - SAP Cloud ALM push disabled (set SAP_CALM_PUSH_ENABLED and SAP_CALM_PUSH_SERVICE_ID)');
