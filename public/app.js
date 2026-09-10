/**
 * FortiGate Dual-WAN Link Monitor & Failover Guard
 * Client Application Logic & Real-time Visualizer
 */

// State
let sseSource = null;
let audioEnabled = true;
let currentHistoryMinutes = 15;
let telemetryHistory = [];
let audioContext = null;
let linkLabels = {};

// Threshold values for chart reference lines
let thresholds = {
  latencyWarningMs: 120,
  latencyCriticalMs: 250,
  packetLossWarning: 2.0,
  packetLossCritical: 8.0
};

// DOM Elements
const el = {
  pulseIndicator: document.getElementById('pulseIndicator'),
  fgStatusBadge: document.getElementById('fgStatusBadge'),
  fgStatusText: document.getElementById('fgStatusText'),
  sseStatusBadge: document.getElementById('sseStatusBadge'),
  sseStatusText: document.getElementById('sseStatusText'),
  btnAudioToggle: document.getElementById('btnAudioToggle'),
  audioIcon: document.getElementById('audioIcon'),
  audioText: document.getElementById('audioText'),
  globalAlertBanner: document.getElementById('globalAlertBanner'),
  bannerTitle: document.getElementById('bannerTitle'),
  bannerDetails: document.getElementById('bannerDetails'),
  btnDismissBanner: document.getElementById('btnDismissBanner'),

  // WAN1
  wan1Card: document.getElementById('wan1Card'),
  wan1StatusPill: document.getElementById('wan1StatusPill'),
  wan1StatusText: document.getElementById('wan1StatusText'),
  wan1Latency: document.getElementById('wan1Latency'),
  wan1Loss: document.getElementById('wan1Loss'),
  wan1Jitter: document.getElementById('wan1Jitter'),
  wan1Bandwidth: document.getElementById('wan1Bandwidth'),
  wan1IssuesBox: document.getElementById('wan1IssuesBox'),
  wan1CarrierBadge: document.getElementById('wan1CarrierBadge'),
  wan1LastSync: document.getElementById('wan1LastSync'),

  // WAN2
  wan2Card: document.getElementById('wan2Card'),
  wan2StatusPill: document.getElementById('wan2StatusPill'),
  wan2StatusText: document.getElementById('wan2StatusText'),
  wan2Latency: document.getElementById('wan2Latency'),
  wan2Loss: document.getElementById('wan2Loss'),
  wan2Jitter: document.getElementById('wan2Jitter'),
  wan2Bandwidth: document.getElementById('wan2Bandwidth'),
  wan2IssuesBox: document.getElementById('wan2IssuesBox'),
  wan2CarrierBadge: document.getElementById('wan2CarrierBadge'),
  wan2LastSync: document.getElementById('wan2LastSync'),

  // Sim
  chkSimulationToggle: document.getElementById('chkSimulationToggle'),
  simModeBadge: document.getElementById('simModeBadge'),
  simButtonsGroup: document.getElementById('simButtonsGroup'),

  // Charts
  latencyChart: document.getElementById('latencyChart'),
  lossChart: document.getElementById('lossChart'),

  // Incidents
  incidentsTableBody: document.getElementById('incidentsTableBody'),
  btnRefreshIncidents: document.getElementById('btnRefreshIncidents'),

  // Modals
  reportsModal: document.getElementById('reportsModal'),
  btnOpenReports: document.getElementById('btnOpenReports'),
  btnCloseReports: document.getElementById('btnCloseReports'),
  reportDate: document.getElementById('reportDate'),
  reportContent: document.getElementById('reportContent'),
  reportFeedback: document.getElementById('reportFeedback'),

  settingsModal: document.getElementById('settingsModal'),
  btnOpenSettings: document.getElementById('btnOpenSettings'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  btnCancelSettings: document.getElementById('btnCancelSettings'),
  btnSaveSettings: document.getElementById('btnSaveSettings'),
  btnTestFgConnection: document.getElementById('btnTestFgConnection'),
  fgTestResult: document.getElementById('fgTestResult'),
  notifTestFeedback: document.getElementById('notifTestFeedback')
};

// Canvas 2D contexts
const latencyCtx = el.latencyChart.getContext('2d');
const lossCtx = el.lossChart.getContext('2d');

/**
 * Initialize Application
 */
async function init() {
  setupEventListeners();
  setupSimulationButtons();
  setupSettingsTabs();
  setupCanvasAutoResize();
  await loadInitialStatus();
  await loadHistory(currentHistoryMinutes);
  await loadIncidents();
  connectSse();

  setInterval(renderCharts, 2000);
}

/**
 * Audio Synthesizer (Web Audio API)
 */
function playAlertSound(severity = 'WARNING') {
  if (!audioEnabled) return;
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);

    const now = audioContext.currentTime;
    if (severity === 'CRITICAL') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(440, now + 0.15);
      osc.frequency.setValueAtTime(880, now + 0.3);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.2);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    }
  } catch (e) {}
}

/**
 * Connect Server-Sent Events (SSE) Stream
 */
function connectSse() {
  if (sseSource) sseSource.close();

  sseSource = new EventSource('/api/events');

  sseSource.onopen = () => {
    el.sseStatusBadge.className = 'badge sse-status active';
    el.sseStatusText.textContent = 'Live Feed: Connected';
  };

  sseSource.onerror = () => {
    el.sseStatusBadge.className = 'badge sse-status error';
    el.sseStatusText.textContent = 'Live Feed: Reconnecting...';
  };

  sseSource.addEventListener('metrics', (e) => {
    try {
      const data = JSON.parse(e.data);
      updateDashboard(data);
    } catch (err) {
      console.error('Failed to parse SSE metrics:', err);
    }
  });

  sseSource.addEventListener('alert', (e) => {
    try {
      const alert = JSON.parse(e.data);
      handleIncomingAlert(alert);
    } catch (err) {
      console.error('Failed to parse SSE alert:', err);
    }
  });
}

