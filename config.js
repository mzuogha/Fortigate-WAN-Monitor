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
    host: process.env.FORTIGATE_HOST || 'https://192.168.1.1',
    apiToken: process.env.FORTIGATE_API_TOKEN || '',
    vdom: process.env.FORTIGATE_VDOM || 'root',
    rejectUnauthorized: false,
    pollIntervalMs: 3000,
    wan1Interface: 'wan1',
    wan2Interface: 'wan2',
    healthCheckName: 'Default_DNS'
  },

  // Service Degradation Thresholds
  thresholds: {
    packetLossWarning: 2.0,   // > 2% is degraded
    packetLossCritical: 8.0,  // > 8% is severe degradation
    latencyWarningMs: 120,    // > 120ms warning
    latencyCriticalMs: 250,   // > 250ms critical
    jitterWarningMs: 25,      // > 25ms jitter warning
    jitterCriticalMs: 50,     // > 50ms jitter critical
    consecutiveFailsToAlert: 2,
    consecutiveHealthyToRecover: 4,
    flapWindowSeconds: 300,
    flapThresholdCount: 3
  },

  // Multi-Channel Notifications
  notifications: {
    // 1. Windows Native Desktop Toast Notification
    windowsToast: {
      enabled: true,
      sound: true
    },

    // 2. Email Notification (Native Zero-Dependency SMTP Client)
    email: {
      enabled: false,
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false, // true for port 465, false for 587 (STARTTLS) or 25
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.ALERT_FROM || 'wan-monitor@fortigate.local',
      to: process.env.ALERT_TO || ''
    },

    // 3. WhatsApp Notification (CallMeBot / Twilio / Custom Webhook)
    whatsapp: {
      enabled: false,
      provider: process.env.WHATSAPP_PROVIDER || 'callmebot', // 'callmebot' | 'twilio' | 'webhook'
      phone: process.env.WHATSAPP_PHONE || '',                 // e.g. "+1234567890"
      apiKey: process.env.WHATSAPP_APIKEY || '',               // CallMeBot API key
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      twilioFrom: process.env.TWILIO_FROM || '',
      twilioTo: process.env.TWILIO_TO || '',
      webhookUrl: process.env.WHATSAPP_WEBHOOK_URL || ''
    },

    // 4. Telegram Bot Alerts
    telegram: {
      enabled: false,
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || ''
    },

    // 5. Discord Webhook
    discord: {
      enabled: false,
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || ''
    },

    // 6. Slack / Microsoft Teams Incoming Webhook
    slack: {
      enabled: false,
      webhookUrl: process.env.SLACK_WEBHOOK_URL || ''
    }
  },

  // Direct Synthetic Probing Targets
  probing: {
    enabled: true,
    pingTargets: ['8.8.8.8', '1.1.1.1'],
    intervalMs: 5000
  },

  // Simulation Mode
  simulation: {
    enabled: true
  },

  // Database path
  dbPath: path.join(__dirname, 'monitor.db')
};

module.exports = config;
