'use strict';
/*
 * sample.Shop application router with SAP Cloud ALM exception monitoring.
 *
 * SAP's supported setup (SAP Cloud ALM Expert Portal -> OpenTelemetry@SAP ->
 * "Auto-instrumentation for Node.js" + "Additional steps for Exception Monitoring"):
 *   - the SAP Cloud ALM agent @sap/xotel-agent-ext-js is loaded first (below); it is downloaded
 *     from SAP's repository (RBSC) at build time using the SAP_NPM_AUTH credentials (.npmrc)
 *   - application logs are written with cf-nodejs-logging-support; the agent picks up
 *     error-level log records and sends them to SAP Cloud ALM (destination CALM_datacollector,
 *     service type SAP_CP_CF / name from SAP_CALM_SERVICE_* in mta.yaml)
 *   - the agent is an optional dependency: without SAP_NPM_AUTH the app still builds and runs,
 *     it just logs that the Cloud ALM agent is not installed
 *
 * The approuter itself logs through @sap/logging, which the agent does not collect.
 * This file starts the same approuter and additionally writes every failed request
 * (HTTP status >= 400) and every unexpected exception with cf-nodejs-logging-support,
 * so they show up in Cloud ALM Integration & Exception Monitoring ("Node.js Application Logs").
 */
// Load the SAP Cloud ALM agent before anything else (same effect as `node -r @sap/xotel-agent-ext-js`).
let calmAgent = false;
try {
  require('@sap/xotel-agent-ext-js');
  calmAgent = true;
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
}

const log = require('cf-nodejs-logging-support');
const approuter = require('@sap/approuter');

log.setLoggingLevel(process.env.LOG_LEVEL || 'info');
const logger = log.createLogger({ component: 'sample.Shop' });

const ar = approuter();

ar.beforeRequestHandler.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    // 4xx and 5xx are both logged as errors so they are visible in Cloud ALM
    logger.error(`${req.method} ${req.url} failed with HTTP ${res.statusCode} (${Date.now() - started} ms)`);
  });
  next();
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception in sample.Shop: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection in sample.Shop: ${reason && reason.stack ? reason.stack : reason}`);
});

ar.start();
logger.info(calmAgent
  ? 'sample.Shop started - SAP Cloud ALM agent loaded, error logs are sent to Cloud ALM'
  : 'sample.Shop started - SAP Cloud ALM agent NOT installed (build without SAP_NPM_AUTH), no data is sent to Cloud ALM');