/**
 * Load Initial State from REST API
 */
async function loadInitialStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    updateDashboard(data);
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

/**
 * Load Historical Data for Charts
 */
async function loadHistory(minutes = 15) {
  try {
    const res = await fetch(`/api/history?minutes=${minutes}`);
    const data = await res.json();
    telemetryHistory = data;
    renderCharts();
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

/**
 * Load Recent Degradation Incidents
 */
async function loadIncidents() {
  try {
    const res = await fetch('/api/incidents');
    const data = await res.json();
    renderIncidentsTable(data);
  } catch (err) {
    console.error('Failed to load incidents:', err);
  }
}

/**
 * Update Dashboard with incoming telemetry
 */
function updateDashboard(data) {
  if (!data) return;

  const { wan1, wan2, fortigateStatus, isSimulating, timestamp } = data;
  if (data.thresholds) thresholds = { ...thresholds, ...data.thresholds };

  if (isSimulating !== undefined) {
    el.chkSimulationToggle.checked = isSimulating;
    el.simModeBadge.textContent = isSimulating ? 'SIMULATOR ACTIVE' : 'REAL FORTIGATE';
    el.simModeBadge.style.background = isSimulating ? '#f59e0b' : '#10b981';
  }

  if (fortigateStatus) {
    if (isSimulating) {
      el.fgStatusBadge.className = 'badge fg-status';
      el.fgStatusText.textContent = 'FortiGate: Simulating';
      el.fgStatusBadge.title = 'Simulation mode generates fake data. Turn it off to monitor the real FortiGate.';
    } else if (fortigateStatus.connected) {
      el.fgStatusBadge.className = 'badge fg-status active';
      el.fgStatusText.textContent = `FortiGate: Online (${fortigateStatus.hostname || 'Active'})`;
      el.fgStatusBadge.title = fortigateStatus.version || '';
    } else {
      el.fgStatusBadge.className = 'badge fg-status error';
      el.fgStatusText.textContent = 'FortiGate: Disconnected';
      el.fgStatusBadge.title = fortigateStatus.lastError || '';
    }
  }

  if (wan1) { linkLabels.wan1 = wan1.label; updateLinkCard('wan1', wan1); }
  if (wan2) { linkLabels.wan2 = wan2.label; updateLinkCard('wan2', wan2); }
  if (wan1?.label) document.getElementById('legendWan1').textContent = wan1.label;
  if (wan2?.label) document.getElementById('legendWan2').textContent = wan2.label;

  if (timestamp) {
    if (wan1 && wan1.status !== 'UNKNOWN' && !wan1.stale) {
      telemetryHistory.push({
        timestamp,
        link_id: 'wan1',
        latency: wan1.latency,
        packet_loss: wan1.packetLoss,
        jitter: wan1.jitter,
        status: wan1.status
      });
    }
    if (wan2 && wan2.status !== 'UNKNOWN' && !wan2.stale) {
      telemetryHistory.push({
        timestamp,
        link_id: 'wan2',
        latency: wan2.latency,
        packet_loss: wan2.packetLoss,
        jitter: wan2.jitter,
        status: wan2.status
      });
    }

    const cutoff = Date.now() - (currentHistoryMinutes * 60 * 1000);
    telemetryHistory = telemetryHistory.filter(h => h.timestamp >= cutoff);
    renderCharts();
  }
}

/**
 * Update individual WAN link card
 */
function updateLinkCard(id, link) {
  const isWan1 = id === 'wan1';
  const card = isWan1 ? el.wan1Card : el.wan2Card;
  const pill = isWan1 ? el.wan1StatusPill : el.wan2StatusPill;
  const statusText = isWan1 ? el.wan1StatusText : el.wan2StatusText;
  const latency = isWan1 ? el.wan1Latency : el.wan2Latency;
  const loss = isWan1 ? el.wan1Loss : el.wan2Loss;
  const jitter = isWan1 ? el.wan1Jitter : el.wan2Jitter;
  const bandwidth = isWan1 ? el.wan1Bandwidth : el.wan2Bandwidth;
  const issuesBox = isWan1 ? el.wan1IssuesBox : el.wan2IssuesBox;
  const carrier = isWan1 ? el.wan1CarrierBadge : el.wan2CarrierBadge;
  const lastSync = isWan1 ? el.wan1LastSync : el.wan2LastSync;

  const status = (link.status || 'UNKNOWN').toUpperCase();
  const fmt = (v, unit, digits = 1) => (v === null || v === undefined ? '--' : `${Number(v).toFixed(digits)} ${unit}`);

  const nameEl = document.getElementById(`${id}Name`);
  if (nameEl && link.label) nameEl.textContent = link.label;
  const ifEl = document.getElementById(`${id}IfName`);
  if (ifEl) {
    ifEl.textContent = `Interface: ${link.interface || id}` + (link.healthCheck ? ` · SLA: ${link.healthCheck}` : '');
  }

  card.classList.remove('status-warning', 'status-critical', 'status-unknown');
  pill.classList.remove('status-healthy', 'status-warning', 'status-critical', 'status-unknown');

  if (status === 'CRITICAL' || status === 'DOWN') {
    card.classList.add('status-critical');
    pill.classList.add('status-critical');
    statusText.textContent = status === 'DOWN' ? 'DOWN' : 'CRITICAL';
  } else if (status === 'WARNING' || status === 'DEGRADED') {
    card.classList.add('status-warning');
    pill.classList.add('status-warning');
    statusText.textContent = 'DEGRADED';
  } else if (status === 'UNKNOWN') {
    card.classList.add('status-unknown');
    pill.classList.add('status-unknown');
    statusText.textContent = 'NO DATA';
  } else {
    pill.classList.add('status-healthy');
    statusText.textContent = link.stale ? 'HEALTHY (STALE)' : 'HEALTHY';
  }

  latency.textContent = status === 'DOWN' ? 'DOWN' : fmt(link.latency, 'ms');
  loss.textContent = fmt(link.packetLoss, '%');
  jitter.textContent = fmt(link.jitter, 'ms');

  const colorFor = (v, warn, crit) => (v === null || v === undefined ? 'var(--text-primary)'
    : v >= crit ? 'var(--color-critical)' : v >= warn ? 'var(--color-warning)' : 'var(--text-primary)');
  loss.style.color = colorFor(link.packetLoss, thresholds.packetLossWarning, thresholds.packetLossCritical);
  latency.style.color = colorFor(link.latency, thresholds.latencyWarningMs, thresholds.latencyCriticalMs);
  jitter.style.color = colorFor(link.jitter, thresholds.jitterWarningMs, thresholds.jitterCriticalMs);

  const latSub = document.getElementById(`${id}LatencySub`);
  if (latSub) latSub.textContent = `Target < ${thresholds.latencyWarningMs}ms`;
  const lossSub = document.getElementById(`${id}LossSub`);
  if (lossSub) lossSub.textContent = `Target < ${thresholds.packetLossWarning}%`;

  if (link.rxKbps === null || link.rxKbps === undefined) {
    bandwidth.textContent = '-- Mb/s';
  } else {
    bandwidth.textContent = `${(link.rxKbps / 1000).toFixed(1)} / ${((link.txKbps || 0) / 1000).toFixed(1)} Mb/s`;
  }

  if (link.linkState === 'down') {
    carrier.className = 'carrier-badge carrier-down';
    carrier.textContent = 'CARRIER DOWN';
  } else if (link.linkState === 'no-traffic') {
    carrier.className = 'carrier-badge carrier-down';
    carrier.textContent = 'UP, NO TRAFFIC';
  } else if (link.linkState === 'up') {
    carrier.className = 'carrier-badge carrier-up';
    carrier.textContent = 'CARRIER UP';
  } else {
    carrier.className = 'carrier-badge';
    carrier.textContent = 'UNKNOWN';
  }

  const notes = [...(link.issues || [])];
  if (link.reason && (status === 'UNKNOWN' || link.stale)) notes.unshift(link.reason);
  if (notes.length > 0) {
    issuesBox.classList.remove('hidden', 'warning-mode');
    if (status === 'WARNING' || status === 'UNKNOWN') issuesBox.classList.add('warning-mode');
    const heading = status === 'UNKNOWN' || link.stale ? 'ℹ️ Monitoring note:' : '⚠️ Issues Detected:';
    issuesBox.innerHTML = `<strong>${heading}</strong>${notes.map(i => `<div>• ${escapeHtml(i)}</div>`).join('')}`;
  } else {
    issuesBox.classList.add('hidden');
    issuesBox.innerHTML = '';
  }

  lastSync.textContent = link.lastUpdate ? `Updated: ${new Date(link.lastUpdate).toLocaleTimeString()}` : 'Waiting for data';
}

/**
 * Handle Incoming Alert Event
 */
function handleIncomingAlert(alert) {
  playAlertSound(alert.severity);

  el.globalAlertBanner.classList.remove('hidden');
  el.bannerTitle.textContent = alert.title;
  el.bannerDetails.textContent = alert.message;

  if (alert.severity === 'RECOVERED') {
    el.globalAlertBanner.style.borderColor = 'var(--color-healthy)';
    el.globalAlertBanner.style.background = 'rgba(16, 185, 129, 0.15)';
    el.bannerTitle.style.color = 'var(--color-healthy)';
  } else if (alert.severity === 'WARNING' || alert.localOnly) {
    el.globalAlertBanner.style.borderColor = 'var(--color-warning)';
    el.globalAlertBanner.style.background = 'rgba(245, 158, 11, 0.15)';
    el.bannerTitle.style.color = 'var(--color-warning)';
  } else {
    el.globalAlertBanner.style.borderColor = 'var(--color-critical)';
    el.globalAlertBanner.style.background = 'rgba(239, 68, 68, 0.15)';
    el.bannerTitle.style.color = 'var(--color-critical)';
  }

  setTimeout(loadIncidents, 1000);
}

/**
 * Render Incidents Table
 */
function renderIncidentsTable(incidents) {
  if (!incidents || incidents.length === 0) {
    el.incidentsTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">No degradation incidents recorded. Both WAN links operating normally.</td>
      </tr>
    `;
    return;
  }

  el.incidentsTableBody.innerHTML = incidents.map(inc => {
    const startDate = new Date(inc.start_time);
    const durationStr = inc.end_time
      ? formatDuration((inc.end_time - inc.start_time) / 1000)
      : '<span style="color:var(--color-critical); font-weight:700;">Ongoing Active</span>';

    const statusBadge = inc.resolved
      ? '<span class="carrier-badge carrier-up">RESOLVED</span>'
      : '<span class="carrier-badge carrier-down">ACTIVE INCIDENT</span>';

    const severityClass = inc.severity === 'CRITICAL' || inc.severity === 'DOWN' ? 'status-critical' : 'status-warning';
    const linkName = linkLabels[inc.link_id] || inc.link_id.toUpperCase();

    return `
      <tr>
        <td>${startDate.toLocaleDateString()} ${startDate.toLocaleTimeString()}</td>
        <td><strong>${escapeHtml(linkName)}</strong></td>
        <td><span class="status-pill ${severityClass}" style="padding:2px 8px; font-size:0.7rem;">${escapeHtml(inc.severity)}</span></td>
        <td>${escapeHtml(inc.trigger_reason)}</td>
        <td>Max Lat: ${inc.peak_latency}ms | Max Loss: ${inc.peak_loss}%</td>
        <td>${durationStr}</td>
        <td>${statusBadge}</td>
      </tr>
    `;
  }).join('');
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  if (h < 24) return `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Canvas High-Performance Chart Rendering
 */
function renderCharts() {
  const cutoff = Date.now() - (currentHistoryMinutes * 60 * 1000);
  const w1Data = telemetryHistory.filter(h => h.link_id === 'wan1' && h.timestamp >= cutoff);
  const w2Data = telemetryHistory.filter(h => h.link_id === 'wan2' && h.timestamp >= cutoff);

  drawChart(latencyCtx, el.latencyChart, {
    title: 'Latency',
    unit: 'ms',
    w1Data,
    w2Data,
    valueKey: 'latency',
    warnVal: thresholds.latencyWarningMs,
    critVal: thresholds.latencyCriticalMs,
    yMaxDefault: 200
  });

  drawChart(lossCtx, el.lossChart, {
    title: 'Packet Loss',
    unit: '%',
    w1Data,
    w2Data,
    valueKey: 'packet_loss',
    warnVal: thresholds.packetLossWarning,
    critVal: thresholds.packetLossCritical,
    yMaxDefault: 10
  });
}

function drawChart(ctx, canvas, opts) {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 20, right: 25, bottom: 25, left: 45 };
  const graphW = width - padding.left - padding.right;
  const graphH = height - padding.top - padding.bottom;

  const now = Date.now();
  const startTime = now - (currentHistoryMinutes * 60 * 1000);

  let maxVal = opts.yMaxDefault;
  for (const p of opts.w1Data) if (p[opts.valueKey] > maxVal) maxVal = p[opts.valueKey] * 1.15;
  for (const p of opts.w2Data) if (p[opts.valueKey] > maxVal) maxVal = p[opts.valueKey] * 1.15;
  if (opts.critVal && opts.critVal * 1.2 > maxVal) maxVal = opts.critVal * 1.2;
  if (opts.unit === '%') maxVal = Math.min(maxVal, 100);

  ctx.strokeStyle = '#1f2a3f';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';

  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const yVal = (maxVal / steps) * i;
    const yPos = padding.top + graphH - (yVal / maxVal) * graphH;

    ctx.beginPath();
    ctx.moveTo(padding.left, yPos);
    ctx.lineTo(padding.left + graphW, yPos);
    ctx.stroke();

    ctx.fillText(`${Math.round(yVal)}${opts.unit}`, padding.left - 6, yPos + 3);
  }

  const drawThreshold = (val, color, label) => {
    if (val > maxVal) return;
    const yPos = padding.top + graphH - (val / maxVal) * graphH;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, yPos);
    ctx.lineTo(padding.left + graphW, yPos);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(`${label} (${val}${opts.unit})`, padding.left + graphW, yPos - 4);
    ctx.restore();
  };

  if (opts.warnVal) drawThreshold(opts.warnVal, '#f59e0b', 'WARN');
  if (opts.critVal) drawThreshold(opts.critVal, '#ef4444', 'CRIT');

  // Draws one line per run of valid points; down/missing samples leave a gap instead of
  // dropping to zero (a dead link must not look like a perfect 0 ms link).
  const drawLine = (data, strokeColor, fillColor) => {
    if (!data || data.length === 0) return;
    const segments = [];
    let current = [];
    for (const d of data) {
      const v = d[opts.valueKey];
      const missing = v === null || v === undefined || (opts.valueKey === 'latency' && (d.status === 'down' || d.status === 'DOWN'));
      if (missing) {
        if (current.length) segments.push(current);
        current = [];
        continue;
      }
      const x = padding.left + ((d.timestamp - startTime) / (now - startTime)) * graphW;
      const y = padding.top + graphH - (Math.min(v, maxVal) / maxVal) * graphH;
      current.push({ x, y });
    }
    if (current.length) segments.push(current);

    ctx.save();
    for (const points of segments) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (points.length > 1) {
        ctx.lineTo(points[points.length - 1].x, padding.top + graphH);
        ctx.lineTo(points[0].x, padding.top + graphH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + graphH);
        grad.addColorStop(0, fillColor);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }
    ctx.restore();
  };

  drawLine(opts.w2Data, '#a855f7', 'rgba(168, 85, 247, 0.2)');
  drawLine(opts.w1Data, '#00f0ff', 'rgba(0, 240, 255, 0.2)');
}

function setupCanvasAutoResize() {
  const resize = () => {
    for (const canvas of [el.latencyChart, el.lossChart]) {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = 220 * window.devicePixelRatio;
      const ctx = canvas.getContext('2d');
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }
    renderCharts();
  };
  window.addEventListener('resize', resize);
  setTimeout(resize, 100);
}

function setupEventListeners() {
  el.btnAudioToggle.addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    el.audioIcon.textContent = audioEnabled ? '🔔' : '🔕';
    el.audioText.textContent = audioEnabled ? 'Alert Audio: ON' : 'Alert Audio: OFF';
    el.btnAudioToggle.classList.toggle('active', audioEnabled);
    if (audioEnabled) playAlertSound('HEALTHY');
  });

  el.btnDismissBanner.addEventListener('click', () => {
    el.globalAlertBanner.classList.add('hidden');
  });

  document.querySelectorAll('.btn-time').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-time').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentHistoryMinutes = parseInt(btn.dataset.minutes, 10);
      loadHistory(currentHistoryMinutes);
    });
  });

  el.btnRefreshIncidents.addEventListener('click', loadIncidents);

  el.chkSimulationToggle.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await fetch('/api/simulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
  });

  // Reports
  el.btnOpenReports.addEventListener('click', openReportsModal);
  el.btnCloseReports.addEventListener('click', () => el.reportsModal.classList.add('hidden'));
  document.getElementById('btnGenerateReport').addEventListener('click', generateReport);
  document.getElementById('btnReportHtml').addEventListener('click', () => {
    window.open(`/api/reports/daily?date=${encodeURIComponent(el.reportDate.value)}&format=html`, '_blank', 'noopener');
  });
  document.getElementById('btnReportCsv').addEventListener('click', () => {
    window.location.href = `/api/reports/daily?date=${encodeURIComponent(el.reportDate.value)}&format=csv`;
  });
  document.getElementById('btnSendReport').addEventListener('click', () => sendReport(el.reportDate.value, el.reportFeedback));
  document.getElementById('btnSendYesterdayReport').addEventListener('click', () =>
    sendReport(localDate(-1), document.getElementById('reportSettingsFeedback')));

  // Server port & webhook URL
  document.getElementById('btnApplyPort').addEventListener('click', applyPort);
  document.getElementById('btnCopyWebhook').addEventListener('click', async () => {
    const input = document.getElementById('cfgWebhookUrl');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
  });

  el.btnOpenSettings.addEventListener('click', openSettingsModal);
  el.btnCloseSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
  el.btnCancelSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
  el.btnSaveSettings.addEventListener('click', saveSettings);

  el.btnTestFgConnection.addEventListener('click', testFortiGateConnection);

  document.querySelectorAll('[data-test]').forEach(btn => {
    btn.addEventListener('click', () => testNotificationChannel(btn.dataset.test));
  });

  // WhatsApp provider selector toggle
  const waProviderSelect = document.getElementById('cfgWaProvider');
  if (waProviderSelect) {
    waProviderSelect.addEventListener('change', updateWhatsAppFieldsVisibility);
  }
}

