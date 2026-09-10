/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Application Configuration Defaults
 *
 * Every value here can be overridden by an environment variable (shown next to it)
 * or, for most settings, from the dashboard (stored in monitor.db).
 */

const path = require('node:path');

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));
const num = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));

const config = {
  // Web server. Listens on all interfaces so the FortiGate can reach the webhook,
  // but remote dashboard access requires a password (see security below).
  // The port can also be changed from Settings > Server; the PORT environment variable
  // takes precedence over that setting.
  port: num(process.env.PORT, 4000),
  host: process.env.HOST || '0.0.0.0',

  // Security
  security: {
    // Dashboard login. When no password is set, only this machine (localhost) can use
    // the dashboard/API. Set one with:  node server.js --set-password
    // or the DASHBOARD_PASSWORD environment variable.
    dashboardUser: process.env.DASHBOARD_USER || 'admin',
    dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
    // Shared secret the FortiGate Automation Stitch must send. Auto-generated on first run
    // if not provided; shown in Settings > FortiGate.
    webhookToken: process.env.WEBHOOK_TOKEN || ''
  },

  // FortiGate firewall
  fortigate: {
    enabled: true,
    host: process.env.FORTIGATE_HOST || 'https://192.168.1.1',
    apiToken: process.env.FORTIGATE_API_TOKEN || '',
    vdom: process.env.FORTIGATE_VDOM || 'root',
    // Most FortiGates use a self-signed admin certificate. Set FORTIGATE_VERIFY_TLS=true
    // once you have installed a trusted certificate.
    rejectUnauthorized: bool(process.env.FORTIGATE_VERIFY_TLS, false),
    pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 5000),
    timeoutMs: 5000,
    wan1Interface: process.env.WAN1_INTERFACE || 'wan1',
    wan2Interface: process.env.WAN2_INTERFACE || 'wan2',
    // Friendly names used in alerts and on the dashboard, e.g. "MTN Fibre", "Airtel LTE"
    wan1Label: process.env.WAN1_LABEL || 'WAN 1',
    wan2Label: process.env.WAN2_LABEL || 'WAN 2',
    healthCheckName: process.env.FORTIGATE_HEALTH_CHECK || 'Default_DNS',
    // Consecutive failed API polls before a "monitor lost contact with FortiGate" alert
    apiFailuresToAlert: 4
  },

  // Service degradation thresholds
  thresholds: {
    packetLossWarning: 2.0,   // >= 2% is degraded
    packetLossCritical: 8.0,  // >= 8% is severe degradation
    latencyWarningMs: 120,
    latencyCriticalMs: 250,
    jitterWarningMs: 25,
    jitterCriticalMs: 50,
    consecutiveFailsToAlert: 2,
    consecutiveHealthyToRecover: 4,
    flapWindowSeconds: 300,
    flapThresholdCount: 3,
    // Re-notify while a link stays degraded/down (0 disables)
    reminderMinutes: 30
  },

  // Multi-channel notifications
  notifications: {
    // Alerts that fail to send (e.g. both links down) are queued and retried.
    retry: {
      maxQueue: 200,
      maxAgeHours: 24
    },

    // Windows desktop toast. Note: toasts are not visible when the monitor runs as the
    // SYSTEM background task; use email/Telegram/WhatsApp/Teams for 24/7 alerting.
    windowsToast: {
      enabled: true,
      sound: true
    },

    email: {
      enabled: false,
      host: process.env.SMTP_HOST || '',
      port: num(process.env.SMTP_PORT, 587),
      secure: false, // true for port 465; false for 587/25 (STARTTLS used when offered)
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.ALERT_FROM || 'wan-monitor@fortigate.local',
      to: process.env.ALERT_TO || '', // comma-separated for multiple recipients
      rejectUnauthorized: bool(process.env.SMTP_VERIFY_TLS, true)
    },

    whatsapp: {
      enabled: false,
      provider: process.env.WHATSAPP_PROVIDER || 'callmebot', // 'callmebot' | 'twilio' | 'webhook'
      phone: process.env.WHATSAPP_PHONE || '',
      apiKey: process.env.WHATSAPP_APIKEY || '',
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      twilioFrom: process.env.TWILIO_FROM || '',
      twilioTo: process.env.TWILIO_TO || '',
      webhookUrl: process.env.WHATSAPP_WEBHOOK_URL || ''
    },

    telegram: {
      enabled: false,
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || ''
    },

    discord: {
      enabled: false,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || ''
    },

    slack: {
      enabled: false,
      webhookUrl: process.env.SLACK_WEBHOOK_URL || ''
    },

    // Microsoft Teams via a Workflows webhook
    // ("Post to a channel when a webhook request is received" template)
    teams: {
      enabled: false,
      webhookUrl: process.env.TEAMS_WEBHOOK_URL || ''
    }
  },

  // Simulation mode generates fake data for demos and testing. OFF by default so a
  // production install never shows (or alerts on) simulated numbers.
  simulation: {
    enabled: bool(process.env.SIMULATION, false)
  },

  // Daily report: summary of the previous day, sent through all enabled channels
  // (email gets the full HTML report). Reports can also be generated on demand.
  reports: {
    dailyEnabled: bool(process.env.DAILY_REPORT, false),
    dailyTime: process.env.DAILY_REPORT_TIME || '07:00' // server local time, HH:MM
  },

  // Storage
  dbPath: process.env.DB_PATH || path.join(__dirname, 'monitor.db'),
  metricRetentionDays: num(process.env.METRIC_RETENTION_DAYS, 14)
};

module.exports = config;
