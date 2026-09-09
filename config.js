/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Application Configuration Defaults
 */

const path = require('node:path');

const config = {
  // Server Port and Host
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',

  // FortiGate Firewall Settings
  fortigate: {
    enabled: true,
    // e.g. "https://192.168.1.1" or "https://fortigate.yourdomain.local"
    host: process.env.FORTIGATE_HOST || 'https://192.168.1.1',
    // REST API Administrator Token (System > Administrators > Create REST API Admin)
    apiToken: process.env.FORTIGATE_API_TOKEN || '',
    vdom: process.env.FORTIGATE_VDOM || 'root',
    // Allow self-signed certificates common on internal firewalls
    rejectUnauthorized: false,
    // Polling interval in milliseconds (FortiGate SD-WAN SLA probe telemetry)
    pollIntervalMs: 3000,
    // Expected WAN interface names in FortiGate
    wan1Interface: 'wan1',
    wan2Interface: 'wan2',
    // Name of the SD-WAN Performance SLA rule in FortiOS
    healthCheckName: 'Default_DNS'
  },

  // Service Degradation Thresholds
  thresholds: {
    // Packet Loss (%)
    packetLossWarning: 2.0,   // > 2% is degraded (VoIP, streaming, and games suffer)
    packetLossCritical: 8.0,  // > 8% is severe degradation

    // Latency (ms)
    latencyWarningMs: 120,    // > 120ms warning
    latencyCriticalMs: 250,   // > 250ms critical

    // Jitter (ms)
    jitterWarningMs: 25,      // > 25ms jitter warning
    jitterCriticalMs: 50,     // > 50ms jitter critical

    // Failure criteria: Consecutive bad probe samples before alerting
    consecutiveFailsToAlert: 2,

    // Recovery criteria: Consecutive healthy probe samples before sending Recovery alert
    consecutiveHealthyToRecover: 4,

    // Flapping detection: Status changes within window
    flapWindowSeconds: 300,
    flapThresholdCount: 3
  },

  // Notification Channels
  notifications: {
    // 1. Windows Native Desktop Toast Notification
    windowsToast: {
      enabled: true,
      sound: true
    },

    // 2. Telegram Bot Alerts
    telegram: {
      enabled: false,
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || ''
    },

    // 3. Discord Webhook
    discord: {
      enabled: false,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || ''
    },

    // 4. Slack / Microsoft Teams Incoming Webhook
    slack: {
      enabled: false,
      webhookUrl: process.env.SLACK_WEBHOOK_URL || ''
    },

    // 5. SMTP Email Alerts
    email: {
      enabled: false,
      smtpHost: process.env.SMTP_HOST || '',
      smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.ALERT_FROM || 'wan-monitor@fortigate.local',
      to: process.env.ALERT_TO || ''
    }
  },

  // Direct Synthetic Probing Targets (Secondary verification)
  probing: {
    enabled: true,
    pingTargets: ['8.8.8.8', '1.1.1.1'],
    intervalMs: 5000
  },

  // Simulation Mode: When true, allows testing alerts & degradation scenarios immediately
  simulation: {
    enabled: true
  },

  // Database path
  dbPath: path.join(__dirname, 'monitor.db')
};

module.exports = config;
