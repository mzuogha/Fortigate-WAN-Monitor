/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Alert Manager & Multi-Channel Notification Dispatcher
 */

const { execFile } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');

const SmtpClient = require('./smtp-client');
const WhatsAppClient = require('./whatsapp-client');

class AlertManager {
  constructor({ config, db, eventEmitter }) {
    this.config = config;
    this.db = db;
    this.eventEmitter = eventEmitter;

    // Clients
    this.smtpClient = new SmtpClient(config.notifications?.email || {});
    this.whatsAppClient = new WhatsAppClient(config.notifications?.whatsapp || {});

    // Link state tracking
    this.states = {
      wan1: {
        status: 'HEALTHY',
        lastAlertStatus: 'HEALTHY',
        consecutiveFails: 0,
        consecutiveHealthy: 0,
        lastStateChange: Date.now(),
        flaps: [],
        activeIncidentId: null
      },
      wan2: {
        status: 'HEALTHY',
        lastAlertStatus: 'HEALTHY',
        consecutiveFails: 0,
        consecutiveHealthy: 0,
        lastStateChange: Date.now(),
        flaps: [],
        activeIncidentId: null
      }
    };
  }

  updateConfig(newConfig) {
    if (newConfig.thresholds) {
      this.config.thresholds = { ...this.config.thresholds, ...newConfig.thresholds };
    }
    if (newConfig.notifications) {
      this.config.notifications = { ...this.config.notifications, ...newConfig.notifications };
      if (newConfig.notifications.email) {
        this.smtpClient.updateConfig(newConfig.notifications.email);
      }
      if (newConfig.notifications.whatsapp) {
        this.whatsAppClient.updateConfig(newConfig.notifications.whatsapp);
      }
    }
  }

