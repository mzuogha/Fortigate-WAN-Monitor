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
  tuningGuideModal: document.getElementById('tuningGuideModal'),
  btnOpenTuningGuide: document.getElementById('btnOpenTuningGuide'),
  btnCloseTuningGuide: document.getElementById('btnCloseTuningGuide'),
  btnDismissTuning: document.getElementById('btnDismissTuning'),

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

  if (isSimulating !== undefined) {
    el.chkSimulationToggle.checked = isSimulating;
    el.simModeBadge.textContent = isSimulating ? 'SIMULATOR ACTIVE' : 'REAL FORTIGATE';
    el.simModeBadge.style.background = isSimulating ? '#f59e0b' : '#10b981';
  }

  if (fortigateStatus) {
    if (fortigateStatus.connected) {
      el.fgStatusBadge.className = 'badge fg-status active';
      el.fgStatusText.textContent = `FortiGate: Online (${fortigateStatus.hostname || 'Active'})`;
    } else if (isSimulating) {
      el.fgStatusBadge.className = 'badge fg-status';
      el.fgStatusText.textContent = 'FortiGate: Simulating';
    } else {
      el.fgStatusBadge.className = 'badge fg-status error';
      el.fgStatusText.textContent = 'FortiGate: Disconnected';
    }
  }

  if (wan1) updateLinkCard('wan1', wan1);
  if (wan2) updateLinkCard('wan2', wan2);

  if (timestamp) {
    if (wan1) {
      telemetryHistory.push({
        timestamp,
        link_id: 'wan1',
        latency: wan1.latency,
        packet_loss: wan1.packetLoss,
        jitter: wan1.jitter,
        status: wan1.status
      });
    }
    if (wan2) {
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

  const status = (link.status || 'HEALTHY').toUpperCase();

  card.classList.remove('status-warning', 'status-critical');
  pill.classList.remove('status-healthy', 'status-warning', 'status-critical');

  if (status === 'CRITICAL' || status === 'DOWN') {
    card.classList.add('status-critical');
    pill.classList.add('status-critical');
    statusText.textContent = link.linkState === 'down' ? 'DOWN' : 'CRITICAL';
  } else if (status === 'WARNING' || status === 'DEGRADED') {
    card.classList.add('status-warning');
    pill.classList.add('status-warning');
    statusText.textContent = 'DEGRADED';
  } else {
    pill.classList.add('status-healthy');
    statusText.textContent = 'HEALTHY';
  }

  latency.textContent = link.status === 'down' ? 'DOWN' : `${link.latency.toFixed(1)} ms`;
  loss.textContent = `${link.packetLoss.toFixed(1)} %`;
  jitter.textContent = `${link.jitter.toFixed(1)} ms`;

  if (link.packetLoss >= thresholds.packetLossCritical) {
    loss.style.color = 'var(--color-critical)';
  } else if (link.packetLoss >= thresholds.packetLossWarning) {
    loss.style.color = 'var(--color-warning)';
  } else {
    loss.style.color = 'var(--text-primary)';
  }

  if (link.latency >= thresholds.latencyCriticalMs) {
    latency.style.color = 'var(--color-critical)';
  } else if (link.latency >= thresholds.latencyWarningMs) {
    latency.style.color = 'var(--color-warning)';
  } else {
    latency.style.color = 'var(--text-primary)';
  }

  const rxMb = ((link.rxKbps || 0) / 1024).toFixed(1);
  const txMb = ((link.txKbps || 0) / 1024).toFixed(1);
  bandwidth.textContent = `${rxMb} / ${txMb} Mb/s`;

  if (link.linkState === 'down') {
    carrier.className = 'carrier-badge carrier-down';
    carrier.textContent = 'CARRIER DOWN';
  } else {
    carrier.className = 'carrier-badge carrier-up';
    carrier.textContent = 'CARRIER UP';
  }

  if (link.issues && link.issues.length > 0) {
    issuesBox.classList.remove('hidden', 'warning-mode');
    if (status === 'WARNING') issuesBox.classList.add('warning-mode');
    issuesBox.innerHTML = `<strong>⚠️ Issues Detected:</strong>${link.issues.map(i => `<div>• ${i}</div>`).join('')}`;
  } else {
    issuesBox.classList.add('hidden');
    issuesBox.innerHTML = '';
  }

  lastSync.textContent = `Updated: ${new Date(link.lastUpdate || Date.now()).toLocaleTimeString()}`;
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
  } else if (alert.severity === 'WARNING') {
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

    const severityClass = inc.severity === 'CRITICAL' ? 'status-critical' : 'status-warning';

    return `
      <tr>
        <td>${startDate.toLocaleDateString()} ${startDate.toLocaleTimeString()}</td>
        <td><strong>${inc.link_id.toUpperCase()}</strong></td>
        <td><span class="status-pill ${severityClass}" style="padding:2px 8px; font-size:0.7rem;">${inc.severity}</span></td>
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
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  const drawLine = (data, strokeColor, fillColor) => {
    if (!data || data.length === 0) return;

    ctx.save();
    ctx.beginPath();

    const points = [];
    for (const d of data) {
      const x = padding.left + ((d.timestamp - startTime) / (now - startTime)) * graphW;
      const y = padding.top + graphH - (Math.min(d[opts.valueKey], maxVal) / maxVal) * graphH;
      points.push({ x, y });
    }

    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }

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

  el.btnOpenTuningGuide.addEventListener('click', () => {
    el.tuningGuideModal.classList.remove('hidden');
  });
  el.btnCloseTuningGuide.addEventListener('click', () => {
    el.tuningGuideModal.classList.add('hidden');
  });
  el.btnDismissTuning.addEventListener('click', () => {
    el.tuningGuideModal.classList.add('hidden');
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

    // Thresholds
    document.getElementById('thLossWarn').value = cfg.thresholds?.packetLossWarning ?? 2.0;
    document.getElementById('thLossCrit').value = cfg.thresholds?.packetLossCritical ?? 8.0;
    document.getElementById('thLatWarn').value = cfg.thresholds?.latencyWarningMs ?? 120;
    document.getElementById('thLatCrit').value = cfg.thresholds?.latencyCriticalMs ?? 250;
    document.getElementById('thJitWarn').value = cfg.thresholds?.jitterWarningMs ?? 25;
    document.getElementById('thJitCrit').value = cfg.thresholds?.jitterCriticalMs ?? 50;
    document.getElementById('thConsecFails').value = cfg.thresholds?.consecutiveFailsToAlert ?? 2;
    document.getElementById('thConsecRecovery').value = cfg.thresholds?.consecutiveHealthyToRecover ?? 4;

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
      healthCheckName: document.getElementById('cfgFgHealthCheck').value
    },
    thresholds: {
      packetLossWarning: parseFloat(document.getElementById('thLossWarn').value),
      packetLossCritical: parseFloat(document.getElementById('thLossCrit').value),
      latencyWarningMs: parseFloat(document.getElementById('thLatWarn').value),
      latencyCriticalMs: parseFloat(document.getElementById('thLatCrit').value),
      jitterWarningMs: parseFloat(document.getElementById('thJitWarn').value),
      jitterCriticalMs: parseFloat(document.getElementById('thJitCrit').value),
      consecutiveFailsToAlert: parseInt(document.getElementById('thConsecFails').value, 10),
      consecutiveHealthyToRecover: parseInt(document.getElementById('thConsecRecovery').value, 10)
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
      }
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
        apiToken: document.getElementById('cfgFgToken').value
      })
    });
    const result = await res.json();
    if (result.success) {
      el.fgTestResult.textContent = `✅ Connected! Version: ${result.version} (Serial: ${result.serial})`;
      el.fgTestResult.style.color = 'var(--color-healthy)';
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

document.addEventListener('DOMContentLoaded', init);
