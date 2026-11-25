/*
 * Browser-side error collector for SAP Cloud ALM (no OpenTelemetry).
 * Catches JavaScript errors in the UI and sends them to the approuter (POST /calm/ui-log),
 * which forwards them to SAP Cloud ALM (see ../server.js and ../calm-push.js).
 *
 * Captured:
 *  - uncaught JavaScript errors (window "error" event), e.g. TypeError: Cannot read properties of null
 *  - unhandled promise rejections
 *  - UI5 log errors (sap/base/Log) and warnings/errors logged by this app (component nw.epm.refapps.shop...)
 * Loaded in index.html before the UI5 bootstrap so it also catches errors during startup.
 */
(function () {
	"use strict";

	var ENDPOINT = "/calm/ui-log";
	var APP_COMPONENT = "nw.epm.refapps.shop";
	var MAX_PER_PAGE = 50; // never flood the backend from one page
	var queue = [];
	var sent = 0;
	var timer = null;
	var lastKey = "";

	function page() {
		return window.location.pathname + window.location.hash;
	}

	function send() {
		timer = null;
		if (!queue.length) {
			return;
		}
		var body = JSON.stringify({ records: queue.splice(0, 20) });
		try {
			window.fetch(ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				keepalive: true,
				body: body
			})["catch"](function () { /* monitoring must never break the UI */ });
		} catch (e) { /* ignore */ }
		if (queue.length) {
			timer = window.setTimeout(send, 1000);
		}
	}

	function report(level, message, type, stack, source, component) {
		var key = level + "|" + message;
		if (key === lastKey || sent >= MAX_PER_PAGE) {
			return; // skip direct duplicates (same error reported twice by different hooks)
		}
		lastKey = key;
		sent++;
		queue.push({
			level: level,
			message: String(message || "Unknown UI error").slice(0, 2000),
			type: type,
			stack: stack ? String(stack).slice(0, 4000) : undefined,
			source: source,
			component: component,
			page: page()
		});
		if (!timer) {
			timer = window.setTimeout(send, 500);
		}
	}

	window.addEventListener("error", function (oEvent) {
		var err = oEvent.error;
		if (!err && oEvent.target && oEvent.target !== window) {
			return; // failed <img>/<script> load - not a JavaScript exception
		}
		report("error", err && err.message ? err.message : oEvent.message, err && err.name ? err.name : "Error",
			err && err.stack, (oEvent.filename || "") + ":" + (oEvent.lineno || 0) + ":" + (oEvent.colno || 0));
	});

	window.addEventListener("unhandledrejection", function (oEvent) {
		var r = oEvent.reason;
		report("error", "Unhandled promise rejection: " + (r && r.message ? r.message : r),
			r && r.name ? r.name : "UnhandledRejection", r && r.stack, "promise");
	});

	window.addEventListener("pagehide", send);

	// UI5 logs: all errors, plus warnings written by this app's own code
	function hookUI5Log() {
		sap.ui.require(["sap/base/Log"], function (Log) {
			Log.setLevel(Log.Level.WARNING, APP_COMPONENT + ".S2_ProductList");
			Log.addLogListener({
				onLogEntry: function (e) {
					var own = (e.component || "").indexOf(APP_COMPONENT) === 0;
					if (e.level === Log.Level.ERROR || e.level === Log.Level.FATAL) {
						report("error", e.message + (e.details ? " - " + e.details : ""), "UI5LogError", undefined, "sap/base/Log", e.component);
					} else if (e.level === Log.Level.WARNING && own) {
						report("warn", e.message + (e.details ? " - " + e.details : ""), undefined, undefined, "sap/base/Log", e.component);
					}
				}
			});
		});
	}

	var wait = window.setInterval(function () {
		if (window.sap && sap.ui && sap.ui.require) {
			window.clearInterval(wait);
			hookUI5Log();
		}
	}, 50);
	window.setTimeout(function () { window.clearInterval(wait); }, 30000);
}());
