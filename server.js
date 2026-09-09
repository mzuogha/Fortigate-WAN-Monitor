/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Main Web Server, REST API, & Monitoring Service
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');

const defaultConfig = require('./config');
const MonitorDB = require('./db');
const FortiGateClient = require('./fortigate-client');
const ProbeEngine = require('./probe-engine');
const AlertManager = require('./alert-manager');

// Initialize event bus
const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

// Initialize DB
const db = new MonitorDB(defaultConfig.dbPath);

// Merge stored settings if present
const storedSettings = db.getAllSettings();
const appConfig = {
  ...defaultConfig,
  fortigate: { ...defaultConfig.fortigate, ...(storedSettings.fortigate || {}) },
  thresholds: { ...defaultConfig.thresholds, ...(storedSettings.thresholds || {}) },
  notifications: { ...defaultConfig.notifications, ...(storedSettings.notifications || {}) },
  simulation: { ...defaultConfig.simulation, ...(storedSettings.simulation || {}) }
};

// Initialize clients
const fortigateClient = new FortiGateClient(appConfig.fortigate);
const probeEngine = new ProbeEngine({
  targets: appConfig.probing.pingTargets,
  simulationEnabled: appConfig.simulation.enabled
});
const alertManager = new AlertManager({
  config: appConfig,
  db,
  eventEmitter: eventBus
});

// SSE Client pool
const sseClients = new Set();

// Current state cache
const currentState = {
  wan1: {
    linkId: 'wan1',
    name: 'WAN 1 (Primary ISP)',
    latency: 0,
    packetLoss: 0,
    jitter: 0,
    status: 'HEALTHY',
    linkState: 'up',
    rxKbps: 0,
    txKbps: 0,
    lastUpdate: Date.now(),
    source: 'init'
  },
  wan2: {
    linkId: 'wan2',
    name: 'WAN 2 (Secondary ISP)',
    latency: 0,
    packetLoss: 0,
    jitter: 0,
    status: 'HEALTHY',
    linkState: 'up',
    rxKbps: 0,
    txKbps: 0,
    lastUpdate: Date.now(),
    source: 'init'
  },
  fortigateStatus: {
    connected: false,
    hostname: 'FortiGate',
    version: 'Unknown',
    lastError: null
  },
  isSimulating: appConfig.simulation.enabled
};

/**
 * Main Monitoring Loop
 */
let isPolling = false;
async function pollCycle() {
  if (isPolling) return;
  isPolling = true;

  try {
    let metrics = null;

    if (appConfig.simulation.enabled) {
      // 1. Simulation Mode active
      metrics = probeEngine.getSimulatedMetrics();
      currentState.isSimulating = true;
    } else if (appConfig.fortigate.enabled && appConfig.fortigate.apiToken) {
      // 2. Real FortiGate SD-WAN SLA REST API
      currentState.isSimulating = false;
      const fgSla = await fortigateClient.getSlaMetrics();

      if (fgSla.error) {
        currentState.fortigateStatus.connected = false;
        currentState.fortigateStatus.lastError = fgSla.error;
      } else {
        currentState.fortigateStatus.connected = true;
        currentState.fortigateStatus.lastError = null;
        metrics = {
          wan1: fgSla.wan1,
          wan2: fgSla.wan2
        };
      }
    }

    // Fallback if real query failed or returned null for a link
    if (!metrics || (!metrics.wan1 && !metrics.wan2)) {
      if (!appConfig.simulation.enabled && (!appConfig.fortigate.apiToken || !currentState.fortigateStatus.connected)) {
        // Run fallback local ping probe to verify connectivity
        const p8 = await probeEngine.pingTarget('8.8.8.8', 2);
        const p1 = await probeEngine.pingTarget('1.1.1.1', 2);
        metrics = {
          wan1: {
            interface: 'wan1',
            latency: p8.latency,
            packetLoss: p8.packetLoss,
            jitter: 2.0,
            status: p8.status,
            source: 'local-icmp-fallback'
          },
          wan2: {
            interface: 'wan2',
            latency: p1.latency,
            packetLoss: p1.packetLoss,
            jitter: 3.5,
            status: p1.status,
            source: 'local-icmp-fallback'
          }
        };
      }
    }

    // Process WAN1 & WAN2
    const now = Date.now();
    for (const linkId of ['wan1', 'wan2']) {
      const sample = metrics?.[linkId];
      if (!sample) continue;

      sample.timestamp = now;
      sample.linkId = linkId;

      // Save to SQLite
      db.saveMetric(sample);

      // Evaluate degradation and trigger alerts
      const evalResult = alertManager.evaluateMetric(linkId, sample);

      // Update current state cache
      currentState[linkId] = {
        ...currentState[linkId],
        latency: sample.latency,
        packetLoss: sample.packetLoss,
        jitter: sample.jitter,
        status: evalResult.status,
        linkState: sample.status || 'up',
        rxKbps: sample.rxKbps || currentState[linkId].rxKbps || 0,
        txKbps: sample.txKbps || currentState[linkId].txKbps || 0,
        lastUpdate: now,
        source: sample.source || 'monitor',
        issues: evalResult.issues || []
      };
    }

    // Broadcast update to all connected dashboard SSE clients
    broadcastSse('metrics', {
      wan1: currentState.wan1,
      wan2: currentState.wan2,
      fortigateStatus: currentState.fortigateStatus,
      isSimulating: currentState.isSimulating,
      timestamp: now
    });

  } catch (err) {
    console.error(`[Poll Error]: ${err.message}`);
  } finally {
    isPolling = false;
  }
}