function updateWhatsAppFieldsVisibility() {
  const provider = document.getElementById('cfgWaProvider').value;
  const cmbFields = document.getElementById('waCallmebotFields');
  const twilioFields = document.getElementById('waTwilioFields');
  const webhookFields = document.getElementById('waWebhookFields');

  if (cmbFields) cmbFields.classList.toggle('hidden', provider !== 'callmebot');
  if (twilioFields) twilioFields.classList.toggle('hidden', provider !== 'twilio');
  if (webhookFields) webhookFields.classList.toggle('hidden', provider !== 'webhook');
}

function setupSimulationButtons() {
  el.simButtonsGroup.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const linkId = btn.dataset.link;
      const condition = btn.dataset.condition;

      if (linkId === 'all') {
        await fetch('/api/simulation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkId: 'wan1', condition: 'normal' })
        });
        await fetch('/api/simulation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkId: 'wan2', condition: 'normal' })
        });
      } else {
        await fetch('/api/simulation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkId, condition })
        });
      }
    });
  });
}

function setupSettingsTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
}

async function openSettingsModal() {
  try {
    const res = await fetch('/api/settings');
    const cfg = await res.json();

    // FortiGate
    document.getElementById('cfgFgHost').value = cfg.fortigate?.host || '';
    document.getElementById('cfgFgToken').value = cfg.fortigate?.apiToken || '';
    document.getElementById('cfgFgWan1').value = cfg.fortigate?.wan1Interface || 'wan1';
    document.getElementById('cfgFgWan2').value = cfg.fortigate?.wan2Interface || 'wan2';
    document.getElementById('cfgFgHealthCheck').value = cfg.fortigate?.healthCheckName || 'Default_DNS';
    document.getElementById('cfgFgWan1Label').value = cfg.fortigate?.wan1Label || 'WAN 1';
    document.getElementById('cfgFgWan2Label').value = cfg.fortigate?.wan2Label || 'WAN 2';
    document.getElementById('cfgSiteName').value = cfg.fortigate?.siteName || '';
    const hookHost = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'
      ? location.hostname : (cfg.server?.addresses?.[0] || '<this-server-ip>');
    const hookUrl = `http://${hookHost}:${cfg.server?.port || location.port || 80}${cfg.webhook?.path || '/api/webhook/fortigate'}?token=${cfg.webhook?.token || ''}`;
    document.getElementById('cfgWebhookUrl').value = hookUrl;
    document.getElementById('securityNote').textContent = cfg.security?.passwordSet
      ? `Remote dashboard access is enabled (user "${cfg.security.user}").`
      : 'Remote dashboard access is disabled until you set a password: run "node server.js --set-password" on the server.';

    // Thresholds
    document.getElementById('thLossWarn').value = cfg.thresholds?.packetLossWarning ?? 2.0;
    document.getElementById('thLossCrit').value = cfg.thresholds?.packetLossCritical ?? 8.0;
    document.getElementById('thLatWarn').value = cfg.thresholds?.latencyWarningMs ?? 120;
    document.getElementById('thLatCrit').value = cfg.thresholds?.latencyCriticalMs ?? 250;
    document.getElementById('thJitWarn').value = cfg.thresholds?.jitterWarningMs ?? 25;
    document.getElementById('thJitCrit').value = cfg.thresholds?.jitterCriticalMs ?? 50;
    document.getElementById('thConsecFails').value = cfg.thresholds?.consecutiveFailsToAlert ?? 2;
    document.getElementById('thConsecRecovery').value = cfg.thresholds?.consecutiveHealthyToRecover ?? 4;
    document.getElementById('thReminder').value = cfg.thresholds?.reminderMinutes ?? 30;

    // Notifications: Windows Toast
    document.getElementById('notifWinToast').checked = !!cfg.notifications?.windowsToast?.enabled;

    // Notifications: Email (SMTP)
    const em = cfg.notifications?.email || {};
    document.getElementById('notifEmail').checked = !!em.enabled;
    document.getElementById('cfgSmtpHost').value = em.host || '';
    document.getElementById('cfgSmtpPort').value = em.port || 587;
    document.getElementById('cfgSmtpUser').value = em.user || '';
    document.getElementById('cfgSmtpPass').value = em.pass || '';
    document.getElementById('cfgSmtpFrom').value = em.from || '';
    document.getElementById('cfgSmtpTo').value = em.to || '';

    // Notifications: WhatsApp
    const wa = cfg.notifications?.whatsapp || {};
    document.getElementById('notifWhatsapp').checked = !!wa.enabled;
    document.getElementById('cfgWaProvider').value = wa.provider || 'callmebot';
    document.getElementById('cfgWaPhone').value = wa.phone || '';
    document.getElementById('cfgWaApiKey').value = wa.apiKey || '';
    document.getElementById('cfgTwilioSid').value = wa.accountSid || '';
    document.getElementById('cfgTwilioToken').value = wa.authToken || '';
    document.getElementById('cfgTwilioFrom').value = wa.twilioFrom || '';
    document.getElementById('cfgTwilioTo').value = wa.twilioTo || '';
    document.getElementById('cfgWaWebhookUrl').value = wa.webhookUrl || '';
    updateWhatsAppFieldsVisibility();

    // Notifications: Telegram
    document.getElementById('notifTelegram').checked = !!cfg.notifications?.telegram?.enabled;
    document.getElementById('cfgTeleToken').value = cfg.notifications?.telegram?.botToken || '';
    document.getElementById('cfgTeleChatId').value = cfg.notifications?.telegram?.chatId || '';

    // Notifications: Discord & Slack
    document.getElementById('notifDiscord').checked = !!cfg.notifications?.discord?.enabled;
    document.getElementById('cfgDiscordUrl').value = cfg.notifications?.discord?.webhookUrl || '';
    document.getElementById('notifSlack').checked = !!cfg.notifications?.slack?.enabled;
    document.getElementById('cfgSlackUrl').value = cfg.notifications?.slack?.webhookUrl || '';
    document.getElementById('cfgReportEnabled').checked = !!cfg.reports?.dailyEnabled;
    document.getElementById('cfgReportTime').value = cfg.reports?.dailyTime || '07:00';
    const portInput = document.getElementById('cfgServerPort');
    portInput.value = cfg.server?.port || location.port || 4000;
    portInput.disabled = !!cfg.server?.envOverride;
    document.getElementById('btnApplyPort').disabled = !!cfg.server?.envOverride;
    document.getElementById('portHint').textContent = cfg.server?.envOverride
      ? 'Set by the PORT environment variable; remove it to change the port here.'
      : 'Applies immediately. The dashboard reloads on the new port.';
    document.getElementById('portFeedback').textContent = '';
    document.getElementById('notifTeams').checked = !!cfg.notifications?.teams?.enabled;
    document.getElementById('cfgTeamsUrl').value = cfg.notifications?.teams?.webhookUrl || '';

    el.settingsModal.classList.remove('hidden');
  } catch (err) {
    alert(`Failed to load settings: ${err.message}`);
  }
}

