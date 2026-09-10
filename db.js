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
    // WAL lets the dashboard read while the poller writes, and survives crashes better
    if (dbPath !== ':memory:') {
      try { this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;'); } catch (_) { /* optional */ }
    }
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

    // Migration: confirmed link level per sample (HEALTHY/WARNING/CRITICAL/DOWN), used by reports
    const cols = this.db.prepare('PRAGMA table_info(metrics)').all().map(c => c.name);
    if (!cols.includes('level')) {
      this.db.exec('ALTER TABLE metrics ADD COLUMN level TEXT');
    }
  }

  saveMetric(sample) {
    const stmt = this.db.prepare(`
      INSERT INTO metrics (timestamp, link_id, latency, packet_loss, jitter, status, rx_kbps, tx_kbps, level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      sample.timestamp || Date.now(),
      sample.linkId,
      sample.latency ?? 0,
      sample.packetLoss ?? 0,
      sample.jitter ?? 0,
      sample.status || 'UNKNOWN',
      sample.rxKbps ?? 0,
      sample.txKbps ?? 0,
      sample.level || null
    );
  }

  /** Raw samples in [start, end) for report generation. */
  getMetricsBetween(start, end) {
    return this.db.prepare(`
      SELECT timestamp, link_id, latency, packet_loss, jitter, status, level
      FROM metrics
      WHERE timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC
    `).all(start, end);
  }

  /** Incidents overlapping [start, end). */
  getIncidentsBetween(start, end) {
    return this.db.prepare(`
      SELECT * FROM incidents
      WHERE start_time < ? AND COALESCE(end_time, ?) >= ?
      ORDER BY start_time ASC
    `).all(end, Date.now(), start);
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

  /**
   * Raise an open incident's severity (never lowers it, so the log shows the worst level reached).
   */
  updateIncidentSeverity(incidentId, severity) {
    const rank = { HEALTHY: 0, WARNING: 1, CRITICAL: 2, DOWN: 3 };
    const row = this.db.prepare('SELECT severity FROM incidents WHERE id = ?').get(incidentId);
    if (!row || (rank[severity] ?? 0) <= (rank[row.severity] ?? 0)) return;
    this.db.prepare('UPDATE incidents SET severity = ? WHERE id = ?').run(severity, incidentId);
  }

  /**
   * Per-link availability summary for the last `hours` hours, from stored samples and incidents.
   * Availability = share of samples where the link was not DOWN.
   */
  getAvailabilityReport(hours = 24) {
    const since = Date.now() - hours * 3600 * 1000;
    const rows = this.db.prepare(`
      SELECT link_id,
             COUNT(*) AS samples,
             SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down_samples,
             AVG(CASE WHEN status != 'down' THEN latency END) AS avg_latency,
             AVG(CASE WHEN status != 'down' THEN packet_loss END) AS avg_loss,
             MAX(CASE WHEN status != 'down' THEN latency END) AS max_latency
      FROM metrics
      WHERE timestamp >= ?
      GROUP BY link_id
    `).all(since);
    const incidents = this.db.prepare(`
      SELECT link_id,
             COUNT(*) AS incidents,
             SUM(CASE WHEN severity = 'DOWN' THEN 1 ELSE 0 END) AS outages,
             SUM(COALESCE(end_time, ?) - MAX(start_time, ?)) AS impacted_ms
      FROM incidents
      WHERE COALESCE(end_time, ?) >= ?
      GROUP BY link_id
    `).all(Date.now(), since, Date.now(), since);
    const byLink = {};
    for (const r of rows) {
      byLink[r.link_id] = {
        linkId: r.link_id,
        samples: r.samples,
        availabilityPct: r.samples ? Number((100 * (r.samples - r.down_samples) / r.samples).toFixed(3)) : null,
        avgLatencyMs: r.avg_latency === null ? null : Number(r.avg_latency.toFixed(1)),
        maxLatencyMs: r.max_latency === null ? null : Number(r.max_latency.toFixed(1)),
        avgLossPct: r.avg_loss === null ? null : Number(r.avg_loss.toFixed(2)),
        incidents: 0,
        outages: 0,
        impactedMinutes: 0
      };
    }
    for (const r of incidents) {
      const entry = byLink[r.link_id] || (byLink[r.link_id] = { linkId: r.link_id, samples: 0, availabilityPct: null });
      entry.incidents = r.incidents;
      entry.outages = r.outages;
      entry.impactedMinutes = Math.round((r.impacted_ms || 0) / 60000);
    }
    return { hours, since, links: Object.values(byLink) };
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

  pruneOldIncidents(maxAgeDays = 365) {
    const cutoff = Date.now() - (maxAgeDays * 86400 * 1000);
    return this.db.prepare('DELETE FROM incidents WHERE resolved = 1 AND start_time < ?').run(cutoff);
  }

  close() {
    this.db.close();
  }
}

module.exports = MonitorDB;
