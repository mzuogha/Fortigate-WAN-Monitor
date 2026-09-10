/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Link state evaluation (with hysteresis) and multi-channel alert dispatcher
 *
 * Link levels (worst last): HEALTHY < WARNING < CRITICAL < DOWN
 *  - A link must be bad for `consecutiveFailsToAlert` polls before it is confirmed bad,
 *    and good for `consecutiveHealthyToRecover` polls before it is confirmed recovered.
 *  - Escalations (e.g. WARNING -> DOWN) and recoveries are notified; quiet de-escalations
 *    (e.g. DOWN -> WARNING) are shown on the dashboard only.
 *  - Every notification includes the state of the other link, so you know at a glance
 *    whether you are on a single link or have lost internet completely.
 *  - Notifications that cannot be delivered (typically because both WAN links are down)
 *    are queued and retried, then delivered marked as delayed.
 */

const { execFile } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');

const SmtpClient = require('./smtp-client');
const WhatsAppClient = require('./whatsapp-client');

const LEVELS = ['HEALTHY', 'WARNING', 'CRITICAL', 'DOWN'];
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
const ICON = { HEALTHY: '✅', WARNING: '⚠️', CRITICAL: '🔴', DOWN: '⛔', RECOVERED: '✅', INFO: 'ℹ️', REPORT: '📊' };
const EXTERNAL_CHANNELS = ['email', 'whatsapp', 'telegram', 'discord', 'slack', 'teams'];

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMetric(v, unit, digits = 1) {
  return v === null || v === undefined || Number.isNaN(v) ? 'n/a' : `${Number(v).toFixed(digits)}${unit}`;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function metricsLine(sample) {
  if (!sample) return '';
  return `Latency ${fmtMetric(sample.latency, ' ms')} | Loss ${fmtMetric(sample.packetLoss, '%')} | ` +
    `Jitter ${fmtMetric(sample.jitter, ' ms')}`;
}

function newLinkState() {
  return {
    status: 'HEALTHY',
    confirmed: false,       // false until the first real sample arrives
    since: Date.now(),
    worseStreak: 0,
    worseMin: null,         // least-severe level seen in the current bad streak
    betterStreak: 0,
    betterMax: null,        // most-severe level seen in the current good streak
    flaps: [],
    activeIncidentId: null,
    lastNotified: 0,
    lastSample: null,
    lastIssues: []
  };
}

class AlertManager {
  constructor({ config, db, eventEmitter }) {
    this.config = config;
    this.db = db;
    this.eventEmitter = eventEmitter;

    this.smtpClient = new SmtpClient(config.notifications?.email || {});
    this.whatsAppClient = new WhatsAppClient(config.notifications?.whatsapp || {});

    this.states = { wan1: newLinkState(), wan2: newLinkState() };
    this.queue = [];
  }

  updateConfig(newConfig) {
    if (newConfig.thresholds) {
      this.config.thresholds = { ...this.config.thresholds, ...newConfig.thresholds };
    }
    if (newConfig.fortigate) {
      this.config.fortigate = { ...this.config.fortigate, ...newConfig.fortigate };
    }
    if (newConfig.notifications) {
      this.config.notifications = { ...this.config.notifications, ...newConfig.notifications };
      if (newConfig.notifications.email) this.smtpClient.updateConfig(newConfig.notifications.email);
      if (newConfig.notifications.whatsapp) this.whatsAppClient.updateConfig(newConfig.notifications.whatsapp);
    }
  }

  // ------------------------------------------------------------------ naming helpers
  linkLabel(linkId) {
    const fg = this.config.fortigate || {};
    const label = fg[`${linkId}Label`] || linkId.toUpperCase();
    const ifName = fg[`${linkId}Interface`];
    return ifName && ifName !== label ? `${label} (${ifName})` : label;
  }

  siteName() {
    return this.config.siteName || this.config.fortigate?.siteName || 'FortiGate';
  }

  // ------------------------------------------------------------------ evaluation
  classify(sample) {
    const th = this.config.thresholds;
    const issues = [];

    if (sample.status === 'down') {
      issues.push(sample.carrierDown
        ? 'Interface is physically down (cable / ONT / radio / modem)'
        : 'Health-check probes failing: interface is up but the ISP is not passing traffic');
      return { level: 'DOWN', issues };
    }

    let level = 'HEALTHY';
    const raise = (l) => { if (RANK[l] > RANK[level]) level = l; };
    const check = (value, warn, crit, label, unit) => {
      if (value === null || value === undefined) return;
      if (value >= crit) {
        raise('CRITICAL');
        issues.push(`${label}: ${value}${unit} (critical >= ${crit}${unit})`);
      } else if (value >= warn) {
        raise('WARNING');
        issues.push(`${label}: ${value}${unit} (warning >= ${warn}${unit})`);
      }
    };
    check(sample.packetLoss, th.packetLossWarning, th.packetLossCritical, 'Packet loss', '%');
    check(sample.latency, th.latencyWarningMs, th.latencyCriticalMs, 'Latency', ' ms');
    check(sample.jitter, th.jitterWarningMs, th.jitterCriticalMs, 'Jitter', ' ms');
    return { level, issues };
  }

  /**
   * Evaluate one sample for a link. Samples with status 'unknown' do not change state.
   */
  evaluateMetric(linkId, sample) {
    if (!this.states[linkId]) this.states[linkId] = newLinkState();
    const state = this.states[linkId];
    const th = this.config.thresholds;
    const now = Date.now();

    if (!sample || sample.status === 'unknown') {
      return this.result(linkId, [sample?.reason || 'No data']);
    }

    const { level, issues } = this.classify(sample);
    state.lastSample = sample;
    state.lastIssues = issues;

    // Track incident peaks while an incident is open
    if (state.activeIncidentId && level !== 'HEALTHY') {
      this.db.updateIncidentPeak(state.activeIncidentId, sample.latency ?? 0, sample.packetLoss ?? 0);
    }

    // First real sample: adopt it immediately if healthy, otherwise go through hysteresis
    if (!state.confirmed && level === 'HEALTHY') {
      state.confirmed = true;
      state.since = now;
      return this.result(linkId, issues);
    }
    state.confirmed = true;

    if (RANK[level] > RANK[state.status]) {
      state.worseStreak += 1;
      state.betterStreak = 0;
      state.betterMax = null;
      state.worseMin = state.worseMin === null || RANK[level] < RANK[state.worseMin] ? level : state.worseMin;
      if (state.worseStreak >= Math.max(1, th.consecutiveFailsToAlert)) {
        this.transition(linkId, state.worseMin, sample, issues, 'escalate');
      }
    } else if (RANK[level] < RANK[state.status]) {
      state.betterStreak += 1;
      state.worseStreak = 0;
      state.worseMin = null;
      state.betterMax = state.betterMax === null || RANK[level] > RANK[state.betterMax] ? level : state.betterMax;
      if (state.betterStreak >= Math.max(1, th.consecutiveHealthyToRecover)) {
        this.transition(linkId, state.betterMax, sample, issues, state.betterMax === 'HEALTHY' ? 'recover' : 'deescalate');
      }
    } else {
      state.worseStreak = 0;
      state.worseMin = null;
      state.betterStreak = 0;
      state.betterMax = null;
    }

    return this.result(linkId, issues);
  }

  result(linkId, issues) {
    const s = this.states[linkId];
    return {
      linkId,
      status: s.status,
      since: s.since,
      consecutiveFails: s.worseStreak,
      consecutiveHealthy: s.betterStreak,
      issues
    };
  }

  transition(linkId, newLevel, sample, issues, kind) {
    const state = this.states[linkId];
    const th = this.config.thresholds;
    const now = Date.now();
    const prevStatus = state.status;
    const prevSince = state.since;

    state.status = newLevel;
    state.since = now;
    state.worseStreak = 0;
    state.worseMin = null;
    state.betterStreak = 0;
    state.betterMax = null;

    state.flaps = state.flaps.filter(t => t >= now - th.flapWindowSeconds * 1000);
    state.flaps.push(now);
    const flapping = state.flaps.length >= th.flapThresholdCount;

    const label = this.linkLabel(linkId);
    const wasFor = `was ${prevStatus} for ${fmtDuration(now - prevSince)}`;

    if (kind === 'recover') {
      if (state.activeIncidentId || this.db.getActiveIncident(linkId)) this.db.resolveIncident(linkId);
      state.activeIncidentId = null;
      state.lastNotified = now;
      this.sendAlert({
        type: 'RECOVERY',
        linkId,
        prevStatus,
        severity: 'RECOVERED',
        title: `${label} recovered`,
        message: `${label} is healthy again; it ${wasFor}. ${metricsLine(sample)}.`,
        sample
      });
      return;
    }

    const reason = issues.join(' | ') + (flapping
      ? ` | Link is flapping (${state.flaps.length} state changes in ${Math.round(th.flapWindowSeconds / 60)} min)`
      : '');

    if (!state.activeIncidentId) {
      state.activeIncidentId = this.db.createIncident({
        linkId,
        severity: newLevel,
        triggerReason: reason,
        peakLatency: sample.latency ?? 0,
        peakLoss: sample.packetLoss ?? 0
      });
    } else {
      this.db.updateIncidentSeverity(state.activeIncidentId, newLevel);
    }

    if (kind === 'deescalate') {
      // Improving but not yet healthy: show on the dashboard, no external notification
      this.emit({ type: 'DEESCALATION', linkId, severity: newLevel, title: `${label} improving: now ${newLevel}`,
        message: `${label} improved from ${prevStatus} to ${newLevel}. ${metricsLine(sample)}.`, sample, localOnly: true });
      return;
    }

    state.lastNotified = now;
    const allDown = Object.values(this.states).every(s => s.status === 'DOWN');
    const verb = newLevel === 'DOWN' ? 'is DOWN' : `is degraded (${newLevel})`;
    this.sendAlert({
      type: newLevel === 'DOWN' ? 'LINK_DOWN' : `${newLevel}_DEGRADATION`,
      linkId,
      prevStatus,
      severity: newLevel === 'WARNING' ? 'WARNING' : 'CRITICAL',
      level: newLevel,
      title: allDown ? 'TOTAL OUTAGE: all WAN links are down' : `${label} ${verb}`,
      message: `${label} ${verb}; it ${wasFor}. Reason: ${reason}.`,
      sample,
      issues
    });
  }

  /**
   * Re-notify for links that stay degraded/down. Call once per poll cycle.
   */
  checkReminders() {
    const minutes = Number(this.config.thresholds.reminderMinutes) || 0;
    if (minutes <= 0) return;
    const now = Date.now();
    for (const [linkId, s] of Object.entries(this.states)) {
      if (s.status === 'HEALTHY' || now - s.lastNotified < minutes * 60000) continue;
      s.lastNotified = now;
      const label = this.linkLabel(linkId);
      this.sendAlert({
        type: 'REMINDER',
        linkId,
        severity: s.status === 'WARNING' ? 'WARNING' : 'CRITICAL',
        level: s.status,
        title: `Still ${s.status}: ${label} (${fmtDuration(now - s.since)})`,
        message: `${label} has been ${s.status} since ${new Date(s.since).toLocaleString()}. ` +
          `Latest: ${s.lastIssues.join(' | ') || metricsLine(s.lastSample)}.`,
        sample: s.lastSample
      });
    }
  }

  /** Forget all link states (used when switching between simulation and real monitoring). */
  resetStates() {
    this.states = { wan1: newLinkState(), wan2: newLinkState() };
  }

  /**
   * On restart any incident left open by a previous run is closed, so the incident log
   * does not show phantom "ongoing" incidents.
   */
  closeStaleIncidents() {
    for (const linkId of Object.keys(this.states)) {
      if (this.db.getActiveIncident(linkId)) this.db.resolveIncident(linkId);
    }
  }

  overview() {
    const now = Date.now();
    const lines = Object.entries(this.states).map(([linkId, s]) => {
      const detail = !s.confirmed ? 'no data yet'
        : s.status === 'DOWN' ? (s.lastIssues[0] || 'down')
          : metricsLine(s.lastSample);
      return `${ICON[s.status] || ''} ${this.linkLabel(linkId)}: ${s.confirmed ? s.status : 'UNKNOWN'} for ` +
        `${fmtDuration(now - s.since)} - ${detail}`;
    });
    const states = Object.entries(this.states);
    const down = states.filter(([, s]) => s.status === 'DOWN');
    const healthy = states.filter(([, s]) => s.status === 'HEALTHY' && s.confirmed);
    let impact = '';
    if (down.length === states.length) impact = 'IMPACT: ALL WAN LINKS DOWN - the site has no internet access.';
    else if (down.length && healthy.length === 1) impact = `IMPACT: running on a single link (${this.linkLabel(healthy[0][0])}). No redundancy left.`;
    else if (down.length && !healthy.length) impact = 'IMPACT: the remaining link is degraded - expect poor performance.';
    return { lines, impact, text: lines.join('\n') + (impact ? `\n\n${impact}` : '') };
  }

  // ------------------------------------------------------------------ dispatch
  emit(alert) {
    if (this.eventEmitter) this.eventEmitter.emit('alert', alert);
  }

  enabledChannels() {
    const n = this.config.notifications || {};
    const on = [];
    if (n.email?.enabled && n.email.host && n.email.to) on.push('email');
    if (n.whatsapp?.enabled) on.push('whatsapp');
    if (n.telegram?.enabled && n.telegram.botToken && n.telegram.chatId) on.push('telegram');
    if (n.discord?.enabled && n.discord.webhookUrl) on.push('discord');
    if (n.slack?.enabled && n.slack.webhookUrl) on.push('slack');
    if (n.teams?.enabled && n.teams.webhookUrl) on.push('teams');
    return on;
  }

  /**
   * Broadcast to the dashboard and all enabled channels.
   */
  sendAlert(alert) {
    const full = {
      timestamp: Date.now(),
      site: this.siteName(),
      ...alert
    };
    if (this.config.simulation?.enabled && !full.test) {
      full.simulated = true;
      full.title = `[SIMULATION] ${full.title}`;
    }
    if (!full.overview && full.linkId && full.linkId !== 'system') {
      full.overview = this.overview().text;
    }

    this.emit(full);
    console.log(`[ALERT] [${full.severity}] ${full.title}: ${full.message}`);

    if (this.config.notifications?.windowsToast?.enabled && !full.noToast) {
      this.sendWindowsToast(full.title, full.message).catch(err => console.error(`[Windows Toast Error]: ${err.message}`));
    }

    const channels = this.enabledChannels();
    if (channels.length) {
      this.queue.push({ alert: full, pending: new Set(channels), created: Date.now(), attempts: 0 });
      const max = this.config.notifications?.retry?.maxQueue || 200;
      if (this.queue.length > max) this.queue.splice(0, this.queue.length - max);
      return this.flushQueue();
    }
    return Promise.resolve();
  }

  /**
   * Try to deliver everything queued. Called after each alert and periodically.
   */
  async flushQueue() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const maxAge = (this.config.notifications?.retry?.maxAgeHours || 24) * 3600000;
      for (const item of [...this.queue]) {
        const age = Date.now() - item.created;
        if (age > maxAge) {
          console.error(`[Alert Queue] Dropping undeliverable alert after ${fmtDuration(age)}: ${item.alert.title}`);
          this.queue.splice(this.queue.indexOf(item), 1);
          continue;
        }
        const alert = age > 90000 ? {
          ...item.alert,
          delayedNote: `Delayed alert: raised ${new Date(item.created).toLocaleString()} (${fmtDuration(age)} ago). ` +
            'It could not be sent earlier, most likely because internet access was down.'
        } : item.alert;
        item.attempts += 1;
        for (const ch of [...item.pending]) {
          try {
            await this.sendToChannel(ch, alert);
            item.pending.delete(ch);
          } catch (err) {
            console.error(`[${ch} Alert Error] (attempt ${item.attempts}, will retry): ${err.message}`);
          }
        }
        if (!item.pending.size) this.queue.splice(this.queue.indexOf(item), 1);
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  sendToChannel(channel, alert, overrides = null) {
    const n = { ...(this.config.notifications || {}), ...(overrides || {}) };
    switch (channel) {
      case 'email': {
        const client = overrides?.email ? new SmtpClient({ ...this.config.notifications.email, ...overrides.email }) : this.smtpClient;
        return this.sendEmailAlert(alert, client);
      }
      case 'whatsapp': {
        const client = overrides?.whatsapp ? new WhatsAppClient({ ...this.config.notifications.whatsapp, ...overrides.whatsapp }) : this.whatsAppClient;
        return client.sendMessage(this.formatPlain(alert, { whatsapp: true }));
      }
      case 'telegram': return this.sendTelegramAlert(n.telegram, alert);
      case 'discord': return this.sendDiscordAlert(n.discord.webhookUrl, alert);
      case 'slack': return this.sendSlackAlert(n.slack.webhookUrl, alert);
      case 'teams': return this.sendTeamsAlert(n.teams.webhookUrl, alert);
      case 'windowsToast': return this.sendWindowsToast(alert.title, alert.message, { strict: true });
      default: return Promise.reject(new Error(`Unknown channel: ${channel}`));
    }
  }

  // ------------------------------------------------------------------ formatting
  icon(alert) {
    return ICON[alert.level] || ICON[alert.severity] || '🔔';
  }

  formatPlain(alert, { whatsapp = false } = {}) {
    const b = (s) => (whatsapp ? `*${s}*` : s);
    const lines = [];
    if (alert.delayedNote) lines.push(`[${alert.delayedNote}]`, '');
    lines.push(`${this.icon(alert)} ${b(alert.title)}`, '');
    lines.push(`${b('Site:')} ${alert.site || this.siteName()}`);
    lines.push(`${b('Time:')} ${new Date(alert.timestamp || Date.now()).toLocaleString()}`);
    lines.push(`${b('Details:')} ${alert.message}`);
    if (alert.overview) lines.push('', b('All links:'), alert.overview);
    return lines.join('\n');
  }

  /**
   * Send a daily report through every enabled channel (same queue/retry as alerts).
   * Email gets the full HTML report; chat channels get the text summary.
   */
  sendDailyReport(report, { html, text }) {
    return this.sendAlert({
      type: 'DAILY_REPORT',
      linkId: 'system',
      severity: 'INFO',
      level: 'REPORT',
      title: `Daily WAN report for ${report.date}`,
      message: text,
      reportHtml: html,
      noToast: true
    });
  }

  async sendEmailAlert(alert, client = this.smtpClient) {
    if (alert.reportHtml) {
      return client.sendMail({ subject: `[WAN Monitor] ${alert.title}`, html: alert.reportHtml, text: this.formatPlain(alert) });
    }
    const isRec = alert.severity === 'RECOVERED';
    const isCrit = alert.severity === 'CRITICAL';
    const color = isCrit ? '#dc2626' : isRec ? '#059669' : alert.severity === 'WARNING' ? '#d97706' : '#2563eb';
    const row = (k, v) => `<tr><td style="padding:6px 0;color:#64748b;width:130px;vertical-align:top;">${k}</td>` +
      `<td style="padding:6px 0;">${v}</td></tr>`;
    const html = `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
  <div style="background:${color};color:#fff;padding:16px 22px;">
    <div style="font-size:12px;opacity:.9;">FortiGate WAN Monitor &middot; ${escapeHtml(alert.site || this.siteName())}</div>
    <div style="font-size:18px;font-weight:bold;margin-top:4px;">${escapeHtml(alert.title)}</div>
  </div>
  <div style="padding:20px 22px;color:#1e293b;font-size:14px;">
    ${alert.delayedNote ? `<p style="background:#fef3c7;padding:8px 10px;border-radius:4px;">${escapeHtml(alert.delayedNote)}</p>` : ''}
    <p style="margin-top:0;">${escapeHtml(alert.message)}</p>
    <table style="width:100%;border-collapse:collapse;">
      ${alert.sample ? row('Latency', escapeHtml(fmtMetric(alert.sample.latency, ' ms'))) +
        row('Packet loss', escapeHtml(fmtMetric(alert.sample.packetLoss, '%'))) +
        row('Jitter', escapeHtml(fmtMetric(alert.sample.jitter, ' ms'))) : ''}
      ${row('Time', escapeHtml(new Date(alert.timestamp || Date.now()).toLocaleString()))}
    </table>
    ${alert.overview ? `<h4 style="margin:18px 0 6px;">All links</h4><pre style="background:#f8fafc;padding:10px;border-radius:4px;white-space:pre-wrap;font-size:13px;">${escapeHtml(alert.overview)}</pre>` : ''}
  </div>
</div>`;
    return client.sendMail({ subject: `[WAN Monitor] ${alert.title}`, html, text: this.formatPlain(alert) });
  }

  async sendWhatsAppAlert(alert) {
    return this.whatsAppClient.sendMessage(this.formatPlain(alert, { whatsapp: true }));
  }

  /**
   * Windows toast via PowerShell. Title and message are passed through environment
   * variables, never interpolated into the script, so alert text cannot inject commands.
   */
  sendWindowsToast(title, message, { strict = false } = {}) {
    if (process.platform !== 'win32') {
      return strict ? Promise.reject(new Error('Windows toast notifications are only available on Windows')) : Promise.resolve();
    }
    const psScript = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$xml = [xml]$template.GetXml()',
      '$xml.GetElementsByTagName("text")[0].AppendChild($xml.CreateTextNode($env:WANMON_TOAST_TITLE)) > $null',
      '$xml.GetElementsByTagName("text")[1].AppendChild($xml.CreateTextNode($env:WANMON_TOAST_MESSAGE)) > $null',
      '$toastXml = New-Object Windows.Data.Xml.Dom.XmlDocument',
      '$toastXml.LoadXml($xml.OuterXml)',
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("FortiGate WAN Monitor").Show($toast)'
    ].join('\n');

    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
        timeout: 8000,
        windowsHide: true,
        env: { ...process.env, WANMON_TOAST_TITLE: String(title).slice(0, 200), WANMON_TOAST_MESSAGE: String(message).slice(0, 500) }
      }, (err) => {
        if (err && strict) return reject(err);
        if (err) console.warn(`Windows Toast notice: ${err.message}`);
        resolve();
      });
    });
  }

  async sendTelegramAlert(teleConfig, alert) {
    if (!teleConfig?.botToken || !teleConfig?.chatId) throw new Error('Telegram bot token and chat ID are required');
    const lines = [];
    if (alert.delayedNote) lines.push(`<i>${escapeHtml(alert.delayedNote)}</i>`, '');
    lines.push(`${this.icon(alert)} <b>${escapeHtml(alert.title)}</b>`, '');
    lines.push(`<b>Site:</b> ${escapeHtml(alert.site || this.siteName())}`);
    lines.push(`<b>Time:</b> ${escapeHtml(new Date(alert.timestamp || Date.now()).toLocaleString())}`);
    lines.push(escapeHtml(alert.message));
    if (alert.overview) lines.push('', '<b>All links:</b>', `<pre>${escapeHtml(alert.overview)}</pre>`);
    const payload = JSON.stringify({
      chat_id: teleConfig.chatId,
      text: lines.join('\n').slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return this.postJson(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, payload);
  }

  async sendDiscordAlert(webhookUrl, alert) {
    const color = alert.severity === 'CRITICAL' ? 0xDC2626 : alert.severity === 'WARNING' ? 0xD97706 : 0x059669;
    const fields = [];
    if (alert.sample) {
      fields.push(
        { name: 'Latency', value: fmtMetric(alert.sample.latency, ' ms'), inline: true },
        { name: 'Packet Loss', value: fmtMetric(alert.sample.packetLoss, '%'), inline: true },
        { name: 'Jitter', value: fmtMetric(alert.sample.jitter, ' ms'), inline: true }
      );
    }
    if (alert.overview) fields.push({ name: 'All links', value: alert.overview.slice(0, 1000) });
    const payload = JSON.stringify({
      embeds: [{
        title: `${this.icon(alert)} ${alert.title}`.slice(0, 250),
        description: ((alert.delayedNote ? `*${alert.delayedNote}*\n\n` : '') + alert.message).slice(0, 4000),
        color,
        fields,
        footer: { text: `FortiGate WAN Monitor - ${alert.site || this.siteName()}` },
        timestamp: new Date(alert.timestamp || Date.now()).toISOString()
      }],
      allowed_mentions: { parse: [] }
    });
    return this.postJson(webhookUrl, payload);
  }

  async sendSlackAlert(webhookUrl, alert) {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = (alert.delayedNote ? `_${esc(alert.delayedNote)}_\n` : '') +
      `${this.icon(alert)} *${esc(alert.title)}*\n${esc(alert.message)}` +
      (alert.overview ? `\n\`\`\`${esc(alert.overview)}\`\`\`` : '');
    return this.postJson(webhookUrl, JSON.stringify({ text }));
  }

  async sendTeamsAlert(webhookUrl, alert) {
    const body = [
      { type: 'TextBlock', text: `${this.icon(alert)} ${alert.title}`, weight: 'Bolder', size: 'Medium', wrap: true },
      { type: 'TextBlock', text: `${alert.site || this.siteName()} · ${new Date(alert.timestamp || Date.now()).toLocaleString()}`, isSubtle: true, spacing: 'None', wrap: true }
    ];
    if (alert.delayedNote) body.push({ type: 'TextBlock', text: alert.delayedNote, color: 'Warning', wrap: true });
    body.push({ type: 'TextBlock', text: alert.message, wrap: true });
    if (alert.overview) {
      body.push({ type: 'TextBlock', text: 'All links', weight: 'Bolder', spacing: 'Medium' });
      for (const line of alert.overview.split('\n').filter(Boolean)) {
        body.push({ type: 'TextBlock', text: line, wrap: true, spacing: 'Small' });
      }
    }
    const payload = JSON.stringify({
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body }
      }]
    });
    return this.postJson(webhookUrl, payload);
  }

  postJson(urlStr, data) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(urlStr);
      } catch {
        return reject(new Error('Invalid webhook URL'));
      }
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 10000
      }, (res) => {
        let body = '';
        res.on('data', (c) => { if (body.length < 500) body += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Webhook returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error('Webhook request timed out')));
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

AlertManager.LEVELS = LEVELS;
AlertManager.EXTERNAL_CHANNELS = EXTERNAL_CHANNELS;
AlertManager.escapeHtml = escapeHtml;
AlertManager.fmtDuration = fmtDuration;

module.exports = AlertManager;