async function saveSettings() {
  const payload = {
    fortigate: {
      host: document.getElementById('cfgFgHost').value,
      apiToken: document.getElementById('cfgFgToken').value,
      wan1Interface: document.getElementById('cfgFgWan1').value,
      wan2Interface: document.getElementById('cfgFgWan2').value,
      healthCheckName: document.getElementById('cfgFgHealthCheck').value,
      wan1Label: document.getElementById('cfgFgWan1Label').value,
      wan2Label: document.getElementById('cfgFgWan2Label').value,
      siteName: document.getElementById('cfgSiteName').value
    },
    thresholds: {
      packetLossWarning: parseFloat(document.getElementById('thLossWarn').value),
      packetLossCritical: parseFloat(document.getElementById('thLossCrit').value),
      latencyWarningMs: parseFloat(document.getElementById('thLatWarn').value),
      latencyCriticalMs: parseFloat(document.getElementById('thLatCrit').value),
      jitterWarningMs: parseFloat(document.getElementById('thJitWarn').value),
      jitterCriticalMs: parseFloat(document.getElementById('thJitCrit').value),
      consecutiveFailsToAlert: parseInt(document.getElementById('thConsecFails').value, 10),
      consecutiveHealthyToRecover: parseInt(document.getElementById('thConsecRecovery').value, 10),
      reminderMinutes: parseInt(document.getElementById('thReminder').value, 10)
    },
    notifications: {
      windowsToast: { enabled: document.getElementById('notifWinToast').checked },
      email: {
        enabled: document.getElementById('notifEmail').checked,
        host: document.getElementById('cfgSmtpHost').value,
        port: parseInt(document.getElementById('cfgSmtpPort').value || '587', 10),
        user: document.getElementById('cfgSmtpUser').value,
        pass: document.getElementById('cfgSmtpPass').value,
        from: document.getElementById('cfgSmtpFrom').value,
        to: document.getElementById('cfgSmtpTo').value
      },
      whatsapp: {
        enabled: document.getElementById('notifWhatsapp').checked,
        provider: document.getElementById('cfgWaProvider').value,
        phone: document.getElementById('cfgWaPhone').value,
        apiKey: document.getElementById('cfgWaApiKey').value,
        accountSid: document.getElementById('cfgTwilioSid').value,
        authToken: document.getElementById('cfgTwilioToken').value,
        twilioFrom: document.getElementById('cfgTwilioFrom').value,
        twilioTo: document.getElementById('cfgTwilioTo').value,
        webhookUrl: document.getElementById('cfgWaWebhookUrl').value
      },
      telegram: {
        enabled: document.getElementById('notifTelegram').checked,
        botToken: document.getElementById('cfgTeleToken').value,
        chatId: document.getElementById('cfgTeleChatId').value
      },
      discord: {
        enabled: document.getElementById('notifDiscord').checked,
        webhookUrl: document.getElementById('cfgDiscordUrl').value
      },
      slack: {
        enabled: document.getElementById('notifSlack').checked,
        webhookUrl: document.getElementById('cfgSlackUrl').value
      },
      teams: {
        enabled: document.getElementById('notifTeams').checked,
        webhookUrl: document.getElementById('cfgTeamsUrl').value
      }
    },
    reports: {
      dailyEnabled: document.getElementById('cfgReportEnabled').checked,
      dailyTime: document.getElementById('cfgReportTime').value || '07:00'
    }
  };

  thresholds = { ...payload.thresholds };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (result.success) {
      el.settingsModal.classList.add('hidden');
      renderCharts();
    } else {
      alert(`Failed to save: ${result.error || 'Unknown error'}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function testFortiGateConnection() {
  el.fgTestResult.textContent = 'Testing connection...';
  el.fgTestResult.style.color = 'var(--text-secondary)';

  try {
    const res = await fetch('/api/fortigate/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: document.getElementById('cfgFgHost').value,
        apiToken: document.getElementById('cfgFgToken').value,
        healthCheckName: document.getElementById('cfgFgHealthCheck').value,
        wan1Interface: document.getElementById('cfgFgWan1').value,
        wan2Interface: document.getElementById('cfgFgWan2').value
      })
    });
    const result = await res.json();
    if (result.success) {
      const hcs = (result.healthChecks || []).map(h => `${h.name} [${h.members.join(', ')}]`).join('; ');
      el.fgTestResult.textContent = `✅ Connected to ${result.hostname} (${result.version})` +
        (result.warning ? ` ⚠️ ${result.warning}` : '') + (hcs ? ` · Health checks: ${hcs}` : '');
      el.fgTestResult.style.color = result.warning ? 'var(--color-warning)' : 'var(--color-healthy)';
    } else {
      el.fgTestResult.textContent = `❌ Failed: ${result.error}`;
      el.fgTestResult.style.color = 'var(--color-critical)';
    }
  } catch (err) {
    el.fgTestResult.textContent = `❌ Error: ${err.message}`;
    el.fgTestResult.style.color = 'var(--color-critical)';
  }
}

async function testNotificationChannel(channel) {
  el.notifTestFeedback.textContent = `Sending test to ${channel}...`;
  el.notifTestFeedback.style.color = 'var(--text-secondary)';

  let body = { channel };

  if (channel === 'email') {
    body.emailConfig = {
      host: document.getElementById('cfgSmtpHost').value,
      port: parseInt(document.getElementById('cfgSmtpPort').value || '587', 10),
      user: document.getElementById('cfgSmtpUser').value,
      pass: document.getElementById('cfgSmtpPass').value,
      from: document.getElementById('cfgSmtpFrom').value,
      to: document.getElementById('cfgSmtpTo').value
    };
  } else if (channel === 'whatsapp') {
    body.whatsappConfig = {
      provider: document.getElementById('cfgWaProvider').value,
      phone: document.getElementById('cfgWaPhone').value,
      apiKey: document.getElementById('cfgWaApiKey').value,
      accountSid: document.getElementById('cfgTwilioSid').value,
      authToken: document.getElementById('cfgTwilioToken').value,
      twilioFrom: document.getElementById('cfgTwilioFrom').value,
      twilioTo: document.getElementById('cfgTwilioTo').value,
      webhookUrl: document.getElementById('cfgWaWebhookUrl').value
    };
  } else if (channel === 'telegram') {
    body.botToken = document.getElementById('cfgTeleToken').value;
    body.chatId = document.getElementById('cfgTeleChatId').value;
  } else if (channel === 'discord') {
    body.webhookUrl = document.getElementById('cfgDiscordUrl').value;
  } else if (channel === 'slack') {
    body.webhookUrl = document.getElementById('cfgSlackUrl').value;
  } else if (channel === 'teams') {
    body.webhookUrl = document.getElementById('cfgTeamsUrl').value;
  }

  try {
    const res = await fetch('/api/test-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res.json();
    if (result.success) {
      el.notifTestFeedback.textContent = `✅ ${result.message}`;
      el.notifTestFeedback.style.color = 'var(--color-healthy)';
    } else {
      el.notifTestFeedback.textContent = `❌ ${result.error}`;
      el.notifTestFeedback.style.color = 'var(--color-critical)';
    }
  } catch (err) {
    el.notifTestFeedback.textContent = `❌ Error: ${err.message}`;
    el.notifTestFeedback.style.color = 'var(--color-critical)';
  }
}

/**
 * Daily Reports
 */
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtMs(ms) {
  return formatDuration((ms || 0) / 1000);
}

function openReportsModal() {
  if (!el.reportDate.value) el.reportDate.value = localDate(-1);
  el.reportDate.max = localDate(0);
  el.reportFeedback.textContent = '';
  el.reportsModal.classList.remove('hidden');
  generateReport();
}

async function generateReport() {
  el.reportContent.innerHTML = '<p class="empty-state">Generating report...</p>';
  try {
    const res = await fetch(`/api/reports/daily?date=${encodeURIComponent(el.reportDate.value)}`);
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    renderReport(r);
  } catch (err) {
    el.reportContent.innerHTML = `<p class="empty-state">❌ ${escapeHtml(err.message)}</p>`;
  }
}

function renderReport(r) {
  const v = (x, unit = '') => (x === null || x === undefined ? '–' : `${x}${unit}`);
  const availClass = (p) => (p === null ? '' : p >= 99.9 ? 'good' : p >= 99 ? 'warn' : 'bad');
  const rows = r.links.map(l => `
    <tr>
      <td><strong>${escapeHtml(l.label)}</strong></td>
      <td><span class="avail ${availClass(l.availabilityPct)}">${v(l.availabilityPct, '%')}</span></td>
      <td>${l.outages} (${fmtMs(l.downMs)})</td>
      <td>${fmtMs(l.degradedMs)}</td>
      <td>${v(l.latency.avg, ' ms')} / ${v(l.latency.p95, ' ms')} / ${v(l.latency.max, ' ms')}</td>
      <td>${v(l.loss.avg, '%')} / ${v(l.loss.max, '%')}</td>
      <td>${v(l.coveragePct, '%')}</td>
    </tr>`).join('');
  const incidents = r.links.flatMap(l => l.incidentList.map(i => ({ ...i, label: l.label })))
    .sort((a, b) => a.start - b.start)
    .map(i => `
    <tr>
      <td>${new Date(i.start).toLocaleTimeString()}${i.end ? ` – ${new Date(i.end).toLocaleTimeString()}` : ' – ongoing'}</td>
      <td>${escapeHtml(i.label)}</td>
      <td>${escapeHtml(i.severity)}</td>
      <td>${fmtMs(i.durationMs)}</td>
      <td>${escapeHtml(i.reason)}</td>
    </tr>`).join('');

  el.reportContent.innerHTML = `
    <div class="report-headline">${escapeHtml(r.headline)}${r.partial ? ' <em>(day in progress)</em>' : ''}</div>
    <div class="report-kpis">
      <div class="report-kpi ${r.bothDownMs ? 'bad' : 'good'}"><span>No internet (both links down)</span><strong>${fmtMs(r.bothDownMs)}</strong></div>
      <div class="report-kpi"><span>Running on a single link</span><strong>${fmtMs(r.singleLinkMs)}</strong></div>
    </div>
    <div class="table-container">
      <table class="incidents-table">
        <thead><tr><th>Link</th><th>Availability</th><th>Outages (down)</th><th>Degraded</th><th>Latency avg / p95 / max</th><th>Loss avg / max</th><th>Coverage</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <h4 style="margin:18px 0 8px;">Incidents</h4>
    ${incidents ? `<div class="table-container"><table class="incidents-table">
      <thead><tr><th>Time</th><th>Link</th><th>Worst level</th><th>Duration (this day)</th><th>Reason</th></tr></thead>
      <tbody>${incidents}</tbody></table></div>` : '<p class="empty-state">No incidents recorded on this day.</p>'}`;
}

async function sendReport(date, feedbackEl) {
  feedbackEl.textContent = 'Sending report...';
  feedbackEl.style.color = 'var(--text-secondary)';
  try {
    const res = await fetch('/api/reports/daily/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date })
    });
    const r = await res.json();
    if (!res.ok || !r.success) throw new Error(r.error || `HTTP ${res.status}`);
    feedbackEl.textContent = `✅ ${r.message}`;
    feedbackEl.style.color = 'var(--color-healthy)';
  } catch (err) {
    feedbackEl.textContent = `❌ ${err.message}`;
    feedbackEl.style.color = 'var(--color-critical)';
  }
}

/**
 * Listening port
 */
async function applyPort() {
  const feedback = document.getElementById('portFeedback');
  const port = parseInt(document.getElementById('cfgServerPort').value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    feedback.textContent = '❌ Enter a port between 1 and 65535.';
    feedback.style.color = 'var(--color-critical)';
    return;
  }
  if (String(port) === (location.port || (location.protocol === 'https:' ? '443' : '80'))) {
    feedback.textContent = 'Already using this port.';
    feedback.style.color = 'var(--text-secondary)';
    return;
  }
  if (!confirm(`Move the monitor to port ${port}? The dashboard will reload at the new address. ` +
    'Remember to update the FortiGate webhook URL if you use it.')) return;
  feedback.textContent = 'Switching port...';
  try {
    const res = await fetch('/api/server/port', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port })
    });
    const r = await res.json();
    if (!res.ok || !r.success) throw new Error(r.error || `HTTP ${res.status}`);
    feedback.textContent = `✅ Now listening on port ${r.port}. ${r.firewall || ''} Redirecting...`;
    feedback.style.color = 'var(--color-healthy)';
    const target = new URL(window.location.href);
    target.port = String(r.port);
    setTimeout(() => { window.location.href = target.toString(); }, 2500);
  } catch (err) {
    feedback.textContent = `❌ ${err.message}`;
    feedback.style.color = 'var(--color-critical)';
  }
}

document.addEventListener('DOMContentLoaded', init);
