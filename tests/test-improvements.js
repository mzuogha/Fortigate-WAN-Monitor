/**
 * Tests for the v2 improvements: real FortiOS response parsing, hysteresis, alert
 * context, delivery retry, security controls and the SMTP client.
 * Run: node --test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const EventEmitter = require('node:events');

const MonitorDB = require('../db');
const FortiGateClient = require('../fortigate-client');
const AlertManager = require('../alert-manager');
const SmtpClient = require('../smtp-client');
const { createApp, hashPassword, verifyPassword } = require('../server');

// Response shape documented by Fortinet for GET /api/v2/monitor/virtual-wan/health-check
function healthCheckResponse(members) {
  return { http_method: 'GET', results: { Default_DNS: members }, vdom: 'root', status: 'success' };
}
const UP = (latency = 20, loss = 0, jitter = 2) => ({
  status: 'up', latency, jitter, packet_loss: loss, packet_sent: 100, packet_received: 100, sla_targets_met: [1]
});
const DEAD = { status: 'down', packet_loss: 100 };

function baseConfig(overrides = {}) {
  return {
    fortigate: { wan1Interface: 'port1', wan2Interface: 'port2', wan1Label: 'MTN', wan2Label: 'Airtel' },
    thresholds: {
      packetLossWarning: 2, packetLossCritical: 8, latencyWarningMs: 120, latencyCriticalMs: 250,
      jitterWarningMs: 25, jitterCriticalMs: 50, consecutiveFailsToAlert: 2, consecutiveHealthyToRecover: 3,
      flapWindowSeconds: 300, flapThresholdCount: 3, reminderMinutes: 0
    },
    notifications: { windowsToast: { enabled: false }, retry: { maxQueue: 50, maxAgeHours: 24 } },
    simulation: { enabled: false },
    ...overrides
  };
}

function newAlertManager(config = baseConfig()) {
  const db = new MonitorDB(':memory:');
  const bus = new EventEmitter();
  const alerts = [];
  bus.on('alert', a => alerts.push(a));
  const am = new AlertManager({ config, db, eventEmitter: bus });
  return { am, db, alerts };
}

const sample = (latency, packetLoss, jitter = 2, status = 'up') => ({ latency, packetLoss, jitter, status });

// ------------------------------------------------------------------ FortiGate parsing
test('FortiGateClient parses the documented health-check format with exact interface names', () => {
  const fg = new FortiGateClient({ wan1Interface: 'port1', wan2Interface: 'port2', healthCheckName: 'Default_DNS' });
  const results = healthCheckResponse({ port1: UP(18.456, 0, 1.2), port2: DEAD }).results;

  const a = fg.parseHealthCheck(results, 'port1');
  assert.equal(a.status, 'up');
  assert.equal(a.latency, 18.5);
  assert.equal(a.packetLoss, 0);

  const b = fg.parseHealthCheck(results, 'port2');
  assert.equal(b.status, 'down');
  assert.equal(b.packetLoss, 100);
  assert.equal(b.latency, null);

  // Interface names are matched exactly (the old code matched anything containing "wan1")
  assert.equal(fg.parseHealthCheck({ Default_DNS: { 'wan10-backup': UP() } }, 'wan1'), null);
});

test('FortiGateClient falls back to another health check that contains the interface', () => {
  const fg = new FortiGateClient({ healthCheckName: 'Missing_HC' });
  const r = fg.parseHealthCheck({ Google: { wan1: UP(30) } }, 'wan1');
  assert.equal(r.healthCheck, 'Google');
  assert.equal(r.latency, 30);
});

test('FortiGateClient reads boolean link state and computes throughput from byte counters', () => {
  const fg = new FortiGateClient({});
  assert.equal(fg.parseInterface({ wan1: { link: false } }, 'wan1').linkUp, false);
  const t0 = 1_000_000;
  fg.parseInterface({ wan1: { link: true, rx_bytes: 0, tx_bytes: 0 } }, 'wan1', t0);
  const r = fg.parseInterface({ wan1: { link: true, rx_bytes: 1_250_000, tx_bytes: 125_000 } }, 'wan1', t0 + 1000);
  assert.equal(r.linkUp, true);
  assert.equal(r.rxKbps, 10000); // 1.25 MB in 1 s = 10 Mbps
  assert.equal(r.txKbps, 1000);
});

test('FortiGateClient.getLinkMetrics against a mock FortiGate', async (t) => {
  let hc = healthCheckResponse({ port1: UP(25), port2: UP(40) });
  let ifs = { results: { port1: { link: true, rx_bytes: 0, tx_bytes: 0 }, port2: { link: false } } };
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const body = req.url.startsWith('/api/v2/monitor/virtual-wan/health-check') ? hc
      : req.url.startsWith('/api/v2/monitor/system/interface') ? ifs : null;
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body || {}));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());

  const fg = new FortiGateClient({
    host: `http://127.0.0.1:${srv.address().port}`, apiToken: 'tok', wan1Interface: 'port1', wan2Interface: 'port2'
  });
  const m = await fg.getLinkMetrics();
  assert.equal(seen[0].auth, 'Bearer tok');
  assert.match(seen[0].url, /vdom=root/);
  assert.equal(m.wan1.status, 'up');
  assert.equal(m.wan1.latency, 25);
  assert.equal(m.wan2.status, 'down', 'carrier down overrides SLA status');
  assert.equal(m.wan2.carrierDown, true);

  hc = healthCheckResponse({ port1: UP() });
  ifs = { results: {} };
  const m2 = await fg.getLinkMetrics();
  assert.equal(m2.wan2.status, 'unknown');
  assert.match(m2.wan2.reason, /No SD-WAN health-check data/);
});

// ------------------------------------------------------------------ evaluation & alerts
test('Hysteresis: WARNING/CRITICAL oscillation produces one alert, not one per change', () => {
  const { am, alerts } = newAlertManager();
  am.evaluateMetric('wan1', sample(20, 0));
  am.evaluateMetric('wan2', sample(20, 0));
  const seq = [sample(20, 3), sample(20, 9), sample(20, 3), sample(20, 9), sample(20, 3), sample(20, 9)];
  for (const s of seq) am.evaluateMetric('wan1', s);
  const external = alerts.filter(a => !a.localOnly);
  assert.equal(external.length, 1, `expected 1 alert, got: ${external.map(a => a.title).join(' / ')}`);
  assert.equal(external[0].severity, 'WARNING');
});

test('Link DOWN escalates, de-escalation is quiet, recovery is notified with duration', () => {
  const { am, alerts } = newAlertManager();
  am.evaluateMetric('wan1', sample(20, 0));
  am.evaluateMetric('wan2', sample(20, 0));

  am.evaluateMetric('wan1', sample(null, 100, null, 'down'));
  am.evaluateMetric('wan1', sample(null, 100, null, 'down'));
  assert.equal(am.states.wan1.status, 'DOWN');
  assert.match(alerts.at(-1).title, /MTN \(port1\) is DOWN/);
  assert.match(alerts.at(-1).overview, /IMPACT: running on a single link \(Airtel \(port2\)\)/);

  for (let i = 0; i < 3; i++) am.evaluateMetric('wan1', sample(20, 4));
  assert.equal(am.states.wan1.status, 'WARNING');
  assert.equal(alerts.at(-1).localOnly, true, 'de-escalation is dashboard-only');

  for (let i = 0; i < 3; i++) am.evaluateMetric('wan1', sample(20, 0));
  assert.equal(am.states.wan1.status, 'HEALTHY');
  assert.equal(alerts.at(-1).severity, 'RECOVERED');
  assert.match(alerts.at(-1).message, /was WARNING for/);
});

test('Both links down produces a TOTAL OUTAGE alert', () => {
  const { am, alerts } = newAlertManager();
  for (const l of ['wan1', 'wan2']) am.evaluateMetric(l, sample(20, 0));
  for (let i = 0; i < 2; i++) am.evaluateMetric('wan1', sample(null, 100, null, 'down'));
  for (let i = 0; i < 2; i++) am.evaluateMetric('wan2', sample(null, 100, null, 'down'));
  assert.equal(alerts.at(-1).title, 'TOTAL OUTAGE: all WAN links are down');
  assert.match(alerts.at(-1).overview, /ALL WAN LINKS DOWN/);
});

test('Unknown samples never change link state', () => {
  const { am, alerts } = newAlertManager();
  am.evaluateMetric('wan1', sample(20, 0));
  for (let i = 0; i < 5; i++) am.evaluateMetric('wan1', { status: 'unknown', reason: 'no data' });
  assert.equal(am.states.wan1.status, 'HEALTHY');
  assert.equal(alerts.length, 0);
});

test('Reminders are sent while a link stays down', () => {
  const cfg = baseConfig();
  cfg.thresholds.reminderMinutes = 1;
  const { am, alerts } = newAlertManager(cfg);
  am.evaluateMetric('wan1', sample(20, 0));
  am.evaluateMetric('wan1', sample(null, 100, null, 'down'));
  am.evaluateMetric('wan1', sample(null, 100, null, 'down'));
  const n = alerts.length;
  am.checkReminders();
  assert.equal(alerts.length, n, 'no reminder before the interval');
  am.states.wan1.lastNotified -= 61000;
  am.checkReminders();
  assert.match(alerts.at(-1).title, /^Still DOWN/);
});

test('Undeliverable alerts are queued, retried, and delivered marked as delayed', async () => {
  const { am } = newAlertManager();
  let fail = true;
  const delivered = [];
  am.enabledChannels = () => ['telegram'];
  am.sendToChannel = async (ch, alert) => {
    if (fail) throw new Error('ENETUNREACH');
    delivered.push(alert);
  };
  await am.sendAlert({ linkId: 'wan1', severity: 'CRITICAL', title: 'x', message: 'y' });
  assert.equal(am.queue.length, 1);
  am.queue[0].created -= 5 * 60000;
  fail = false;
  await am.flushQueue();
  assert.equal(am.queue.length, 0);
  assert.match(delivered[0].delayedNote, /internet access was down/);
});

test('Alert text is escaped for HTML channels', async () => {
  const { am } = newAlertManager();
  let payload;
  am.postJson = async (url, data) => { payload = JSON.parse(data); };
  await am.sendTelegramAlert({ botToken: 't', chatId: '1' },
    { title: '<script>x</script>', message: 'a_b *c*', severity: 'CRITICAL', linkId: 'wan1' });
  assert.equal(payload.parse_mode, 'HTML');
  assert.ok(payload.text.includes('&lt;script&gt;'));
  assert.ok(!payload.text.includes('<script>'));
});

// ------------------------------------------------------------------ SMTP
test('SmtpClient sends to multiple recipients with proper headers', async (t) => {
  const received = { rcpt: [], data: '' };
  const srv = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    sock.write('220 mock ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else received.data += `${line}\n`;
        } else if (/^EHLO/i.test(line)) sock.write('250-mock\r\n250-SIZE 1000\r\n250 OK\r\n');
        else if (/^MAIL/i.test(line)) sock.write('250 OK\r\n');
        else if (/^RCPT/i.test(line)) { received.rcpt.push(line); sock.write('250 OK\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());

  const smtp = new SmtpClient({ host: '127.0.0.1', port: srv.address().port, from: 'mon@x.com', to: 'a@x.com, b@x.com' });
  await smtp.sendMail({ subject: 'WAN ⛔ down', text: 'hello', html: '<b>hi</b>' });
  assert.equal(received.rcpt.length, 2);
  assert.match(received.data, /^Date: /m);
  assert.match(received.data, /^Message-ID: </m);
  assert.match(received.data, /^Subject: =\?UTF-8\?B\?/m);
});

test('SmtpClient refuses to send credentials without TLS', async (t) => {
  const srv = net.createServer((sock) => {
    sock.write('220 mock\r\n');
    sock.on('data', (d) => { if (/^EHLO/i.test(d.toString())) sock.write('250 OK\r\n'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const smtp = new SmtpClient({ host: '127.0.0.1', port: srv.address().port, user: 'u', pass: 'p', to: 'a@x.com' });
  await assert.rejects(smtp.sendMail({ subject: 's', text: 't' }), /refusing to send credentials/);
});

// ------------------------------------------------------------------ server security
async function startApp(t, { password = '', fgPort = null } = {}) {
  const db = new MonitorDB(':memory:');
  if (password) db.setSetting('security', { passwordHash: hashPassword(password) });
  const app = createApp({
    db,
    configOverrides: {
      simulation: { enabled: false },
      notifications: { windowsToast: { enabled: false }, email: { enabled: false, host: 'smtp.example.com', pass: 'real-secret', to: 'a@b.c' } },
      fortigate: {
        host: fgPort ? `http://127.0.0.1:${fgPort}` : 'https://10.0.0.1',
        apiToken: fgPort ? 'fg-token' : 'stored-token-1234',
        wan1Interface: 'port1',
        wan2Interface: 'port2',
        pollIntervalMs: 60000,
        apiFailuresToAlert: 2
      },
      security: { dashboardPassword: '' }
    }
  });
  const addr = await app.start(0, '127.0.0.1');
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${addr.port}`;
  const req = (p, opts = {}) => fetch(base + p, opts);
  return { app, base, req };
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('Server survives malformed input and blocks non-JSON (CSRF-style) posts', async (t) => {
  const { req } = await startApp(t);
  const bad = await req('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(bad.status, 400);
  const form = await req('/api/settings', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  assert.equal((await req('/api/status')).status, 200, 'server still running');
  assert.equal((await req('/api/status')).headers.get('access-control-allow-origin'), null, 'no wildcard CORS');
});

test('Without a password only localhost can use the dashboard (DNS-rebinding safe)', async (t) => {
  const { base } = await startApp(t);
  const res = await new Promise((resolve) => {
    http.get(`${base}/api/status`, { headers: { Host: 'attacker.example:4000' } }, resolve);
  });
  assert.equal(res.statusCode, 403);
});

test('With a password, Basic auth is required', async (t) => {
  const { req } = await startApp(t, { password: 'correct-horse' });
  assert.equal((await req('/api/status')).status, 401);
  const wrong = Buffer.from('admin:nope').toString('base64');
  assert.equal((await req('/api/status', { headers: { Authorization: `Basic ${wrong}` } })).status, 401);
  const ok = Buffer.from('admin:correct-horse').toString('base64');
  assert.equal((await req('/api/status', { headers: { Authorization: `Basic ${ok}` } })).status, 200);
  assert.ok(verifyPassword('correct-horse', hashPassword('correct-horse')));
});

test('FortiGate webhook requires the token and maps the interface to the right link', async (t) => {
  const { app, req } = await startApp(t);
  const payload = { log: 'logid="0113022923" type="event" subtype="sdwan" interface="port2" status="down" msg="SD-WAN health-check member changed state."' };
  assert.equal((await req('/api/webhook/fortigate', json(payload))).status, 401);

  const alerts = [];
  app.alertManager.eventEmitter.on('alert', a => alerts.push(a));
  const res = await req(`/api/webhook/fortigate?token=${app.security.webhookToken}`, json(payload));
  const body = await res.json();
  assert.equal(body.linkId, 'wan2');
  assert.equal(body.status, 'down');
  assert.match(alerts[0].title, /port2/);
  // Text is never passed into a PowerShell script (toast uses environment variables)
  assert.ok(!AlertManager.prototype.sendWindowsToast.toString().includes('${escapedMsg}'));
});

test('Settings: secrets (incl. webhook URLs) are masked and preserved; tests never mutate live config', async (t) => {
  const { app, req } = await startApp(t);
  await req('/api/settings', json({ notifications: { slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/SECRET' } } }));
  const cfg = await (await req('/api/settings')).json();
  assert.ok(cfg.notifications.slack.webhookUrl.startsWith('••••'));
  assert.ok(cfg.notifications.email.pass.startsWith('••••'));
  assert.ok(cfg.fortigate.apiToken.endsWith('1234'));
  assert.ok(cfg.webhook.token);

  // Saving the form back (with masked values) keeps the real secrets
  await req('/api/settings', json({ notifications: cfg.notifications, fortigate: cfg.fortigate }));
  assert.equal(app.appConfig.notifications.slack.webhookUrl, 'https://hooks.slack.com/services/SECRET');
  assert.equal(app.appConfig.fortigate.apiToken, 'stored-token-1234');

  // A test email with a masked password must not overwrite the live SMTP password
  await req('/api/test-alert', json({ channel: 'email', emailConfig: { host: '127.0.0.1', port: 1, pass: '••••••••', to: 'x@y.z' } }));
  assert.equal(app.alertManager.smtpClient.pass, 'real-secret');
  assert.equal(app.alertManager.smtpClient.host, 'smtp.example.com');
});

test('Connection test never sends the stored API token to a different host', async (t) => {
  const { req } = await startApp(t);
  const r = await (await req('/api/fortigate/test', json({ host: 'https://evil.example', apiToken: '••••••••1234' }))).json();
  assert.equal(r.success, false);
  assert.match(r.error, /Enter the API token/);
});

test('Static file serving blocks path traversal', async (t) => {
  const { base } = await startApp(t);
  const res = await new Promise((resolve) => http.get(`${base}/..%2f..%2fconfig.js`, resolve));
  assert.ok([403, 404].includes(res.statusCode));
});

test('End-to-end: polls a mock FortiGate, alerts on outage, and alerts when the API is unreachable', async (t) => {
  let members = { port1: UP(22), port2: UP(35) };
  let apiUp = true;
  const fg = http.createServer((req, res) => {
    if (!apiUp) { res.writeHead(500); return res.end('fail'); }
    const body = req.url.includes('health-check') ? healthCheckResponse(members)
      : req.url.includes('system/interface') ? { results: { port1: { link: true }, port2: { link: true } } }
        : { version: 'v7.4.3', serial: 'FGT', results: { hostname: 'HQ-FGT' } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => fg.listen(0, '127.0.0.1', r));
  t.after(() => fg.close());

  const { app, req } = await startApp(t, { fgPort: fg.address().port });
  const alerts = [];
  app.alertManager.eventEmitter.on('alert', a => alerts.push(a));

  await app.pollCycle();
  let status = await (await req('/api/status')).json();
  assert.equal(status.fortigateStatus.connected, true);
  assert.equal(status.wan1.latency, 22);
  assert.equal(status.wan1.status, 'HEALTHY');
  assert.equal(status.wan2.interface, 'port2');

  members = { port1: DEAD, port2: UP(35) };
  await app.pollCycle();
  await app.pollCycle();
  status = await (await req('/api/status')).json();
  assert.equal(status.wan1.status, 'DOWN');
  assert.equal(status.wan1.linkState, 'no-traffic');
  assert.ok(alerts.some(a => /is DOWN/.test(a.title)));
  assert.equal(status.activeIncidents.length, 1);

  apiUp = false;
  await app.pollCycle();
  await app.pollCycle();
  assert.ok(alerts.some(a => a.type === 'MONITOR_API_DOWN'));
  status = await (await req('/api/status')).json();
  assert.equal(status.wan1.stale, true);

  apiUp = true;
  await app.pollCycle();
  assert.ok(alerts.some(a => a.type === 'MONITOR_API_RESTORED'));

  const report = await (await req('/api/report?hours=1')).json();
  const wan1 = report.links.find(l => l.linkId === 'wan1');
  assert.ok(wan1.availabilityPct < 100);
  assert.equal(wan1.outages, 1);
});

// ------------------------------------------------------------------ daily reports
const reports = require('../report-generator');

function seedDay(db, date) {
  const { start } = reports.dayWindow(date);
  const t0 = start + 8 * 3600000; // 08:00
  for (let i = 0; i < 720; i++) { // one hour at 5 s
    const ts = t0 + i * 5000;
    const wan1Down = i >= 120 && i < 240;  // 10 minutes down
    const wan2Down = i >= 180 && i < 204;  // 2 minutes down, overlapping -> both down 2 min
    const wan2Warn = i >= 400 && i < 460;  // 5 minutes degraded
    db.saveMetric({ timestamp: ts, linkId: 'wan1', latency: wan1Down ? null : 20 + (i % 10), packetLoss: wan1Down ? 100 : 0,
      jitter: 2, status: wan1Down ? 'down' : 'up', level: wan1Down ? 'DOWN' : 'HEALTHY' });
    db.saveMetric({ timestamp: ts, linkId: 'wan2', latency: wan2Down ? null : 40, packetLoss: wan2Down ? 100 : (wan2Warn ? 4 : 0),
      jitter: 3, status: wan2Down ? 'down' : 'up', level: wan2Down ? 'DOWN' : (wan2Warn ? 'WARNING' : 'HEALTHY') });
  }
  const id = db.createIncident({ linkId: 'wan1', severity: 'DOWN', triggerReason: 'probes failing' });
  db.db.prepare('UPDATE incidents SET start_time = ?, end_time = ?, resolved = 1 WHERE id = ?').run(t0 + 600000, t0 + 1200000, id);
  return t0;
}

test('Daily report computes availability, down/degraded time and both-down time', () => {
  const db = new MonitorDB(':memory:');
  seedDay(db, '2026-09-01');
  const r = reports.buildDailyReport({ db, date: '2026-09-01', links: { wan1: 'MTN (port1)', wan2: 'Airtel (port2)' }, site: 'HQ' });
  const [w1, w2] = r.links;
  assert.equal(w1.samples, 720);
  assert.ok(Math.abs(w1.downMs - 600000) <= 5000, `wan1 down ~10 min, got ${w1.downMs}`);
  assert.ok(Math.abs(w1.availabilityPct - 83.33) < 0.2, `availability ${w1.availabilityPct}`);
  assert.equal(w1.outages, 1);
  assert.ok(Math.abs(w2.degradedMs - 300000) <= 5000, `wan2 degraded ~5 min, got ${w2.degradedMs}`);
  assert.ok(Math.abs(r.bothDownMs - 120000) <= 5000, `both down ~2 min, got ${r.bothDownMs}`);
  assert.match(r.headline, /NO internet for 2m/);
  assert.equal(w1.latency.max, 29);

  const html = reports.renderHtml(r);
  assert.match(html, /Daily WAN report for 2026-09-01/);
  assert.match(html, /MTN \(port1\)/);
  const csv = reports.renderCsv(r);
  assert.match(csv, /^Report,Site,Date/);
  assert.match(csv, /MTN \(port1\),83\.3/);
  assert.match(reports.renderText(r), /Both links down: 2m/);
});

test('Daily report for a day without data says so; invalid dates are rejected', () => {
  const db = new MonitorDB(':memory:');
  const r = reports.buildDailyReport({ db, date: '2026-08-01', links: { wan1: 'A', wan2: 'B' } });
  assert.equal(r.hasData, false);
  assert.match(r.headline, /No monitoring data/);
  assert.throws(() => reports.dayWindow('2026-02-30'), /Invalid date/);
  assert.throws(() => reports.dayWindow('yesterday'), /YYYY-MM-DD/);
});

test('Report API: JSON, HTML, CSV and validation', async (t) => {
  const { app, req } = await startApp(t);
  seedDay(app.db, '2026-09-01');
  const json1 = await (await req('/api/reports/daily?date=2026-09-01')).json();
  assert.equal(json1.links.length, 2);
  assert.ok(json1.text.length > 20);
  const html = await req('/api/reports/daily?date=2026-09-01&format=html');
  assert.match(html.headers.get('content-type'), /text\/html/);
  const csv = await req('/api/reports/daily?date=2026-09-01&format=csv');
  assert.match(csv.headers.get('content-disposition'), /wan-report-2026-09-01\.csv/);
  assert.equal((await req('/api/reports/daily?date=bad')).status, 400);
  const send = await req('/api/reports/daily/send', json({ date: '2026-09-01' }));
  assert.equal(send.status, 400, 'no channels enabled -> clear error');
});

test('Scheduled daily report is sent once per day after the configured time', async (t) => {
  const { app } = await startApp(t);
  app.appConfig.reports = { dailyEnabled: true, dailyTime: '07:00' };
  seedDay(app.db, '2026-09-09');
  seedDay(app.db, '2026-09-10');
  const sent = [];
  app.alertManager.eventEmitter.on('alert', a => { if (a.type === 'DAILY_REPORT') sent.push(a); });
  assert.equal(app.checkDailyReport(new Date(2026, 8, 10, 6, 59)), null, 'not before 07:00');
  assert.ok(app.checkDailyReport(new Date(2026, 8, 10, 7, 0)), 'sent at 07:00');
  assert.equal(app.checkDailyReport(new Date(2026, 8, 10, 9, 0)), null, 'not twice');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Daily WAN report for 2026-09-09');
  assert.ok(sent[0].reportHtml.includes('Per-link summary'));
  assert.ok(app.checkDailyReport(new Date(2026, 8, 11, 7, 5)), 'next day sends again');
  assert.equal(app.checkDailyReport(new Date(2026, 8, 20, 8, 0)), null, 'days without data are skipped');
  assert.equal(sent.length, 2);
});

// ------------------------------------------------------------------ listening port
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('Listening port can be changed live and is persisted; busy ports are refused', async (t) => {
  delete process.env.PORT;
  const { app, req } = await startApp(t);
  const blocker = net.createServer();
  const busy = await new Promise(r => blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)));
  t.after(() => blocker.close());

  const refused = await req('/api/server/port', json({ port: busy }));
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /already in use/);
  assert.equal((await req('/api/server/port', json({ port: 70000 }))).status, 400);

  const port = await freePort();
  const moved = await (await req('/api/server/port', json({ port }))).json();
  assert.equal(moved.success, true);
  assert.equal(moved.port, port);
  assert.equal(app.db.getSetting('server').port, port);
  const onNew = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(onNew.status, 200);
  const cfg = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
  assert.equal(cfg.server.port, port);
});

test('Help page and its script are served', async (t) => {
  const { req } = await startApp(t);
  const help = await req('/help.html');
  assert.equal(help.status, 200);
  const text = await help.text();
  assert.match(text, /id="connect"/);
  assert.match(text, /set snat-route-change enable/);
  assert.equal((await req('/help.js')).status, 200);
  const index = await (await req('/')).text();
  assert.match(index, /href="help.html#connect"/, 'Settings > FortiGate API links to the connection guide');
});
