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
    const url = new URL('https://api.callmebot.com/whatsapp.php');
    url.searchParams.set('phone', cleanPhone);
    url.searchParams.set('text', message.slice(0, 2000));
    url.searchParams.set('apikey', this.apiKey);

    const body = await this.httpRequest(url, { method: 'GET' });
    // CallMeBot returns HTTP 200 even for some errors; check the body
    if (/APIKey is invalid|not allowed to send/i.test(body)) {
      throw new Error(`CallMeBot rejected the message: ${body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    return { success: true, response: body };
  }

  /**
   * Minimal HTTP helper with a hard timeout (the previous version could hang forever).
   */
  httpRequest(url, { method = 'GET', headers = {}, body = null, timeout = 10000 } = {}) {
    const target = url instanceof URL ? url : new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(target, { method, headers, timeout }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (data.length < 20000) data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`${target.hostname} returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error(`Request to ${target.hostname} timed out after ${timeout}ms`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
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
    const urlStr = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`;

    const body = await this.httpRequest(urlStr, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      body: postData
    });
    return { success: true, response: body };
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

    await this.httpRequest(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload
    });
    return { success: true };
  }
}

module.exports = WhatsAppClient;
