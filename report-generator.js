/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Daily availability report: builds the numbers for one calendar day (server local time)
 * and renders them as HTML (download / email), plain text (chat channels) and CSV.
 */

const LEVELS = ['HEALTHY', 'WARNING', 'CRITICAL', 'DOWN'];

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD' for a Date in server local time. */
function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** [start, end) of a local calendar day. */
function dayWindow(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) throw new Error('Date must be in YYYY-MM-DD format');
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(start.getTime()) || localDateString(start) !== dateStr) throw new Error(`Invalid date: ${dateStr}`);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function yesterday(now = new Date()) {
  return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function percentile(values, p) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

const avg = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

/**
 * Assign each sample the time until the next sample, capped so that a gap in monitoring
 * (service stopped, PC off) is not counted as time in the previous state.
 */
function withDurations(rows, windowEnd, fallbackMs) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].timestamp - rows[i - 1].timestamp);
  const typical = median(gaps) || fallbackMs;
  const cap = Math.max(typical * 3, 15000);
  return rows.map((r, i) => {
    const next = i + 1 < rows.length ? rows[i + 1].timestamp : Math.min(windowEnd, r.timestamp + typical);
    return { ...r, duration: Math.max(0, Math.min(next - r.timestamp, cap)) };
  });
}

function levelOf(row) {
  if (row.level && LEVELS.includes(row.level)) return row.level;
  return row.status === 'down' ? 'DOWN' : 'HEALTHY'; // rows recorded before v2 have no level
}

/**
 * Build the report object for one day.
 * @param {object} p
 * @param {MonitorDB} p.db
 * @param {string} p.date        'YYYY-MM-DD' (server local time)
 * @param {object} p.links       { wan1: 'MTN (port1)', wan2: 'Airtel (port2)' }
 * @param {string} [p.site]
 * @param {number} [p.pollIntervalMs]
 */
function buildDailyReport({ db, date, links, site = 'FortiGate', pollIntervalMs = 5000, now = Date.now() }) {
  const { start, end } = dayWindow(date);
  const effectiveEnd = Math.min(end, now);
  const windowMs = Math.max(0, effectiveEnd - start);
  const rows = db.getMetricsBetween(start, end);
  const incidents = db.getIncidentsBetween(start, end);

  const linkIds = Object.keys(links);
  const perLink = {};
  const byTimestamp = new Map();

  for (const linkId of linkIds) {
    const samples = withDurations(rows.filter(r => r.link_id === linkId), effectiveEnd, pollIntervalMs);
    const timeByLevel = Object.fromEntries(LEVELS.map(l => [l, 0]));
    let monitoredMs = 0;
    let downMs = 0;
    const lat = [];
    const loss = [];
    const jit = [];
    for (const s of samples) {
      monitoredMs += s.duration;
      timeByLevel[levelOf(s)] += s.duration;
      if (s.status === 'down') {
        downMs += s.duration;
      } else {
        if (s.latency !== null) lat.push(s.latency);
        if (s.packet_loss !== null) loss.push(s.packet_loss);
        if (s.jitter !== null) jit.push(s.jitter);
      }
      const entry = byTimestamp.get(s.timestamp) || { duration: s.duration, down: {} };
      entry.duration = Math.min(entry.duration, s.duration);
      entry.down[linkId] = s.status === 'down';
      byTimestamp.set(s.timestamp, entry);
    }

    const linkIncidents = incidents.filter(i => i.link_id === linkId).map(i => {
      const s = Math.max(i.start_time, start);
      const e = Math.min(i.end_time || now, effectiveEnd || end);
      return {
        start: i.start_time,
        end: i.end_time,
        ongoing: !i.resolved,
        durationMs: Math.max(0, e - s),
        severity: i.severity,
        reason: i.trigger_reason,
        peakLatency: i.peak_latency,
        peakLoss: i.peak_loss
      };
    });
    const outages = linkIncidents.filter(i => i.severity === 'DOWN');

    perLink[linkId] = {
      linkId,
      label: links[linkId],
      samples: samples.length,
      monitoredMs,
      coveragePct: windowMs ? r1(Math.min(100, (100 * monitoredMs) / windowMs)) : 0,
      availabilityPct: monitoredMs ? r2((100 * (monitoredMs - downMs)) / monitoredMs) : null,
      downMs,
      timeByLevel,
      degradedMs: timeByLevel.WARNING + timeByLevel.CRITICAL,
      incidents: linkIncidents.length,
      outages: outages.length,
      longestOutageMs: outages.reduce((m, i) => Math.max(m, i.durationMs), 0),
      latency: { avg: r1(avg(lat)), p95: r1(percentile(lat, 95)), max: r1(lat.length ? Math.max(...lat) : null) },
      loss: { avg: r2(avg(loss)), max: r2(loss.length ? Math.max(...loss) : null) },
      jitter: { avg: r1(avg(jit)) },
      incidentList: linkIncidents
    };
  }

  let bothDownMs = 0;
  let singleLinkMs = 0;
  for (const entry of byTimestamp.values()) {
    const states = linkIds.map(l => entry.down[l]).filter(v => v !== undefined);
    if (states.length < linkIds.length) continue;
    const downCount = states.filter(Boolean).length;
    if (downCount === linkIds.length) bothDownMs += entry.duration;
    else if (downCount > 0) singleLinkMs += entry.duration;
  }

  const report = {
    type: 'daily',
    site,
    date,
    start,
    end,
    partial: end > now,
    generatedAt: now,
    links: linkIds.map(l => perLink[l]),
    bothDownMs,
    singleLinkMs,
    hasData: rows.length > 0
  };
  report.headline = headline(report);
  return report;
}

