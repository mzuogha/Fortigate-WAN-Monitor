/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Web server, REST API, live (SSE) feed, FortiGate webhook receiver and polling loop.
 *
 * CLI:
 *   node server.js                         start the monitor
 *   node server.js --set-password          set the dashboard password (enables remote access)
 *   node server.js --show-webhook-token    print the token the FortiGate webhook must send
 *   node server.js --set-port 5000         change the listening port (used by install.ps1)
 *   node server.js --data-dir <folder>     keep the database and log in <folder>
 *   node server.js --get-port              print the configured listening port
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

// --data-dir <folder> must be applied before config.js is loaded
if (require.main === module) {
  const i = process.argv.indexOf('--data-dir');
  if (i > 0 && process.argv[i + 1]) {
    const dir = path.resolve(process.argv[i + 1]);
    fs.mkdirSync(dir, { recursive: true });
    process.env.WANMON_DATA_DIR = dir;
  }
}

const crypto = require('node:crypto');
const readline = require('node:readline');
const os = require('node:os');
const EventEmitter = require('node:events');
const { execFile } = require('node:child_process');

const defaultConfig = require('./config');
const MonitorDB = require('./db');
const FortiGateClient = require('./fortigate-client');
const ProbeEngine = require('./probe-engine');
const AlertManager = require('./alert-manager');
const reports = require('./report-generator');

const MASK = '••••••••';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Secrets that are masked in GET /api/settings and kept when the masked value is posted back
const SECRET_FIELDS = [
  ['fortigate', 'apiToken'],
  ['notifications', 'email', 'pass'],
  ['notifications', 'whatsapp', 'apiKey'],
  ['notifications', 'whatsapp', 'authToken'],
  ['notifications', 'whatsapp', 'webhookUrl'],
  ['notifications', 'telegram', 'botToken'],
  ['notifications', 'discord', 'webhookUrl'],
  ['notifications', 'slack', 'webhookUrl'],
  ['notifications', 'teams', 'webhookUrl']
];