  /**
   * Evaluates a metric sample for a link against configured thresholds
   */
  evaluateMetric(linkId, sample) {
    if (!this.states[linkId]) {
      this.states[linkId] = {
        status: 'HEALTHY',
        lastAlertStatus: 'HEALTHY',
        consecutiveFails: 0,
        consecutiveHealthy: 0,
        lastStateChange: Date.now(),
        flaps: [],
        activeIncidentId: null
      };
    }

    const state = this.states[linkId];
    const th = this.config.thresholds;
    const now = Date.now();

    // Determine sample severity
    let sampleStatus = 'HEALTHY';
    const issues = [];

    const isDown = sample.status === 'down' || sample.packetLoss >= 100;
    if (isDown) {
      sampleStatus = 'CRITICAL';
      issues.push('Link is DOWN (100% loss / carrier down)');
    } else {
      // Check Packet Loss
      if (sample.packetLoss >= th.packetLossCritical) {
        sampleStatus = 'CRITICAL';
        issues.push(`Packet Loss: ${sample.packetLoss}% (Critical > ${th.packetLossCritical}%)`);
      } else if (sample.packetLoss >= th.packetLossWarning) {
        sampleStatus = 'WARNING';
        issues.push(`Packet Loss: ${sample.packetLoss}% (Warning > ${th.packetLossWarning}%)`);
      }

      // Check Latency
      if (sample.latency >= th.latencyCriticalMs) {
        sampleStatus = 'CRITICAL';
        issues.push(`Latency: ${sample.latency}ms (Critical > ${th.latencyCriticalMs}ms)`);
      } else if (sample.latency >= th.latencyWarningMs) {
        if (sampleStatus !== 'CRITICAL') sampleStatus = 'WARNING';
        issues.push(`Latency: ${sample.latency}ms (Warning > ${th.latencyWarningMs}ms)`);
      }

      // Check Jitter
      if (sample.jitter >= th.jitterCriticalMs) {
        sampleStatus = 'CRITICAL';
        issues.push(`Jitter: ${sample.jitter}ms (Critical > ${th.jitterCriticalMs}ms)`);
      } else if (sample.jitter >= th.jitterWarningMs) {
        if (sampleStatus !== 'CRITICAL') sampleStatus = 'WARNING';
        issues.push(`Jitter: ${sample.jitter}ms (Warning > ${th.jitterWarningMs}ms)`);
      }
    }

    // Flapping detection
    const flapCutoff = now - (th.flapWindowSeconds * 1000);
    state.flaps = state.flaps.filter(t => t >= flapCutoff);

    // Transition Logic with Hysteresis
    if (sampleStatus === 'HEALTHY') {
      state.consecutiveHealthy++;
      state.consecutiveFails = 0;

      if (state.status !== 'HEALTHY' && state.consecutiveHealthy >= th.consecutiveHealthyToRecover) {
        // Link has recovered!
        const prevStatus = state.status;
        state.status = 'HEALTHY';
        state.lastStateChange = now;
        state.flaps.push(now);

        // Resolve active incident in DB
        this.db.resolveIncident(linkId);
        state.activeIncidentId = null;

        // Dispatch Recovery Alert
        this.sendAlert({
          type: 'RECOVERY',
          linkId,
          prevStatus,
          severity: 'RECOVERED',
          title: `[RECOVERED] ${linkId.toUpperCase()} is Healthy`,
          message: `${linkId.toUpperCase()} has stabilized. Latency: ${sample.latency}ms, Loss: ${sample.packetLoss}%, Jitter: ${sample.jitter}ms.`,
          sample
        });

        state.lastAlertStatus = 'HEALTHY';
      }
    } else {
      // Degraded or Down
      state.consecutiveFails++;
      state.consecutiveHealthy = 0;

      if (state.consecutiveFails >= th.consecutiveFailsToAlert) {
        const severityChanged = state.lastAlertStatus !== sampleStatus;
        if (state.status !== sampleStatus || severityChanged) {
          state.status = sampleStatus;
          state.lastStateChange = now;
          state.flaps.push(now);

          const isFlapping = state.flaps.length >= th.flapThresholdCount;
          if (isFlapping) {
            issues.push(`⚠️ Flapping detected (${state.flaps.length} state changes in ${Math.round(th.flapWindowSeconds / 60)}m)`);
          }

          const triggerReason = issues.join(' | ');

          // Create or update incident
          if (!state.activeIncidentId) {
            state.activeIncidentId = this.db.createIncident({
              linkId,
              severity: sampleStatus,
              triggerReason,
              peakLatency: sample.latency,
              peakLoss: sample.packetLoss
            });
          } else {
            this.db.updateIncidentPeak(state.activeIncidentId, sample.latency, sample.packetLoss);
          }

          // Dispatch Degradation Alert
          this.sendAlert({
            type: sampleStatus === 'CRITICAL' ? 'CRITICAL_DEGRADATION' : 'WARNING_DEGRADATION',
            linkId,
            severity: sampleStatus,
            title: `[${sampleStatus}] ${linkId.toUpperCase()} Service Degradation`,
            message: `${linkId.toUpperCase()} service degraded: ${triggerReason}`,
            sample,
            issues
          });

          state.lastAlertStatus = sampleStatus;
        } else if (state.activeIncidentId) {
          this.db.updateIncidentPeak(state.activeIncidentId, sample.latency, sample.packetLoss);
        }
      }
    }

    return {
      linkId,
      status: state.status,
      consecutiveFails: state.consecutiveFails,
      consecutiveHealthy: state.consecutiveHealthy,
      issues
    };
  }