function headline(report) {
  if (!report.hasData) return 'No monitoring data was recorded for this day.';
  const parts = report.links.map((l) => {
    if (!l.samples) return `${l.label}: no data`;
    if (!l.outages && !l.degradedMs) return `${l.label}: no problems`;
    const bits = [];
    if (l.outages) bits.push(`${l.outages} outage${l.outages > 1 ? 's' : ''} (${fmtDuration(l.downMs)} down)`);
    if (l.degradedMs >= 60000) bits.push(`${fmtDuration(l.degradedMs)} degraded`);
    return `${l.label}: ${bits.join(', ') || 'brief issues'}`;
  });
  const total = report.bothDownMs >= 1000
    ? ` Site had NO internet for ${fmtDuration(report.bothDownMs)} (both links down).`
    : ' The site never lost internet completely.';
  return `${parts.join('; ')}.${total}`;
}

// ---------------------------------------------------------------------------- rendering
function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const val = (v, unit = '') => (v === null || v === undefined ? '–' : `${v}${unit}`);
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function availabilityColor(pct) {
  if (pct === null) return '#64748b';
  if (pct >= 99.9) return '#059669';
  if (pct >= 99) return '#d97706';
  return '#dc2626';
}

/** Standalone HTML document (download) - the <body> content is also used for email. */
function renderHtml(report, { fragment = false } = {}) {
  const th = 'style="text-align:left;padding:8px 10px;border-bottom:2px solid #e2e8f0;color:#475569;font-size:12px;text-transform:uppercase;"';
  const td = 'style="padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top;"';
  const title = `Daily WAN report - ${report.site} - ${report.date}`;

  const summaryRows = report.links.map(l => `
    <tr>
      <td ${td}><strong>${esc(l.label)}</strong></td>
      <td ${td}><span style="color:${availabilityColor(l.availabilityPct)};font-weight:bold;">${val(l.availabilityPct, '%')}</span></td>
      <td ${td}>${l.outages} (${fmtDuration(l.downMs)})</td>
      <td ${td}>${fmtDuration(l.degradedMs)}</td>
      <td ${td}>${val(l.latency.avg, ' ms')} / ${val(l.latency.p95, ' ms')} / ${val(l.latency.max, ' ms')}</td>
      <td ${td}>${val(l.loss.avg, '%')} / ${val(l.loss.max, '%')}</td>
      <td ${td}>${val(l.coveragePct, '%')}</td>
    </tr>`).join('');

  const incidentRows = report.links.flatMap(l => l.incidentList.map(i => ({ ...i, label: l.label })))
    .sort((a, b) => a.start - b.start)
    .map(i => `
    <tr>
      <td ${td}>${time(i.start)}${i.end ? ` - ${time(i.end)}` : ' - ongoing'}</td>
      <td ${td}>${esc(i.label)}</td>
      <td ${td}>${esc(i.severity)}</td>
      <td ${td}>${fmtDuration(i.durationMs)}</td>
      <td ${td}>${esc(i.reason)}</td>
    </tr>`).join('');

  const body = `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:820px;margin:0 auto;color:#1e293b;font-size:14px;">
  <div style="background:#0f172a;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0;">
    <div style="font-size:12px;opacity:.8;">FortiGate WAN Monitor · ${esc(report.site)}</div>
    <div style="font-size:20px;font-weight:bold;margin-top:4px;">Daily WAN report for ${esc(report.date)}${report.partial ? ' (so far)' : ''}</div>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;padding:18px 22px;border-radius:0 0 8px 8px;">
    <p style="font-size:15px;margin-top:0;">${esc(report.headline)}</p>
    <table style="border-collapse:collapse;margin:6px 0 16px;">
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Both links down (no internet)</td><td><strong style="color:${report.bothDownMs ? '#dc2626' : '#059669'};">${fmtDuration(report.bothDownMs)}</strong></td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#64748b;">Running on a single link</td><td><strong>${fmtDuration(report.singleLinkMs)}</strong></td></tr>
    </table>
    <h3 style="margin:18px 0 8px;font-size:15px;">Per-link summary</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><th ${th}>Link</th><th ${th}>Availability</th><th ${th}>Outages (down time)</th><th ${th}>Degraded</th><th ${th}>Latency avg / p95 / max</th><th ${th}>Loss avg / max</th><th ${th}>Data coverage</th></tr>
      ${summaryRows}
    </table>
    <h3 style="margin:22px 0 8px;font-size:15px;">Incidents</h3>
    ${incidentRows ? `<table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><th ${th}>Time</th><th ${th}>Link</th><th ${th}>Worst level</th><th ${th}>Duration (this day)</th><th ${th}>Reason</th></tr>
      ${incidentRows}
    </table>` : '<p style="color:#059669;">No incidents recorded.</p>'}
    <p style="font-size:12px;color:#94a3b8;margin-top:22px;">
      Availability = share of monitored time the link was passing traffic. Degraded = time confirmed at WARNING or CRITICAL.
      Data coverage below 100% means the monitor was not running for part of the day.
      Generated ${esc(new Date(report.generatedAt).toLocaleString())}.
    </p>
  </div>
</div>`;

  if (fragment) return body;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head>` +
    `<body style="background:#f8fafc;padding:20px;">${body}</body></html>`;
}

/** Short summary for chat channels (Telegram, WhatsApp, Slack, Teams, Discord). */
function renderText(report) {
  const lines = [report.headline, ''];
  for (const l of report.links) {
    lines.push(`${l.label}: availability ${val(l.availabilityPct, '%')}, ${l.outages} outage(s) / ${fmtDuration(l.downMs)} down, ` +
      `${fmtDuration(l.degradedMs)} degraded, latency avg ${val(l.latency.avg, ' ms')}, loss avg ${val(l.loss.avg, '%')}`);
  }
  lines.push('', `Both links down: ${fmtDuration(report.bothDownMs)} | Single-link time: ${fmtDuration(report.singleLinkMs)}`);
  return lines.join('\n');
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderCsv(report) {
  const out = [];
  out.push(['Report', 'Site', 'Date', 'Both links down (min)', 'Single link (min)'].join(','));
  out.push(['Daily WAN report', report.site, report.date, (report.bothDownMs / 60000).toFixed(1), (report.singleLinkMs / 60000).toFixed(1)].map(csvCell).join(','));
  out.push('');
  out.push(['Link', 'Availability %', 'Outages', 'Down (min)', 'Degraded (min)', 'Warning (min)', 'Critical (min)',
    'Latency avg ms', 'Latency p95 ms', 'Latency max ms', 'Loss avg %', 'Loss max %', 'Jitter avg ms', 'Coverage %'].join(','));
  for (const l of report.links) {
    out.push([l.label, l.availabilityPct, l.outages, (l.downMs / 60000).toFixed(1), (l.degradedMs / 60000).toFixed(1),
      (l.timeByLevel.WARNING / 60000).toFixed(1), (l.timeByLevel.CRITICAL / 60000).toFixed(1),
      l.latency.avg, l.latency.p95, l.latency.max, l.loss.avg, l.loss.max, l.jitter.avg, l.coveragePct].map(csvCell).join(','));
  }
  out.push('');
  out.push(['Incident start', 'Incident end', 'Link', 'Worst level', 'Duration this day (min)', 'Peak latency ms', 'Peak loss %', 'Reason'].join(','));
  for (const l of report.links) {
    for (const i of l.incidentList) {
      out.push([new Date(i.start).toISOString(), i.end ? new Date(i.end).toISOString() : 'ongoing', l.label, i.severity,
        (i.durationMs / 60000).toFixed(1), i.peakLatency, i.peakLoss, i.reason].map(csvCell).join(','));
    }
  }
  return out.join('\r\n');
}

module.exports = { buildDailyReport, renderHtml, renderText, renderCsv, dayWindow, localDateString, yesterday, fmtDuration };
