/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * WhatsApp Notification Client
 * Supports CallMeBot (instant setup), Twilio for WhatsApp, and Custom Webhooks
 */

const https = require('node:https');
const http = require('node:http');

class WhatsAppClient {
  constructor(options = {}) {
    this.provider = options.provider || 'callmebot'; // 'callmebot' | 'twilio' | 'webhook'
    
    // CallMeBot options
    this.phone = options.phone || '';
    this.apiKey = options.apiKey || '';

    // Twilio options
    this.accountSid = options.accountSid || '';
    this.authToken = options.authToken || '';
    this.twilioFrom = options.twilioFrom || '';
    this.twilioTo = options.twilioTo || '';

    // Custom Webhook option
    this.webhookUrl = options.webhookUrl || '';
  }

  updateConfig(options = {}) {
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.phone !== undefined) this.phone = options.phone;
    if (options.apiKey !== undefined) this.apiKey = options.apiKey;
    if (options.accountSid !== undefined) this.accountSid = options.accountSid;
    if (options.authToken !== undefined) this.authToken = options.authToken;
    if (options.twilioFrom !== undefined) this.twilioFrom = options.twilioFrom;
    if (options.twilioTo !== undefined) this.twilioTo = options.twilioTo;
    if (options.webhookUrl !== undefined) this.webhookUrl = options.webhookUrl;
  }

  async sendMessage(message) {
    if (this.provider === 'twilio') {
      return this.sendTwilio(message);
    } else if (this.provider === 'webhook') {
      return this.sendWebhook(message);
    } else {
      // Default: CallMeBot
      return this.sendCallMeBot(message);
    }
  }

  /**
   * CallMeBot WhatsApp API
   * Free & instant for personal/admin notifications
   */
  async sendCallMeBot(message) {
    if (!this.phone || !this.apiKey) {
      throw new Error('CallMeBot requires phone number and API key');
    }

    const cleanPhone = this.phone.replace(/[^0-9+]/g, '');
    const encodedText = encodeURIComponent(message);
    const urlStr = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodedText}&apikey=${this.apiKey}`;

    return new Promise((resolve, reject) => {
      https.get(urlStr, { timeout: 8000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, response: body });
          } else {
            reject(new Error(`CallMeBot returned HTTP ${res.statusCode}: ${body}`));
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Twilio WhatsApp API
   */
  async sendTwilio(message) {
    if (!this.accountSid || !this.authToken || !this.twilioTo) {
      throw new Error('Twilio requires Account SID, Auth Token, and To number');
    }

    const fromNum = this.twilioFrom.startsWith('whatsapp:') ? this.twilioFrom : `whatsapp:${this.twilioFrom}`;
    const toNum = this.twilioTo.startsWith('whatsapp:') ? this.twilioTo : `whatsapp:${this.twilioTo}`;

    const postData = new URLSearchParams({
      From: fromNum,
      To: toNum,
      Body: message
    }).toString();

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const urlStr = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;

    return new Promise((resolve, reject) => {
      const req = https.request(urlStr, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 8000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, response: body });
          } else {
            reject(new Error(`Twilio API returned HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Generic WhatsApp HTTP Webhook
   */
  async sendWebhook(message) {
    if (!this.webhookUrl) {
      throw new Error('WhatsApp webhook URL is required');
    }

    const payload = JSON.stringify({
      message,
      timestamp: new Date().toISOString()
    });

    return new Promise((resolve, reject) => {
      const url = new URL(this.webhookUrl);
      const client = url.protocol === 'https:' ? https : http;

      const req = client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 8000
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true });
          } else {
            reject(new Error(`WhatsApp Webhook returned HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = WhatsAppClient;