  /**
   * Broadcasts alert to all enabled notification channels
   */
  async sendAlert(alert) {
    // 1. Emit to EventBus for browser SSE live dashboard
    if (this.eventEmitter) {
      this.eventEmitter.emit('alert', alert);
    }

    console.log(`[ALERT] [${alert.severity}] ${alert.title}: ${alert.message}`);

    const notif = this.config.notifications || {};

    // 2. Windows Native Desktop Toast Notification
    if (notif.windowsToast?.enabled) {
      this.sendWindowsToast(alert.title, alert.message).catch(err => {
        console.error(`[Windows Toast Error]: ${err.message}`);
      });
    }

    // 3. Email Alert (SMTP)
    if (notif.email?.enabled && notif.email.host && notif.email.to) {
      this.sendEmailAlert(alert).catch(err => {
        console.error(`[Email Alert Error]: ${err.message}`);
      });
    }

    // 4. WhatsApp Alert
    if (notif.whatsapp?.enabled) {
      this.sendWhatsAppAlert(alert).catch(err => {
        console.error(`[WhatsApp Alert Error]: ${err.message}`);
      });
    }

    // 5. Telegram Alert
    if (notif.telegram?.enabled && notif.telegram.botToken && notif.telegram.chatId) {
      this.sendTelegramAlert(notif.telegram, alert).catch(err => {
        console.error(`[Telegram Error]: ${err.message}`);
      });
    }

    // 6. Discord Webhook
    if (notif.discord?.enabled && notif.discord.webhookUrl) {
      this.sendDiscordAlert(notif.discord.webhookUrl, alert).catch(err => {
        console.error(`[Discord Error]: ${err.message}`);
      });
    }

    // 7. Slack / Teams Webhook
    if (notif.slack?.enabled && notif.slack.webhookUrl) {
      this.sendSlackAlert(notif.slack.webhookUrl, alert).catch(err => {
        console.error(`[Slack Error]: ${err.message}`);
      });
    }
  }

  /**
   * Email Dispatcher via native SMTP
   */
  async sendEmailAlert(alert) {
    const isCrit = alert.severity === 'CRITICAL';
    const isRec = alert.severity === 'RECOVERED';
    const color = isCrit ? '#ef4444' : (isRec ? '#10b981' : '#f59e0b');
    const badgeBg = isCrit ? '#fee2e2' : (isRec ? '#d1fae5' : '#fef3c7');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <div style="background-color: ${color}; color: white; padding: 18px 24px;">
          <h2 style="margin: 0; font-size: 1.25rem;">FortiGate WAN Alert: ${alert.severity}</h2>
          <p style="margin: 4px 0 0; opacity: 0.9; font-size: 0.9rem;">${alert.title}</p>
        </div>
        <div style="padding: 24px; background-color: #ffffff; color: #1e293b;">
          <p style="font-size: 1rem; line-height: 1.5; margin-top: 0;"><strong>Details:</strong> ${alert.message}</p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 0.9rem;">
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #64748b;">Link Identifier:</td><td style="padding: 8px 0; font-weight: bold;">${alert.linkId.toUpperCase()}</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #64748b;">Severity Level:</td><td style="padding: 8px 0;"><span style="background: ${badgeBg}; color: ${color}; padding: 2px 8px; border-radius: 4px; font-weight: bold;">${alert.severity}</span></td></tr>
            ${alert.sample ? `
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #64748b;">Latency (RTT):</td><td style="padding: 8px 0; font-weight: bold;">${alert.sample.latency} ms</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #64748b;">Packet Loss:</td><td style="padding: 8px 0; font-weight: bold;">${alert.sample.packetLoss} %</td></tr>
            <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px 0; color: #64748b;">Jitter:</td><td style="padding: 8px 0; font-weight: bold;">${alert.sample.jitter} ms</td></tr>
            ` : ''}
            <tr><td style="padding: 8px 0; color: #64748b;">Timestamp:</td><td style="padding: 8px 0;">${new Date().toLocaleString()}</td></tr>
          </table>
          <p style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 0;">Automated notification from FortiGate Dual-WAN Link Monitor & Failover Guard.</p>
        </div>
      </div>
    `;

    const text = `[${alert.severity}] ${alert.title}\n\nDetails: ${alert.message}\nLink: ${alert.linkId.toUpperCase()}\n` +
      (alert.sample ? `Metrics: Latency ${alert.sample.latency}ms | Loss ${alert.sample.packetLoss}% | Jitter ${alert.sample.jitter}ms\n` : '') +
      `Timestamp: ${new Date().toLocaleString()}`;

    return this.smtpClient.sendMail({
      subject: alert.title,
      html,
      text
    });
  }

  /**
   * WhatsApp Dispatcher
   */
  async sendWhatsAppAlert(alert) {
    const icon = alert.severity === 'CRITICAL' ? '🚨' : alert.severity === 'WARNING' ? '⚠️' : '✅';
    const message = `${icon} *${alert.title}*\n\n` +
      `*Link:* ${alert.linkId.toUpperCase()}\n` +
      `*Status:* ${alert.severity}\n` +
      `*Details:* ${alert.message}\n` +
      (alert.sample ? `*Metrics:* ${alert.sample.latency}ms lat | ${alert.sample.packetLoss}% loss | ${alert.sample.jitter}ms jit\n` : '') +
      `*Time:* ${new Date().toLocaleTimeString()}`;

    return this.whatsAppClient.sendMessage(message);
  }

  /**
   * Triggers native Windows Toast Notification using PowerShell WinRT API
   */
  async sendWindowsToast(title, message) {
    const escapedTitle = title.replace(/"/g, '`"');
    const escapedMsg = message.replace(/"/g, '`"');

    const psScript = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
      $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $xml = [xml]$template.GetXml()
      $xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode("${escapedTitle}")) > $null
      $xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode("${escapedMsg}")) > $null
      $toastXml = New-Object Windows.Data.Xml.Dom.XmlDocument
      $toastXml.LoadXml($xml.OuterXml)
      $toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("FortiGate WAN Monitor").Show($toast)
    `;

    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
        timeout: 4000
      }, (err) => {
        if (err) console.warn(`Windows Toast notice: ${err.message}`);
        resolve();
      });
    });
  }

  /**
   * Telegram Bot API Dispatcher
   */
  async sendTelegramAlert(teleConfig, alert) {
    const icon = alert.severity === 'CRITICAL' ? '🚨' : alert.severity === 'WARNING' ? '⚠️' : '✅';
    const text = `${icon} *${alert.title}*\n\n` +
      `*Link:* \`${alert.linkId.toUpperCase()}\`\n` +
      `*Status:* *${alert.severity}*\n` +
      `*Details:* ${alert.message}\n` +
      (alert.sample ? `*Metrics:* Latency: ${alert.sample.latency}ms | Loss: ${alert.sample.packetLoss}% | Jitter: ${alert.sample.jitter}ms\n` : '') +
      `*Time:* ${new Date().toLocaleTimeString()}`;