// Start recurring poll
setInterval(pollCycle, appConfig.fortigate.pollIntervalMs || 3000);

// Prune old metrics every 6 hours
setInterval(() => {
  try {
    db.pruneOldMetrics(48);
  } catch (err) {
    console.error('Error pruning metrics:', err.message);
  }
}, 6 * 3600 * 1000);

// Forward AlertManager events to SSE
eventBus.on('alert', (alert) => {
  broadcastSse('alert', alert);
});

function broadcastSse(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

/**
 * MIME type lookup
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/**
 * HTTP Request Handler
 */
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Endpoints ---

  // 1. SSE Stream: GET /api/events
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(': sse connected\n\n');
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. Status: GET /api/status
  if (pathname === '/api/status' && req.method === 'GET') {
    const activeIncidents = [
      db.getActiveIncident('wan1'),
      db.getActiveIncident('wan2')
    ].filter(Boolean);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      wan1: currentState.wan1,
      wan2: currentState.wan2,
      fortigateStatus: currentState.fortigateStatus,
      isSimulating: currentState.isSimulating,
      activeIncidents,
      timestamp: Date.now()
    }));
    return;
  }

  // 3. History: GET /api/history?minutes=60
  if (pathname === '/api/history' && req.method === 'GET') {
    const minutes = parseInt(parsedUrl.searchParams.get('minutes') || '60', 10);
    const history = db.getMetricHistory(minutes);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  // 4. Incidents: GET /api/incidents
  if (pathname === '/api/incidents' && req.method === 'GET') {
    const incidents = db.getRecentIncidents(30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(incidents));
    return;
  }

  // 5. Settings: GET & POST /api/settings
  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      // Mask sensitive tokens for safe display
      const safeConfig = JSON.parse(JSON.stringify(appConfig));
      if (safeConfig.fortigate.apiToken) {
        safeConfig.fortigate.hasToken = true;
        safeConfig.fortigate.apiToken = '••••••••' + safeConfig.fortigate.apiToken.slice(-4);
      }
      if (safeConfig.notifications.telegram.botToken) {
        safeConfig.notifications.telegram.botToken = '••••••••';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(safeConfig));
      return;
    }

    if (req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (body.thresholds) {
        appConfig.thresholds = { ...appConfig.thresholds, ...body.thresholds };
        db.setSetting('thresholds', appConfig.thresholds);
      }
      if (body.notifications) {
        appConfig.notifications = { ...appConfig.notifications, ...body.notifications };
        db.setSetting('notifications', appConfig.notifications);
      }
      if (body.fortigate) {
        if (body.fortigate.apiToken && !body.fortigate.apiToken.startsWith('••••')) {
          appConfig.fortigate.apiToken = body.fortigate.apiToken;
        }
        if (body.fortigate.host) appConfig.fortigate.host = body.fortigate.host;
        if (body.fortigate.healthCheckName) appConfig.fortigate.healthCheckName = body.fortigate.healthCheckName;
        if (body.fortigate.wan1Interface) appConfig.fortigate.wan1Interface = body.fortigate.wan1Interface;
        if (body.fortigate.wan2Interface) appConfig.fortigate.wan2Interface = body.fortigate.wan2Interface;
        fortigateClient.updateConfig(appConfig.fortigate);
        db.setSetting('fortigate', appConfig.fortigate);
      }

      alertManager.updateConfig(appConfig);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Settings saved successfully' }));
      return;
    }
  }

  // 6. Test Alert: POST /api/test-alert
  if (pathname === '/api/test-alert' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const channel = body.channel || 'windowsToast';

    const testAlert = {
      type: 'TEST_ALERT',
      linkId: 'wan1',
      severity: 'WARNING',
      title: '[TEST] WAN Link Alert Test',
      message: `Test alert dispatched from FortiGate WAN Monitor via ${channel}.`,
      sample: { latency: 145.2, packetLoss: 4.8, jitter: 28.5 }
    };

    try {
      if (channel === 'windowsToast') {
        await alertManager.sendWindowsToast(testAlert.title, testAlert.message);
      } else if (channel === 'telegram') {
        const token = body.botToken || appConfig.notifications.telegram.botToken;
        const chatId = body.chatId || appConfig.notifications.telegram.chatId;
        await alertManager.sendTelegramAlert({ botToken: token, chatId }, testAlert);
      } else if (channel === 'discord') {
        const webhookUrl = body.webhookUrl || appConfig.notifications.discord.webhookUrl;
        await alertManager.sendDiscordAlert(webhookUrl, testAlert);
      } else if (channel === 'slack') {
        const webhookUrl = body.webhookUrl || appConfig.notifications.slack.webhookUrl;
        await alertManager.sendSlackAlert(webhookUrl, testAlert);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Test alert sent via ${channel}!` }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 7. Simulation Control: POST /api/simulation
  if (pathname === '/api/simulation' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (body.enabled !== undefined) {
      appConfig.simulation.enabled = !!body.enabled;
      probeEngine.setSimulation(appConfig.simulation.enabled);
      db.setSetting('simulation', appConfig.simulation);
    }
    if (body.condition && body.linkId) {
      probeEngine.setSimulatedCondition(body.linkId, body.condition);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      simulationEnabled: appConfig.simulation.enabled,
      condition: body.condition
    }));
    return;
  }

  // 8. FortiGate Webhook Receiver: POST /api/webhook/fortigate
  // (Triggered by FortiGate Automation Stitches on SD-WAN SLA violations)
  if (pathname === '/api/webhook/fortigate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      console.log('[FortiGate Webhook Received]:', JSON.stringify(body));

      const logMsg = body.log || body.message || JSON.stringify(body);
      let detectedLink = 'wan1';
      if (logMsg.toLowerCase().includes('wan2')) detectedLink = 'wan2';

      // Immediate degradation notification
      alertManager.sendAlert({
        type: 'FORTIGATE_WEBHOOK_EVENT',
        linkId: detectedLink,
        severity: 'CRITICAL',
        title: `[FORTIGATE EVENT] ${detectedLink.toUpperCase()} SLA Failure`,
        message: `FortiGate Automation Stitch reported: ${logMsg.substring(0, 200)}`
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 9. Test FortiGate Connection: POST /api/fortigate/test
  if (pathname === '/api/fortigate/test' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const testClient = new FortiGateClient({
      host: body.host || appConfig.fortigate.host,
      apiToken: body.apiToken || appConfig.fortigate.apiToken,
      vdom: body.vdom || appConfig.fortigate.vdom,
      rejectUnauthorized: body.rejectUnauthorized ?? false
    });

    const result = await testClient.testConnection();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // --- Static Files Serving ---
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  
  // Security check: prevent directory traversal
  const publicDir = path.join(__dirname, 'public');
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Access denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing if requested
      filePath = path.join(publicDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Start Server
const PORT = appConfig.port || 4000;
const HOST = appConfig.host || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`🚀 FortiGate Dual-WAN Link Degradation Monitor is active!`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 SSE Stream: http://localhost:${PORT}/api/events`);
  console.log(`🎯 FortiGate Webhook: http://localhost:${PORT}/api/webhook/fortigate`);
  console.log(`🧪 Simulation Mode: ${appConfig.simulation.enabled ? 'ENABLED (Ready for testing)' : 'DISABLED'}`);
  console.log(`=======================================================`);
});
