/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * FortiOS REST API Client
 */

const https = require('node:https');
const http = require('node:http');

class FortiGateClient {
  constructor(options = {}) {
    this.host = (options.host || 'https://192.168.1.1').replace(/\/+$/, '');
    this.apiToken = options.apiToken || '';
    this.vdom = options.vdom || 'root';
    this.rejectUnauthorized = options.rejectUnauthorized ?? false;
    this.timeout = options.timeoutMs || 4000;
    this.healthCheckName = options.healthCheckName || 'Default_DNS';
    this.wan1Name = options.wan1Interface || 'wan1';
    this.wan2Name = options.wan2Interface || 'wan2';

    // Agent for custom SSL behavior (e.g. self-signed FortiGate admin certs)
    this.httpsAgent = new https.Agent({
      rejectUnauthorized: this.rejectUnauthorized
    });
  }

  updateConfig(options = {}) {
    if (options.host !== undefined) this.host = options.host.replace(/\/+$/, '');
    if (options.apiToken !== undefined) this.apiToken = options.apiToken;
    if (options.vdom !== undefined) this.vdom = options.vdom;
    if (options.rejectUnauthorized !== undefined) {
      this.rejectUnauthorized = options.rejectUnauthorized;
      this.httpsAgent = new https.Agent({ rejectUnauthorized: this.rejectUnauthorized });
    }
    if (options.healthCheckName !== undefined) this.healthCheckName = options.healthCheckName;
    if (options.wan1Interface !== undefined) this.wan1Name = options.wan1Interface;
    if (options.wan2Interface !== undefined) this.wan2Name = options.wan2Interface;
  }

  async request(endpoint) {
    if (!this.apiToken) {
      throw new Error('FortiGate API token is not configured');
    }

    const url = new URL(`${this.host}${endpoint}`);
    if (!url.searchParams.has('vdom')) {
      url.searchParams.set('vdom', this.vdom);
    }

    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.request(
        url,
        {
          method: 'GET',
          agent: isHttps ? this.httpsAgent : undefined,
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            Accept: 'application/json',
            'User-Agent': 'FortiGate-WAN-Monitor/1.0'
          },
          timeout: this.timeout
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 401 || res.statusCode === 403) {
              return reject(new Error(`FortiGate authentication failed (HTTP ${res.statusCode}). Check API token permissions.`));
            }
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              return reject(new Error(`FortiGate responded with HTTP ${res.statusCode}: ${data.substring(0, 150)}`));
            }
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (err) {
              reject(new Error(`Failed to parse FortiGate JSON response: ${err.message}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`FortiGate request timed out after ${this.timeout}ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`FortiGate connection error (${this.host}): ${err.message}`));
      });

      req.end();
    });
  }

  /**
   * Test connection to FortiGate API
   */
  async testConnection() {
    try {
      const res = await this.request('/api/v2/monitor/system/status');
      return {
        success: true,
        version: res?.version || 'FortiOS',
        serial: res?.serial || 'Unknown',
        hostname: res?.hostname || 'FortiGate'
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Fetch FortiGate SD-WAN Performance SLA data
   */
  async getSlaMetrics() {
    try {
      // FortiOS 6.4 / 7.0 / 7.2 / 7.4 / 7.6 endpoint for virtual-wan / SD-WAN SLA
      const res = await this.request('/api/v2/monitor/virtual-wan/sla');
      const results = res.results || [];
      
      const metrics = {
        wan1: null,
        wan2: null,
        rawSla: results
      };

      // Find matching health-check SLA or check first available
      let slaEntries = [];
      if (Array.isArray(results)) {
        const matchingSla = results.find(s => s.name === this.healthCheckName) || results[0];
        if (matchingSla && Array.isArray(matchingSla.interface)) {
          slaEntries = matchingSla.interface;
        } else if (matchingSla && Array.isArray(matchingSla.members)) {
          slaEntries = matchingSla.members;
        }
      }

      for (const entry of slaEntries) {
        const ifName = entry.interface || entry.name;
        const normalized = {
          interface: ifName,
          latency: parseFloat(entry.latency ?? entry.rtt ?? 0),
          jitter: parseFloat(entry.jitter ?? 0),
          packetLoss: parseFloat(entry.packet_loss ?? entry.loss ?? 0),
          status: (entry.status || (entry.packet_loss >= 100 ? 'down' : 'up')).toLowerCase(),
          source: 'fortigate-sla'
        };

        if (ifName === this.wan1Name || ifName.toLowerCase().includes('wan1')) {
          metrics.wan1 = normalized;
        } else if (ifName === this.wan2Name || ifName.toLowerCase().includes('wan2')) {
          metrics.wan2 = normalized;
        }
      }

      return metrics;
    } catch (err) {
      return {
        wan1: null,
        wan2: null,
        error: err.message
      };
    }
  }

  /**
   * Fetch Physical Interface Status (carrier detect, errors, drops)
   */
  async getInterfaceStatus() {
    try {
      const res = await this.request('/api/v2/monitor/system/interface');
      const results = res.results || {};

      const extractIf = (name) => {
        const item = results[name];
        if (!item) return null;
        return {
          link: item.link === 'up' || item.status === 'up' ? 'up' : 'down',
          speed: item.speed || 0,
          duplex: item.duplex || 'unknown',
          rxBytes: item.rx_bytes || 0,
          txBytes: item.tx_bytes || 0,
          rxErrors: item.rx_errors || 0,
          rxDropped: item.rx_dropped || 0,
          txDropped: item.tx_dropped || 0
        };
      };

      return {
        wan1: extractIf(this.wan1Name),
        wan2: extractIf(this.wan2Name)
      };
    } catch (err) {
      return {
        wan1: null,
        wan2: null,
        error: err.message
      };
    }
  }
}

module.exports = FortiGateClient;
