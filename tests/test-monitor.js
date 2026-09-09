/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Automated Test Suite using Node 24 native node:test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const EventEmitter = require('node:events');

const MonitorDB = require('../db');
const ProbeEngine = require('../probe-engine');
const AlertManager = require('../alert-manager');
const FortiGateClient = require('../fortigate-client');

const TEST_DB_PATH = path.join(__dirname, 'test-monitor.db');

// Cleanup previous test DB
if (fs.existsSync(TEST_DB_PATH)) {
  fs.unlinkSync(TEST_DB_PATH);
}

test('Database Operations: Schema, Metrics, Incidents, Settings', (t) => {
  const db = new MonitorDB(TEST_DB_PATH);

  // 1. Metric saving & retrieval
  const now = Date.now();
  db.saveMetric({
    timestamp: now - 5000,
    linkId: 'wan1',
    latency: 22.5,
    packetLoss: 0,
    jitter: 1.8,
    status: 'up',
    rxKbps: 5000,
    txKbps: 1200
  });

  db.saveMetric({
    timestamp: now,
    linkId: 'wan1',
    latency: 185.0,
    packetLoss: 6.5,
    jitter: 32.0,
    status: 'up',
    rxKbps: 3000,
    txKbps: 800
  });

  const history = db.getMetricHistory(60);
  assert.equal(history.length, 2, 'Should retrieve 2 metric records in history');
  assert.equal(history[1].packet_loss, 6.5, 'Packet loss should match saved sample');

  // 2. Incident lifecycle
  const incId = db.createIncident({
    linkId: 'wan1',
    severity: 'WARNING',
    triggerReason: 'Packet loss elevated to 6.5%',
    peakLatency: 185,
    peakLoss: 6.5
  });
  assert.ok(incId > 0, 'Incident ID should be positive integer');

  const activeInc = db.getActiveIncident('wan1');
  assert.ok(activeInc, 'Active incident should exist');
  assert.equal(activeInc.severity, 'WARNING');

  db.updateIncidentPeak(incId, 220, 12.0);
  const updatedInc = db.getActiveIncident('wan1');
  assert.equal(updatedInc.peak_loss, 12.0, 'Peak loss should update');

  db.resolveIncident('wan1');
  const activeAfterResolve = db.getActiveIncident('wan1');
  assert.equal(activeAfterResolve, undefined, 'Incident should be resolved');

  // 3. Settings Key-Value store
  db.setSetting('testKey', { customThreshold: 42 });
  const retrieved = db.getSetting('testKey');
  assert.equal(retrieved.customThreshold, 42, 'Setting should serialize and deserialize properly');

  db.close();
});

test('ProbeEngine: Simulation & Synthetic Metrics', () => {
  const probe = new ProbeEngine({ simulationEnabled: true });

  const sample1 = probe.getSimulatedMetrics();
  assert.ok(sample1.wan1, 'WAN1 sample should exist');
  assert.ok(sample1.wan2, 'WAN2 sample should exist');
  assert.equal(sample1.wan1.status, 'up');

  // Test Condition: Packet Loss
  probe.setSimulatedCondition('wan1', 'packet_loss');
  const sample2 = probe.getSimulatedMetrics();
  assert.ok(sample2.wan1.packetLoss >= 10, 'WAN1 packet loss should exceed 10% under condition');

  // Test Condition: Down
  probe.setSimulatedCondition('wan2', 'down');
  const sample3 = probe.getSimulatedMetrics();
  assert.equal(sample3.wan2.status, 'down', 'WAN2 should be reported as down');
  assert.equal(sample3.wan2.packetLoss, 100, 'WAN2 should have 100% loss when down');
});

test('AlertManager: Degradation, Threshold Evaluation & Recovery Transitions', async () => {
  const testDb = new MonitorDB(path.join(__dirname, 'test-alert.db'));
  const bus = new EventEmitter();

  const mockConfig = {
    thresholds: {
      packetLossWarning: 2.0,
      packetLossCritical: 8.0,
      latencyWarningMs: 120,
      latencyCriticalMs: 250,
      jitterWarningMs: 25,
      jitterCriticalMs: 50,
      consecutiveFailsToAlert: 2,
      consecutiveHealthyToRecover: 2,
      flapWindowSeconds: 300,
      flapThresholdCount: 3
    },
    notifications: {
      windowsToast: { enabled: false },
      telegram: { enabled: false },
      discord: { enabled: false },
      slack: { enabled: false }
    }
  };

  const alertMgr = new AlertManager({ config: mockConfig, db: testDb, eventEmitter: bus });

  const alertsEmitted = [];
  bus.on('alert', (a) => alertsEmitted.push(a));

  // Healthy probe 1
  const res1 = alertMgr.evaluateMetric('wan1', { latency: 25, packetLoss: 0, jitter: 2, status: 'up' });
  assert.equal(res1.status, 'HEALTHY');

  // Bad probe 1 (Loss = 12% -> Critical)
  const res2 = alertMgr.evaluateMetric('wan1', { latency: 25, packetLoss: 12.0, jitter: 2, status: 'up' });
  assert.equal(res2.consecutiveFails, 1, 'Should record 1 fail');
  assert.equal(alertsEmitted.length, 0, 'Should not alert on single spike until consecutive threshold reached');

  // Bad probe 2 (Reaches consecutive threshold -> Alert!)
  const res3 = alertMgr.evaluateMetric('wan1', { latency: 30, packetLoss: 14.5, jitter: 3, status: 'up' });
  assert.equal(res3.status, 'CRITICAL', 'Status should transition to CRITICAL');
  assert.equal(alertsEmitted.length, 1, 'Should emit 1 alert on degradation confirmation');
  assert.equal(alertsEmitted[0].severity, 'CRITICAL');

  // Recovery probe 1
  alertMgr.evaluateMetric('wan1', { latency: 24, packetLoss: 0, jitter: 1.5, status: 'up' });
  assert.equal(alertsEmitted.length, 1, 'Should not recover after only 1 clean sample');

  // Recovery probe 2 (Reaches consecutive clean requirement -> Recovery alert!)
  alertMgr.evaluateMetric('wan1', { latency: 22, packetLoss: 0, jitter: 1.2, status: 'up' });
  assert.equal(alertsEmitted.length, 2, 'Should emit recovery alert');
  assert.equal(alertsEmitted[1].severity, 'RECOVERED');

  testDb.close();
  fs.unlinkSync(path.join(__dirname, 'test-alert.db'));
});

test('FortiGateClient: Endpoint Configuration & Error Handling', async () => {
  const fg = new FortiGateClient({
    host: 'https://10.0.0.1',
    apiToken: '',
    vdom: 'root'
  });

  // Calling without API token should reject with clean error
  await assert.rejects(
    async () => { await fg.request('/api/v2/monitor/system/status'); },
    /API token is not configured/
  );
});
