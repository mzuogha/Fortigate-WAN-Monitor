/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * SQLite Persistence Layer using Node 24 native node:sqlite
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

class MonitorDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        link_id TEXT NOT NULL,
        latency REAL NOT NULL,
        packet_loss REAL NOT NULL,
        jitter REAL NOT NULL,
        status TEXT NOT NULL,
        rx_kbps REAL DEFAULT 0,
        tx_kbps REAL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_link_time ON metrics(link_id, timestamp);

      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        severity TEXT NOT NULL,
        trigger_reason TEXT NOT NULL,
        peak_latency REAL DEFAULT 0,
        peak_loss REAL DEFAULT 0,
        resolved INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_incidents_link_resolved ON incidents(link_id, resolved);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  saveMetric(sample) {
    const stmt = this.db.prepare(`
      INSERT INTO metrics (timestamp, link_id, latency, packet_loss, jitter, status, rx_kbps, tx_kbps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      sample.timestamp || Date.now(),
      sample.linkId,
      sample.latency ?? 0,
      sample.packetLoss ?? 0,
      sample.jitter ?? 0,
      sample.status || 'UNKNOWN',
      sample.rxKbps ?? 0,
      sample.txKbps ?? 0
    );
  }

  getLatestMetrics() {
    const stmt = this.db.prepare(`
      SELECT m.* FROM metrics m
      INNER JOIN (
        SELECT link_id, MAX(timestamp) as max_time
        FROM metrics
        GROUP BY link_id
      ) latest ON m.link_id = latest.link_id AND m.timestamp = latest.max_time
    `);
    return stmt.all();
  }

  getMetricHistory(minutes = 60) {
    const cutoff = Date.now() - (minutes * 60 * 1000);
    const stmt = this.db.prepare(`
      SELECT timestamp, link_id, latency, packet_loss, jitter, status, rx_kbps, tx_kbps
      FROM metrics
      WHERE timestamp >= ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(cutoff);
  }

  createIncident({ linkId, severity, triggerReason, peakLatency = 0, peakLoss = 0 }) {
    const stmt = this.db.prepare(`
      INSERT INTO incidents (link_id, start_time, severity, trigger_reason, peak_latency, peak_loss, resolved)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `);
    const result = stmt.run(linkId, Date.now(), severity, triggerReason, peakLatency, peakLoss);
    return result.lastInsertRowid;
  }

  updateIncidentPeak(incidentId, peakLatency, peakLoss) {
    const stmt = this.db.prepare(`
      UPDATE incidents
      SET peak_latency = MAX(peak_latency, ?), peak_loss = MAX(peak_loss, ?)
      WHERE id = ?
    `);
    return stmt.run(peakLatency, peakLoss, incidentId);
  }

  getActiveIncident(linkId) {
    const stmt = this.db.prepare(`
      SELECT * FROM incidents
      WHERE link_id = ? AND resolved = 0
      ORDER BY start_time DESC
      LIMIT 1
    `);
    return stmt.get(linkId);
  }

  resolveIncident(linkId) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE incidents
      SET end_time = ?, resolved = 1
      WHERE link_id = ? AND resolved = 0
    `);
    return stmt.run(now, linkId);
  }

  getRecentIncidents(limit = 20) {
    const stmt = this.db.prepare(`
      SELECT * FROM incidents
      ORDER BY start_time DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  getSetting(key, defaultValue = null) {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key);
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  setSetting(key, value) {
    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    return stmt.run(key, serialized);
  }

  getAllSettings() {
    const stmt = this.db.prepare('SELECT key, value FROM settings');
    const rows = stmt.all();
    const result = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        result[row.key] = row.value;
      }
    }
    return result;
  }

  pruneOldMetrics(maxAgeHours = 48) {
    const cutoff = Date.now() - (maxAgeHours * 3600 * 1000);
    const stmt = this.db.prepare('DELETE FROM metrics WHERE timestamp < ?');
    return stmt.run(cutoff);
  }

  close() {
    this.db.close();
  }
}

module.exports = MonitorDB;