    const payload = JSON.stringify({
      chat_id: teleConfig.chatId,
      text: text,
      parse_mode: 'Markdown'
    });

    return this.postJson(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, payload);
  }

  /**
   * Discord Webhook Dispatcher
   */
  async sendDiscordAlert(webhookUrl, alert) {
    const color = alert.severity === 'CRITICAL' ? 0xEF4444 : alert.severity === 'WARNING' ? 0xF59E0B : 0x10B981;
    const payload = JSON.stringify({
      embeds: [
        {
          title: alert.title,
          description: alert.message,
          color: color,
          fields: alert.sample ? [
            { name: 'Latency', value: `${alert.sample.latency} ms`, inline: true },
            { name: 'Packet Loss', value: `${alert.sample.packetLoss} %`, inline: true },
            { name: 'Jitter', value: `${alert.sample.jitter} ms`, inline: true }
          ] : [],
          footer: { text: 'FortiGate SD-WAN Link Degradation Monitor' },
          timestamp: new Date().toISOString()
        }
      ]
    });

    return this.postJson(webhookUrl, payload);
  }

  /**
   * Slack Webhook Dispatcher
   */
  async sendSlackAlert(webhookUrl, alert) {
    const icon = alert.severity === 'CRITICAL' ? ':rotating_light:' : alert.severity === 'WARNING' ? ':warning:' : ':white_check_mark:';
    const payload = JSON.stringify({
      text: `${icon} *${alert.title}*\n${alert.message}`
    });

    return this.postJson(webhookUrl, payload);
  }

  /**
   * Helper to POST JSON payload
   */
  postJson(urlStr, data) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
          },
          timeout: 5000
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Webhook returned HTTP ${res.statusCode}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Webhook request timed out'));
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

module.exports = AlertManager;