// ---------------------------------------------------------------------------- helpers
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function getPath(obj, keys) {
  return keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, keys, value) {
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

function isMasked(v) {
  return typeof v === 'string' && v.startsWith('••••');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt$')) return safeEqual(password, stored); // plain value from env var
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal)
    .map(a => a.address);
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseJsonBody(req, { requireJson = true } = {}) {
  return new Promise((resolve, reject) => {
    if (requireJson && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      // Blocks cross-site "simple" form posts (CSRF) against the API
      reject(new HttpError(415, 'Content-Type must be application/json'));
      return;
    }
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        resolve(isPlainObject(parsed) ? parsed : { message: String(parsed) });
      } catch {
        // FortiGate webhooks sometimes send plain text; keep it as the message
        if (!requireJson) return resolve({ message: body });
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------- CLI
async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function runCli(args, db) {
  if (args.includes('--set-password')) {
    const idx = args.indexOf('--set-password');
    const next = args[idx + 1];
    // WANMON_NEW_PASSWORD lets the installer pass the password without exposing it on a command line
    let pw = process.env.WANMON_NEW_PASSWORD ||
      (next && !next.startsWith('--') ? next : await prompt('New dashboard password (min 8 characters): '));
    pw = String(pw || '').trim();
    if (pw.length < 8) {
      console.error('Password must be at least 8 characters.');
      process.exit(1);
    }
    const sec = db.getSetting('security', {}) || {};
    db.setSetting('security', { ...sec, passwordHash: hashPassword(pw) });
    console.log(`Dashboard password set. Log in as user "${defaultConfig.security.dashboardUser}". ` +
      'Restart the monitor for it to take effect (installed copies: wanmon.cmd restart).');
    process.exit(0);
  }
  if (args.includes('--set-port')) {
    const port = Number(args[args.indexOf('--set-port') + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('Usage: node server.js --set-port <1-65535>');
      process.exit(1);
    }
    db.setSetting('server', { ...(db.getSetting('server', {}) || {}), port });
    console.log(`Listening port set to ${port}. Restart the monitor for it to take effect.`);
    process.exit(0);
  }
  if (args.includes('--get-port')) {
    const stored = (db.getSetting('server', {}) || {}).port;
    console.log(process.env.PORT || stored || defaultConfig.port);
    process.exit(0);
  }
  if (args.includes('--show-webhook-token')) {
    const sec = db.getSetting('security', {}) || {};
    console.log(defaultConfig.security.webhookToken || sec.webhookToken || '(not generated yet - start the monitor once)');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------- app
function createApp(options = {}) {
  const db = options.db || new MonitorDB(options.dbPath || defaultConfig.dbPath);
  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(100);

  // Merge defaults with settings saved from the dashboard (deep merge, so new defaults
  // such as additional notification fields still appear for existing installs)
  const stored = db.getAllSettings();
  let appConfig = deepMerge(defaultConfig, {
    fortigate: stored.fortigate || {},
    thresholds: stored.thresholds || {},
    notifications: stored.notifications || {},
    simulation: stored.simulation || {},
    reports: stored.reports || {}
  });
  // Port chosen in Settings > Server (the PORT environment variable takes precedence)
  if (!process.env.PORT && Number.isInteger(stored.server?.port)) appConfig.port = stored.server.port;
  appConfig = deepMerge(appConfig, options.configOverrides || {});
  // Environment variables win over values stored from the dashboard
  if (process.env.FORTIGATE_API_TOKEN) appConfig.fortigate.apiToken = process.env.FORTIGATE_API_TOKEN;
  if (process.env.FORTIGATE_HOST) appConfig.fortigate.host = process.env.FORTIGATE_HOST;

  // Security material
  const storedSecurity = stored.security || {};
  const security = {
    user: appConfig.security.dashboardUser,
    passwordHash: appConfig.security.dashboardPassword || storedSecurity.passwordHash || '',
    webhookToken: appConfig.security.webhookToken || storedSecurity.webhookToken || ''
  };
  if (!security.webhookToken) {
    security.webhookToken = crypto.randomBytes(24).toString('base64url');
    db.setSetting('security', { ...storedSecurity, webhookToken: security.webhookToken });
  }

  const fortigateClient = new FortiGateClient(appConfig.fortigate);
  const probeEngine = new ProbeEngine({ simulationEnabled: appConfig.simulation.enabled });
  const alertManager = new AlertManager({ config: appConfig, db, eventEmitter: eventBus });
  alertManager.closeStaleIncidents();

  const sseClients = new Set();
  const loginFailures = new Map(); // ip -> { count, first }

  const linkState = (linkId) => ({
    linkId,
    label: appConfig.fortigate[`${linkId}Label`],
    interface: appConfig.fortigate[`${linkId}Interface`],
    latency: null,
    packetLoss: null,
    jitter: null,
    status: 'UNKNOWN',
    linkState: 'unknown',
    rxKbps: null,
    txKbps: null,
    lastUpdate: null,
    since: Date.now(),
    source: 'init',
    reason: 'Waiting for first sample',
    issues: []
  });

  const currentState = {
    wan1: linkState('wan1'),
    wan2: linkState('wan2'),
    fortigateStatus: { connected: false, hostname: null, version: null, lastError: null, consecutiveFailures: 0 },
    isSimulating: !!appConfig.simulation.enabled
  };

  let apiAlerted = false;
  let hostnameFetched = false;
  const timers = [];
  let pollTimer = null;
  let stopped = false;

  function snapshot() {
    return {
      wan1: currentState.wan1,
      wan2: currentState.wan2,
      fortigateStatus: currentState.fortigateStatus,
      isSimulating: currentState.isSimulating,
      thresholds: appConfig.thresholds,
      timestamp: Date.now()
    };
  }

  function broadcastSse(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(msg);
  }

  eventBus.on('alert', (alert) => broadcastSse('alert', alert));

  function markLinksUnknown(reason) {
    for (const linkId of ['wan1', 'wan2']) {
      currentState[linkId] = {
        ...currentState[linkId],
        label: appConfig.fortigate[`${linkId}Label`],
        interface: appConfig.fortigate[`${linkId}Interface`],
        stale: true,
        reason
      };
    }
  }

  function handleApiFailure(message) {
    const st = currentState.fortigateStatus;
    st.connected = false;
    st.lastError = message;
    st.consecutiveFailures += 1;
    markLinksUnknown(`No fresh data: ${message}`);
    const limit = appConfig.fortigate.apiFailuresToAlert || 4;
    if (st.consecutiveFailures >= limit && !apiAlerted) {
      apiAlerted = true;
      alertManager.sendAlert({
        type: 'MONITOR_API_DOWN',
        linkId: 'system',
        severity: 'CRITICAL',
        title: 'Monitor lost contact with the FortiGate',
        message: `${st.consecutiveFailures} consecutive polls failed. WAN link status is unknown until this clears. ` +
          `Last error: ${message}`
      });
    }
  }

  function handleApiSuccess() {
    const st = currentState.fortigateStatus;
    if (apiAlerted) {
      alertManager.sendAlert({
        type: 'MONITOR_API_RESTORED',
        linkId: 'system',
        severity: 'RECOVERED',
        title: 'Monitor reconnected to the FortiGate',
        message: 'FortiGate API polling has resumed.'
      });
    }
    apiAlerted = false;
    st.connected = true;
    st.lastError = null;
    st.consecutiveFailures = 0;
    if (!hostnameFetched) {
      hostnameFetched = true;
      fortigateClient.testConnection().then((info) => {
        if (info.success) {
          st.hostname = info.hostname;
          st.version = info.version;
        }
      }).catch(() => {});
    }
  }

  function applySample(linkId, sample, now) {
    const base = {
      ...currentState[linkId],
      label: appConfig.fortigate[`${linkId}Label`],
      interface: appConfig.fortigate[`${linkId}Interface`],
      stale: false
    };

    if (!sample || sample.status === 'unknown') {
      currentState[linkId] = { ...base, status: 'UNKNOWN', linkState: 'unknown', reason: sample?.reason || 'No data', lastUpdate: now };
      return;
    }

    sample.timestamp = now;
    sample.linkId = linkId;
    const evalResult = alertManager.evaluateMetric(linkId, sample);
    sample.level = evalResult.status;
    db.saveMetric(sample);

    currentState[linkId] = {
      ...base,
      latency: sample.latency,
      packetLoss: sample.packetLoss,
      jitter: sample.jitter,
      status: evalResult.status,
      since: evalResult.since,
      linkState: sample.carrierDown ? 'down' : (sample.status === 'down' ? 'no-traffic' : 'up'),
      rxKbps: sample.rxKbps ?? base.rxKbps,
      txKbps: sample.txKbps ?? base.txKbps,
      healthCheck: sample.healthCheck || null,
      lastUpdate: now,
      source: sample.source || 'monitor',
      reason: null,
      issues: evalResult.issues || []
    };
  }

  // -------------------------------------------------------------------------- polling
  let inflight = null;
  function pollCycle() {
    // Concurrent callers share the running poll instead of silently skipping it
    if (!inflight) inflight = doPoll().finally(() => { inflight = null; });
    return inflight;
  }

  async function doPoll() {
    if (stopped) return;
    const now = Date.now();
    try {
      let metrics = null;
      currentState.isSimulating = !!appConfig.simulation.enabled;

      if (appConfig.simulation.enabled) {
        metrics = probeEngine.getSimulatedMetrics();
      } else if (!appConfig.fortigate.apiToken) {
        currentState.fortigateStatus.connected = false;
        currentState.fortigateStatus.lastError = 'FortiGate API token is not configured (Settings > FortiGate API)';
        markLinksUnknown('FortiGate API is not configured yet');
      } else {
        try {
          metrics = await fortigateClient.getLinkMetrics();
          handleApiSuccess();
        } catch (err) {
          handleApiFailure(err.message);
        }
      }

      if (metrics) {
        applySample('wan1', metrics.wan1, now);
        applySample('wan2', metrics.wan2, now);
        alertManager.checkReminders();
      }
      broadcastSse('metrics', snapshot());
    } catch (err) {
      console.error(`[Poll Error]: ${err.stack || err.message}`);
    }
  }

  // -------------------------------------------------------------------------- auth
  function authorize(req, res, pathname, url) {
    const ip = req.socket.remoteAddress || '';

    // The FortiGate webhook authenticates with its own shared secret
    if (pathname === '/api/webhook/fortigate') {
      const auth = req.headers.authorization || '';
      const supplied = (auth.startsWith('Bearer ') ? auth.slice(7) : '') ||
        req.headers['x-webhook-token'] || url.searchParams.get('token') || '';
      if (supplied && safeEqual(supplied, security.webhookToken)) return true;
      sendJson(res, 401, { error: 'Invalid or missing webhook token' });
      return false;
    }

    if (!security.passwordHash) {
      // No password set: the dashboard is only available on this machine.
      // The Host check also defeats DNS-rebinding attacks from a browser on this PC.
      const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      const localHost = ['localhost', '127.0.0.1', '::1'].includes(hostHeader);
      if (isLoopback(ip) && localHost) return true;
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Remote access is disabled until a dashboard password is set.\n' +
        'On the monitoring server, in an Administrator command prompt, run:\n' +
        '  "C:\\Program Files\\FortiGate WAN Monitor\\wanmon.cmd" --set-password\n' +
        '  "C:\\Program Files\\FortiGate WAN Monitor\\wanmon.cmd" restart\n' +
        '(or "node server.js --set-password" when running from a folder)\n' +
        `or open http://localhost:${appConfig.port || 4000} on the server itself.`);
      return false;
    }

    const f = loginFailures.get(ip);
    if (f && f.count >= 10 && Date.now() - f.first < 15 * 60000) {
      sendJson(res, 429, { error: 'Too many failed logins. Try again in 15 minutes.' });
      return false;
    }

    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (sep > 0 && safeEqual(user, security.user) && verifyPassword(pass, security.passwordHash)) {
        loginFailures.delete(ip);
        return true;
      }
      const entry = f && Date.now() - f.first < 15 * 60000 ? f : { count: 0, first: Date.now() };
      entry.count += 1;
      loginFailures.set(ip, entry);
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FortiGate WAN Monitor", charset="UTF-8"', 'Content-Type': 'text/plain' });
    res.end('Authentication required');
    return false;
  }

  // -------------------------------------------------------------------------- settings
  function maskedConfig() {
    const safe = JSON.parse(JSON.stringify(appConfig));
    delete safe.security;
    for (const keys of SECRET_FIELDS) {
      const v = getPath(safe, keys);
      if (v) setPath(safe, keys, keys[keys.length - 1] === 'apiToken' ? MASK + String(v).slice(-4) : MASK);
    }
    safe.fortigate.hasToken = !!appConfig.fortigate.apiToken;
    safe.webhook = { token: security.webhookToken, path: '/api/webhook/fortigate' };
    safe.security = { passwordSet: !!security.passwordHash, user: security.user };
    safe.server = { port: currentPort(), envOverride: !!process.env.PORT, addresses: lanAddresses() };
    return safe;
  }

  /** Replace masked placeholders in an incoming payload with the stored secret. */
  function unmask(payload) {
    for (const keys of SECRET_FIELDS) {
      if (isMasked(getPath(payload, keys))) setPath(payload, keys, getPath(appConfig, keys));
    }
    return payload;
  }

  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
  };

  function sanitizeThresholds(t = {}) {
    const out = {};
    const spec = {
      packetLossWarning: [0, 100], packetLossCritical: [0, 100],
      latencyWarningMs: [1, 10000], latencyCriticalMs: [1, 10000],
      jitterWarningMs: [1, 10000], jitterCriticalMs: [1, 10000],
      consecutiveFailsToAlert: [1, 50], consecutiveHealthyToRecover: [1, 100],
      flapWindowSeconds: [30, 86400], flapThresholdCount: [2, 100], reminderMinutes: [0, 1440]
    };
    for (const [k, [min, max]] of Object.entries(spec)) {
      if (t[k] !== undefined && t[k] !== null && t[k] !== '') {
        const v = num(t[k], min, max);
        if (v !== undefined) out[k] = v;
      }
    }
    return out;
  }

  function saveSettings(body) {
    unmask(body);
    if (isPlainObject(body.thresholds)) {
      appConfig.thresholds = { ...appConfig.thresholds, ...sanitizeThresholds(body.thresholds) };
      db.setSetting('thresholds', appConfig.thresholds);
    }
    if (isPlainObject(body.notifications)) {
      for (const [channel, cfg] of Object.entries(body.notifications)) {
        if (!isPlainObject(cfg) || !isPlainObject(appConfig.notifications[channel])) continue;
        appConfig.notifications[channel] = { ...appConfig.notifications[channel], ...cfg };
      }
      db.setSetting('notifications', appConfig.notifications);
    }
    if (isPlainObject(body.fortigate)) {
      const f = body.fortigate;
      const allowed = ['host', 'apiToken', 'vdom', 'healthCheckName', 'wan1Interface', 'wan2Interface', 'wan1Label', 'wan2Label', 'siteName'];
      for (const k of allowed) {
        if (typeof f[k] === 'string' && f[k].trim()) appConfig.fortigate[k] = f[k].trim();
      }
      if (f.rejectUnauthorized !== undefined) appConfig.fortigate.rejectUnauthorized = !!f.rejectUnauthorized;
      if (f.pollIntervalMs !== undefined) {
        const v = num(f.pollIntervalMs, 2000, 300000);
        if (v !== undefined) appConfig.fortigate.pollIntervalMs = v;
      }
      fortigateClient.updateConfig(appConfig.fortigate);
      hostnameFetched = false;
      db.setSetting('fortigate', appConfig.fortigate);
    }
    if (isPlainObject(body.reports)) {
      const r = body.reports;
      if (r.dailyEnabled !== undefined) appConfig.reports.dailyEnabled = !!r.dailyEnabled;
      if (r.dailyTime !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.dailyTime))) throw new HttpError(400, 'Daily report time must be HH:MM (24-hour)');
        appConfig.reports.dailyTime = String(r.dailyTime);
      }
      db.setSetting('reports', appConfig.reports);
    }
    alertManager.updateConfig(appConfig);
  }

  // -------------------------------------------------------------------------- daily reports
  function linkLabels() {
    return { wan1: alertManager.linkLabel('wan1'), wan2: alertManager.linkLabel('wan2') };
  }

  function generateReport(date) {
    return reports.buildDailyReport({
      db,
      date,
      links: linkLabels(),
      site: alertManager.siteName(),
      pollIntervalMs: appConfig.fortigate.pollIntervalMs
    });
  }

  function sendReport(date) {
    const report = generateReport(date);
    alertManager.sendDailyReport(report, {
      html: reports.renderHtml(report, { fragment: true }),
      text: reports.renderText(report)
    });
    return report;
  }

  /**
   * Called every minute: once the configured time has passed, send yesterday's report
   * (exactly once per day, also after a restart later that day).
   */
  function checkDailyReport(now = new Date()) {
    const cfg = appConfig.reports || {};
    if (!cfg.dailyEnabled) return null;
    const [hh, mm] = String(cfg.dailyTime || '07:00').split(':').map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return null;
    const target = reports.yesterday(now);
    const state = db.getSetting('reportState', {}) || {};
    if (state.lastSentFor === target) return null;
    db.setSetting('reportState', { ...state, lastSentFor: target, sentAt: Date.now() });
    try {
      const report = generateReport(target);
      if (!report.hasData) {
        console.log(`[Reports] No data recorded for ${target}; daily report skipped.`);
        return null;
      }
      alertManager.sendDailyReport(report, {
        html: reports.renderHtml(report, { fragment: true }),
        text: reports.renderText(report)
      });
      console.log(`[Reports] Daily report for ${target} sent.`);
      return report;
    } catch (err) {
      console.error(`[Reports] Failed to generate daily report for ${target}: ${err.message}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------- listening port
  function currentPort() {
    const addr = server && server.address();
    return addr && typeof addr === 'object' ? addr.port : appConfig.port;
  }

  function updateWindowsFirewall(oldPort, newPort) {
    if (process.platform !== 'win32') {
      return Promise.resolve(`Make sure your firewall allows inbound TCP ${newPort}.`);
    }
    // Names are passed via environment variables, never interpolated into the script
    const script = [
      '$new = "FortiGate WAN Monitor (Port $env:WANMON_NEW_PORT)"',
      'if (-not (Get-NetFirewallRule -DisplayName $new -ErrorAction SilentlyContinue)) {',
      '  New-NetFirewallRule -DisplayName $new -Direction Inbound -Action Allow -Protocol TCP -LocalPort $env:WANMON_NEW_PORT -ErrorAction Stop | Out-Null',
      '}',
      'Remove-NetFirewallRule -DisplayName "FortiGate WAN Monitor (Port $env:WANMON_OLD_PORT)" -ErrorAction SilentlyContinue'
    ].join('\n');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        timeout: 20000,
        env: { ...process.env, WANMON_NEW_PORT: String(newPort), WANMON_OLD_PORT: String(oldPort) }
      }, (err) => {
        if (err) {
          resolve(`Could not update Windows Firewall automatically. In an Administrator PowerShell run: ` +
            `Install.cmd -Port ${newPort}`);
        } else {
          resolve(`Windows Firewall now allows TCP ${newPort}.`);
        }
      });
    });
  }

  /**
   * Move the web server to a new port without downtime: listen on the new port first,
   * and only close the old listener once that succeeded.
   */
  async function changePort(newPort) {
    if (process.env.PORT) {
      throw new HttpError(409, `The PORT environment variable (${process.env.PORT}) is set and overrides this setting.`);
    }
    const port = Number(newPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be a whole number between 1 and 65535');
    const oldPort = currentPort();
    if (port === oldPort) return { success: true, port, message: 'Already listening on this port.' };

    const next = http.createServer(requestHandler);
    await new Promise((resolve, reject) => {
      next.once('error', (err) => reject(new HttpError(409, err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use by another program.`
        : err.code === 'EACCES' ? `Not permitted to listen on port ${port} (ports below 1024 need admin rights).`
          : `Cannot listen on port ${port}: ${err.message}`)));
      next.listen(port, appConfig.host, resolve);
    });

    const old = server;
    server = next;
    appConfig.port = port;
    db.setSetting('server', { ...(db.getSetting('server', {}) || {}), port });
    const firewall = await updateWindowsFirewall(oldPort, port);
    setTimeout(() => {
      for (const c of sseClients) c.end();
      old.close();
      if (old.closeAllConnections) old.closeAllConnections();
    }, 2000).unref();
    console.log(`[Server] Now listening on port ${port} (was ${oldPort}).`);
    return { success: true, port, previousPort: oldPort, firewall };
  }

  // -------------------------------------------------------------------------- webhook
  const recentWebhooks = new Map();
  function handleFortigateWebhook(body) {
    const raw = isPlainObject(body.log) ? JSON.stringify(body.log) : String(body.log ?? body.message ?? JSON.stringify(body));
    const text = raw.slice(0, 4000);
    const field = (name) => {
      if (body[name] !== undefined && body[name] !== null) return String(body[name]);
      if (isPlainObject(body.log) && body.log[name] !== undefined) return String(body.log[name]);
      const m = text.match(new RegExp(`\\b${name}="?([^"\\s,}]+)"?`, 'i'));
      return m ? m[1] : null;
    };
    const ifName = field('interface') || field('member');
    const linkId = ['wan1', 'wan2'].find(l => ifName && appConfig.fortigate[`${l}Interface`] === ifName) || null;
    const status = (field('status') || field('state') || '').toLowerCase();
    const recovered = /^(up|alive|pass|sla_pass)$/.test(status);

    // FortiGate can fire the same event repeatedly; notify at most once a minute per link/status
    const key = `${linkId || ifName}:${status}`;
    if (Date.now() - (recentWebhooks.get(key) || 0) < 60000) return { received: true, deduplicated: true };
    recentWebhooks.set(key, Date.now());

    const label = linkId ? alertManager.linkLabel(linkId) : (ifName || 'SD-WAN');
    const msg = (field('msg') || text).replace(/[\r\n]+/g, ' ').slice(0, 300);
    alertManager.sendAlert({
      type: 'FORTIGATE_WEBHOOK_EVENT',
      linkId: linkId || 'system',
      severity: recovered ? 'RECOVERED' : 'CRITICAL',
      title: `FortiGate reported: ${label} ${recovered ? 'is back up' : `SLA status ${status || 'changed'}`}`,
      message: `Automation Stitch event: ${msg}`
    });
    return { received: true, linkId, interface: ifName, status: status || null };
  }

  // -------------------------------------------------------------------------- static files
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };

  function serveStatic(pathname, res) {
    let rel;
    try {
      rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    let filePath = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(rel)}`);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      res.end('Access denied');
      return;
    }
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        if (path.extname(filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        filePath = path.join(PUBLIC_DIR, 'index.html');
      }
      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        res.end(content);
      });
    });
  }

  // -------------------------------------------------------------------------- routes
  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");

    if (!authorize(req, res, pathname, url)) return;

    if (pathname === '/api/webhook/fortigate' && req.method === 'POST') {
      const body = await parseJsonBody(req, { requireJson: false });
      return sendJson(res, 200, handleFortigateWebhook(body));
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`retry: 3000\nevent: metrics\ndata: ${JSON.stringify(snapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return undefined;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        ...snapshot(),
        activeIncidents: [db.getActiveIncident('wan1'), db.getActiveIncident('wan2')].filter(Boolean),
        alertQueue: alertManager.queue.length
      });
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      const minutes = num(url.searchParams.get('minutes') || 60, 1, 7 * 1440) || 60;
      return sendJson(res, 200, db.getMetricHistory(minutes));
    }

    if (pathname === '/api/incidents' && req.method === 'GET') {
      const limit = num(url.searchParams.get('limit') || 30, 1, 500) || 30;
      return sendJson(res, 200, db.getRecentIncidents(limit));
    }

    if (pathname === '/api/report' && req.method === 'GET') {
      const hours = num(url.searchParams.get('hours') || 24, 1, 24 * 90) || 24;
      const report = db.getAvailabilityReport(hours);
      report.links = report.links.map(l => ({ ...l, label: alertManager.linkLabel(l.linkId) }));
      return sendJson(res, 200, report);
    }

    if (pathname === '/api/reports/daily' && req.method === 'GET') {
      const date = url.searchParams.get('date') || reports.yesterday();
      let report;
      try {
        report = generateReport(date);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      const format = url.searchParams.get('format') || 'json';
      const download = url.searchParams.get('download') === '1';
      const filename = `wan-report-${date}`;
      if (format === 'html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(download ? { 'Content-Disposition': `attachment; filename="${filename}.html"` } : {})
        });
        return res.end(reports.renderHtml(report));
      }
      if (format === 'csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${filename}.csv"`
        });
        return res.end(`\ufeff${reports.renderCsv(report)}`);
      }
      return sendJson(res, 200, { ...report, text: reports.renderText(report) });
    }

    if (pathname === '/api/reports/daily/send' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const channels = alertManager.enabledChannels();
      if (!channels.length) throw new HttpError(400, 'No notification channels are enabled. Enable one under Notifications & Alerts.');
      let report;
      try {
        report = sendReport(body.date || reports.yesterday());
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      return sendJson(res, 200, { success: true, message: `Report for ${report.date} sent via ${channels.join(', ')}.` });
    }

    if (pathname === '/api/server/port' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      return sendJson(res, 200, await changePort(body.port));
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, maskedConfig());
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      saveSettings(await parseJsonBody(req));
      return sendJson(res, 200, { success: true, message: 'Settings saved successfully' });
    }

    if (pathname === '/api/test-alert' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const channel = String(body.channel || 'windowsToast');
      // Test with the values in the form without changing the live configuration.
      // Masked secrets fall back to the stored values.
      const overrides = {};
      if (isPlainObject(body.emailConfig)) {
        overrides.email = unmask({ notifications: { email: { ...body.emailConfig } } }).notifications.email;
      }
      if (isPlainObject(body.whatsappConfig)) {
        overrides.whatsapp = unmask({ notifications: { whatsapp: { ...body.whatsappConfig } } }).notifications.whatsapp;
      }
      const pick = (ch, keys) => {
        const merged = { ...appConfig.notifications[ch] };
        for (const [bodyKey, cfgKey] of keys) {
          const v = body[bodyKey];
          if (v && !isMasked(v)) merged[cfgKey] = v;
        }
        return merged;
      };
      if (channel === 'telegram') overrides.telegram = pick('telegram', [['botToken', 'botToken'], ['chatId', 'chatId']]);
      if (['discord', 'slack', 'teams'].includes(channel)) overrides[channel] = pick(channel, [['webhookUrl', 'webhookUrl']]);

      const testAlert = {
        type: 'TEST_ALERT',
        test: true,
        linkId: 'system',
        severity: 'WARNING',
        timestamp: Date.now(),
        site: alertManager.siteName(),
        title: 'Test alert from FortiGate WAN Monitor',
        message: `If you can read this, ${channel} notifications are working.`,
        overview: alertManager.overview().text
      };
      try {
        await alertManager.sendToChannel(channel, testAlert, Object.keys(overrides).length ? overrides : null);
        return sendJson(res, 200, { success: true, message: `Test alert sent via ${channel}!` });
      } catch (err) {
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }

    if (pathname === '/api/simulation' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (body.enabled !== undefined && !!body.enabled !== !!appConfig.simulation.enabled) {
        appConfig.simulation.enabled = !!body.enabled;
        probeEngine.setSimulation(appConfig.simulation.enabled);
        db.setSetting('simulation', appConfig.simulation);
        // Never carry simulated link states into real monitoring (or vice versa)
        alertManager.closeStaleIncidents();
        alertManager.resetStates();
        currentState.wan1 = linkState('wan1');
        currentState.wan2 = linkState('wan2');
        currentState.isSimulating = appConfig.simulation.enabled;
      }
      if (body.condition && ['wan1', 'wan2'].includes(body.linkId)) {
        probeEngine.setSimulatedCondition(body.linkId, String(body.condition));
      }
      return sendJson(res, 200, { success: true, simulationEnabled: appConfig.simulation.enabled, condition: body.condition });
    }

    if (pathname === '/api/fortigate/test' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const host = String(body.host || appConfig.fortigate.host || '').trim();
      let token = body.apiToken;
      if (!token || isMasked(token)) {
        const norm = (h) => String(h).trim().replace(/\/+$/, '').replace(/^(?!https?:\/\/)/i, 'https://').toLowerCase();
        if (norm(host) !== norm(appConfig.fortigate.host)) {
          // Never send the stored token to a different host
          return sendJson(res, 200, { success: false, error: 'Enter the API token to test a different FortiGate host.' });
        }
        token = appConfig.fortigate.apiToken;
      }
      const testClient = new FortiGateClient({
        ...appConfig.fortigate,
        host,
        apiToken: token,
        vdom: body.vdom || appConfig.fortigate.vdom,
        healthCheckName: body.healthCheckName || appConfig.fortigate.healthCheckName,
        wan1Interface: body.wan1Interface || appConfig.fortigate.wan1Interface,
        wan2Interface: body.wan2Interface || appConfig.fortigate.wan2Interface
      });
      return sendJson(res, 200, await testClient.testConnection());
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return undefined;
    }
    return serveStatic(pathname, res);
  }

  function requestHandler(req, res) {
    route(req, res).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error(`[HTTP ${req.method} ${req.url}]`, err);
      if (!res.headersSent) sendJson(res, status, { success: false, error: err.message });
      else res.end();
    });
  }
  let server = http.createServer(requestHandler);

  // -------------------------------------------------------------------------- lifecycle

  function scheduleNextPoll() {
    if (stopped) return;
    // Re-read the interval every cycle so changes from Settings apply without a restart
    pollTimer = setTimeout(async () => {
      await pollCycle();
      scheduleNextPoll();
    }, appConfig.fortigate.pollIntervalMs || 5000);
  }

  function prune() {
    try {
      db.pruneOldMetrics((appConfig.metricRetentionDays || 14) * 24);
      db.pruneOldIncidents(365);
    } catch (err) {
      console.error('Error pruning data:', err.message);
    }
  }

  function start(port = appConfig.port, host = appConfig.host) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        prune();
        pollCycle().finally(scheduleNextPoll);
        timers.push(setInterval(prune, 6 * 3600 * 1000));
        timers.push(setInterval(() => alertManager.flushQueue().catch(() => {}), 30000));
        timers.push(setInterval(() => {
          for (const c of sseClients) c.write(': keep-alive\n\n');
        }, 25000));
        timers.push(setInterval(() => checkDailyReport(), 60000));
        setTimeout(() => checkDailyReport(), 5000).unref();
        resolve(server.address());
      });
    });
  }

  async function stop() {
    stopped = true;
    clearTimeout(pollTimer);
    timers.forEach(clearInterval);
    for (const c of sseClients) c.end();
    if (inflight) await inflight.catch(() => {});
    return new Promise((resolve) => {
      server.close(() => {
        try { db.close(); } catch (_) { /* already closed */ }
        resolve();
      });
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return {
    get server() { return server; },
    start, stop, pollCycle, changePort, checkDailyReport, generateReport,
    appConfig, currentState, alertManager, fortigateClient, probeEngine, db, security
  };
}

// ---------------------------------------------------------------------------- file logging
function setupFileLogging(file) {
  const MAX_BYTES = 5 * 1024 * 1024;
  const write = (level, args) => {
    try {
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch (_) { /* file does not exist yet */ }
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`);
    } catch (_) { /* never let logging break the monitor */ }
  };
  for (const [method, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(level, args);
    };
  }
}

// ---------------------------------------------------------------------------- main
if (require.main === module) {
  process.on('unhandledRejection', (err) => console.error('[Unhandled rejection]', err));
  const cliOnly = ['--set-password', '--set-port', '--get-port', '--show-webhook-token'].some(a => process.argv.includes(a));
  if (defaultConfig.logFile && !cliOnly) setupFileLogging(defaultConfig.logFile);

  (async () => {
    const args = process.argv.slice(2);
    if (args.some(a => a.startsWith('--'))) {
      await runCli(args, new MonitorDB(defaultConfig.dbPath));
    }

    const app = createApp();
    const addr = await app.start();
    const cfg = app.appConfig;
    console.log('=======================================================');
    console.log(' FortiGate Dual-WAN Link Degradation Monitor is running');
    console.log(`  Dashboard:     http://localhost:${addr.port}`);
    console.log(`  Help:          http://localhost:${addr.port}/help.html`);
    console.log(`  Remote access: ${app.security.passwordHash
      ? `enabled (user "${app.security.user}")`
      : 'DISABLED - set a password: wanmon.cmd --set-password (or node server.js --set-password)'}`);
    console.log(`  Webhook:       http://<this-server>:${addr.port}/api/webhook/fortigate?token=<see Settings>`);
    console.log(`  Mode:          ${cfg.simulation.enabled ? 'SIMULATION (fake data)' : `FortiGate ${cfg.fortigate.host}`}`);
    console.log(`  Data:          ${cfg.dbPath}`);
    console.log('=======================================================');

    const shutdown = async (sig) => {
      console.log(`\n${sig} received, shutting down...`);
      await app.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  })().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp, deepMerge, hashPassword, verifyPassword };
