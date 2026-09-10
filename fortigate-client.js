/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * FortiOS REST API Client
 *
 * Data sources (FortiOS 6.4 - 7.6):
 *   GET /api/v2/monitor/virtual-wan/health-check
 *       { results: { "<health-check>": { "<interface>": { status, latency, jitter, packet_loss, ... } } } }
 *   GET /api/v2/monitor/system/interface
 *       { results: { "<interface>": { link: true|false, rx_bytes, tx_bytes, ... } } }
 */

const https = require('node:https');
const http = require('node:http');

const HEALTH_CHECK_PATH = '/api/v2/monitor/virtual-wan/health-check';
const INTERFACE_PATH = '/api/v2/monitor/system/interface';
const STATUS_PATH = '/api/v2/monitor/system/status';

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 1) {
  return v === null ? null : Number(v.toFixed(digits));
}

class FortiGateClient {
  constructor(options = {}) {
    this.counters = {}; // interface -> { rx, tx, t } for throughput calculation
    this.updateConfig({
      host: 'https://192.168.1.1',
      vdom: 'root',
      rejectUnauthorized: false,
      healthCheckName: 'Default_DNS',
      wan1Interface: 'wan1',
      wan2Interface: 'wan2',
      ...options
    });
  }

  updateConfig(options = {}) {
    if (options.host !== undefined) this.host = String(options.host).trim().replace(/\/+$/, '');
    if (this.host && !/^https?:\/\//i.test(this.host)) this.host = `https://${this.host}`;
    if (options.apiToken !== undefined) this.apiToken = options.apiToken;
    if (options.vdom !== undefined) this.vdom = options.vdom;
    if (options.timeoutMs !== undefined) this.timeout = options.timeoutMs;
    if (!this.timeout) this.timeout = 5000;
    if (options.rejectUnauthorized !== undefined || !this.httpsAgent) {
      if (options.rejectUnauthorized !== undefined) this.rejectUnauthorized = !!options.rejectUnauthorized;
      this.httpsAgent = new https.Agent({ rejectUnauthorized: !!this.rejectUnauthorized, keepAlive: true });
    }
    if (options.healthCheckName !== undefined) this.healthCheckName = options.healthCheckName;
    if (options.wan1Interface !== undefined) this.wan1Name = options.wan1Interface;
    if (options.wan2Interface !== undefined) this.wan2Name = options.wan2Interface;
  }

  request(endpoint) {
    if (!this.apiToken) {
      return Promise.reject(new Error('FortiGate API token is not configured'));
    }

    const url = new URL(`${this.host}${endpoint}`);
    if (this.vdom && !url.searchParams.has('vdom')) {
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
            'User-Agent': 'FortiGate-WAN-Monitor/2.0'
          },
          timeout: this.timeout
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 401) {
              return reject(new Error('FortiGate rejected the API token (HTTP 401). Check the token and that this ' +
                'machine\'s IP is in the REST API admin\'s Trusted Hosts.'));
            }
            if (res.statusCode === 403) {
              return reject(new Error('FortiGate denied access (HTTP 403). Give the REST API admin profile read ' +
                'access to System and Network.'));
            }
            if (res.statusCode === 404) {
              return reject(new Error(`FortiGate endpoint not found (HTTP 404): ${endpoint}. Is SD-WAN enabled ` +
                'and is the VDOM correct?'));
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`FortiGate responded with HTTP ${res.statusCode}: ${data.substring(0, 150)}`));
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Failed to parse FortiGate JSON response: ${err.message}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`FortiGate request timed out after ${this.timeout}ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`FortiGate connection error (${this.host}): ${err.message}`));
      });

      req.end();
    });
  }

  /**
   * Test connection and report what the monitor can see, to help with setup.
   */
  async testConnection() {
    try {
      const res = await this.request(STATUS_PATH);
      const info = {
        success: true,
        version: res?.version || res?.results?.version || 'FortiOS',
        serial: res?.serial || 'Unknown',
        hostname: res?.results?.hostname || res?.hostname || 'FortiGate'
      };
      try {
        const hc = await this.request(HEALTH_CHECK_PATH);
        const results = hc?.results && typeof hc.results === 'object' ? hc.results : {};
        info.healthChecks = Object.entries(results).map(([name, members]) => ({
          name,
          members: members && typeof members === 'object' ? Object.keys(members) : []
        }));
        const configured = info.healthChecks.find(h => h.name === this.healthCheckName);
        const missing = [this.wan1Name, this.wan2Name].filter(i => !configured || !configured.members.includes(i));
        if (!configured) {
          info.warning = `Health check "${this.healthCheckName}" was not found. Available: ` +
            (info.healthChecks.map(h => h.name).join(', ') || 'none');
        } else if (missing.length) {
          info.warning = `Interface(s) ${missing.join(', ')} are not members of "${this.healthCheckName}". ` +
            `Members: ${configured.members.join(', ')}`;
        }
      } catch (err) {
        info.warning = `Connected, but SD-WAN health-check data is unavailable: ${err.message}`;
      }
      return info;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Normalise one health-check member entry.
   */
  static normaliseMember(ifName, entry, healthCheck) {
    const status = String(entry?.status || '').toLowerCase();
    const up = status === 'up';
    return {
      interface: ifName,
      healthCheck,
      status: up ? 'up' : 'down',
      probeStatus: status || 'unknown',
      latency: up ? round(toNumber(entry.latency)) : null,
      jitter: up ? round(toNumber(entry.jitter)) : null,
      packetLoss: up ? round(toNumber(entry.packet_loss) ?? 0) : 100,
      slaTargetsMet: Array.isArray(entry?.sla_targets_met) ? entry.sla_targets_met : [],
      source: 'fortigate-sla'
    };
  }

  /**
   * Parse the health-check monitor response for one interface. Uses the configured
   * health check; if the interface is not in it, falls back to any health check that
   * contains the interface (reported via `healthCheck` so the UI can show it).
   */
  parseHealthCheck(results, ifName) {
    if (!results || typeof results !== 'object' || !ifName) return null;
    const preferred = results[this.healthCheckName];
    if (preferred && typeof preferred === 'object' && preferred[ifName]) {
      return FortiGateClient.normaliseMember(ifName, preferred[ifName], this.healthCheckName);
    }
    for (const [name, members] of Object.entries(results)) {
      if (members && typeof members === 'object' && members[ifName]) {
        return FortiGateClient.normaliseMember(ifName, members[ifName], name);
      }
    }
    return null;
  }

  /**
   * Interface state and throughput (from byte-counter deltas between polls).
   */
  parseInterface(results, ifName, now = Date.now()) {
    const item = results?.[ifName];
    if (!item || typeof item !== 'object') return null;
    const link = item.link;
    const linkUp = link === true || link === 'up' || link === 1 || (link === undefined && item.status === 'up');

    let rxKbps = null;
    let txKbps = null;
    const rx = toNumber(item.rx_bytes);
    const tx = toNumber(item.tx_bytes);
    const prev = this.counters[ifName];
    if (prev && rx !== null && tx !== null && now > prev.t && rx >= prev.rx && tx >= prev.tx) {
      const secs = (now - prev.t) / 1000;
      rxKbps = Math.round(((rx - prev.rx) * 8) / 1000 / secs);
      txKbps = Math.round(((tx - prev.tx) * 8) / 1000 / secs);
    }
    if (rx !== null && tx !== null) this.counters[ifName] = { rx, tx, t: now };

    return { linkUp, rxKbps, txKbps, speed: item.speed || null };
  }

  /**
   * Collect metrics for both WAN links.
   * Throws if the SD-WAN health-check data cannot be retrieved (API unreachable).
   * A link returns { status: 'unknown', reason } if it has no health-check data.
   */
  async getLinkMetrics() {
    const hc = await this.request(HEALTH_CHECK_PATH);
    const hcResults = hc?.results && typeof hc.results === 'object' ? hc.results : {};

    let ifResults = null;
    let interfaceError = null;
    try {
      const ifs = await this.request(INTERFACE_PATH);
      ifResults = ifs?.results || null;
    } catch (err) {
      interfaceError = err.message;
    }

    const now = Date.now();
    const build = (ifName) => {
      const sla = this.parseHealthCheck(hcResults, ifName);
      const intf = ifResults ? this.parseInterface(ifResults, ifName, now) : null;

      if (intf && intf.linkUp === false) {
        return {
          interface: ifName,
          status: 'down',
          carrierDown: true,
          latency: null,
          jitter: null,
          packetLoss: 100,
          rxKbps: 0,
          txKbps: 0,
          healthCheck: sla?.healthCheck || null,
          source: 'fortigate-interface'
        };
      }
      if (!sla) {
        return {
          interface: ifName,
          status: 'unknown',
          reason: `No SD-WAN health-check data for "${ifName}". Check the interface name and that it is ` +
            `a member of health check "${this.healthCheckName}".`,
          rxKbps: intf?.rxKbps ?? null,
          txKbps: intf?.txKbps ?? null
        };
      }
      return {
        ...sla,
        carrierDown: false,
        rxKbps: intf?.rxKbps ?? null,
        txKbps: intf?.txKbps ?? null
      };
    };

    return {
      wan1: build(this.wan1Name),
      wan2: build(this.wan2Name),
      healthChecks: Object.keys(hcResults),
      interfaceError
    };
  }
}

module.exports = FortiGateClient;
