/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Zero-dependency SMTP client
 * Port 465 (implicit TLS), 587/25 (STARTTLS when the server offers it), AUTH LOGIN,
 * multiple recipients, RFC 2047 subjects, base64 bodies and proper message headers.
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');

function encodeHeader(value) {
  const str = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(str) ? str : `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function base64Lines(str) {
  return Buffer.from(String(str ?? ''), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function parseRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
  return list.map(s => s.trim()).filter(Boolean);
}

class SmtpClient {
  constructor(options = {}) {
    this.host = options.host || '';
    this.port = parseInt(options.port || '587', 10);
    this.secure = options.secure ?? (this.port === 465);
    this.user = options.user || '';
    this.pass = options.pass || '';
    this.from = options.from || 'wan-monitor@fortigate.local';
    this.to = options.to || '';
    this.rejectUnauthorized = options.rejectUnauthorized ?? true;
    this.timeout = options.timeoutMs || 15000;
  }

  updateConfig(options = {}) {
    if (options.host !== undefined) this.host = options.host;
    if (options.port !== undefined) {
      this.port = parseInt(options.port, 10);
      if (options.secure === undefined) this.secure = this.port === 465;
    }
    if (options.secure !== undefined) this.secure = !!options.secure;
    if (options.user !== undefined) this.user = options.user;
    if (options.pass !== undefined) this.pass = options.pass;
    if (options.from !== undefined) this.from = options.from;
    if (options.to !== undefined) this.to = options.to;
    if (options.rejectUnauthorized !== undefined) this.rejectUnauthorized = !!options.rejectUnauthorized;
  }

  buildMessage({ recipients, subject, html, text }) {
    const boundary = `----=_Part_${crypto.randomBytes(12).toString('hex')}`;
    const domain = (this.from.split('@')[1] || 'localhost').replace(/[^a-zA-Z0-9.-]/g, '');
    const lines = [
      `From: "FortiGate WAN Monitor" <${this.from}>`,
      `To: ${recipients.map(r => `<${r}>`).join(', ')}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      'MIME-Version: 1.0',
      'X-Mailer: FortiGate-WAN-Monitor',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(text || 'FortiGate WAN Alert'),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(html || `<pre>${String(text || 'FortiGate WAN Alert').replace(/</g, '&lt;')}</pre>`),
      '',
      `--${boundary}--`
    ];
    // Dot-stuffing (RFC 5321 4.5.2); base64 bodies never start with '.', headers might.
    return lines.map(l => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
  }

  sendMail({ to, subject, html, text }) {
    const recipients = parseRecipients(to || this.to);
    if (!recipients.length) {
      return Promise.reject(new Error('SMTP recipient email address is required'));
    }
    if (!this.host) {
      return Promise.reject(new Error('SMTP server host is required'));
    }

    return new Promise((resolve, reject) => {
      let socket = null;
      let buffer = '';
      let responseLines = [];
      let state = 'GREETING';
      let done = false;
      let rcptIndex = 0;
      let tlsActive = this.secure;
      const helloName = (os.hostname() || 'localhost').replace(/[^a-zA-Z0-9.-]/g, '') || 'localhost';

      const finish = (err, res) => {
        if (done) return;
        done = true;
        if (socket) {
          try { socket.end(); socket.destroy(); } catch (_) { /* ignore */ }
        }
        if (err) reject(err);
        else resolve(res);
      };

      const send = (cmd) => {
        if (socket && !socket.destroyed) socket.write(`${cmd}\r\n`);
      };

      const startAuthOrMail = () => {
        if (this.user && this.pass) {
          state = 'AUTH_LOGIN';
          send('AUTH LOGIN');
        } else {
          state = 'MAIL_FROM';
          send(`MAIL FROM:<${this.from}>`);
        }
      };

      const handleResponse = (code, lines) => {
        const last = lines[lines.length - 1] || '';
        if (code >= 400) {
          const hint = state.startsWith('AUTH') ? ' (authentication failed - check username/app password)' : '';
          return finish(new Error(`SMTP error during ${state} (${code})${hint}: ${last}`));
        }

        switch (state) {
          case 'GREETING':
            state = 'EHLO';
            send(`EHLO ${helloName}`);
            break;

          case 'EHLO': {
            const offersStartTls = lines.some(l => /STARTTLS/i.test(l));
            if (!tlsActive && offersStartTls) {
              state = 'STARTTLS';
              send('STARTTLS');
            } else if (!tlsActive && this.user && this.pass && this.port !== 25) {
              finish(new Error('SMTP server does not offer STARTTLS; refusing to send credentials unencrypted'));
            } else {
              startAuthOrMail();
            }
            break;
          }

          case 'STARTTLS': {
            socket.removeAllListeners('data');
            socket.setTimeout(0);
            const secureSocket = tls.connect({
              socket,
              servername: net.isIP(this.host) ? undefined : this.host,
              rejectUnauthorized: this.rejectUnauthorized
            }, () => {
              socket = secureSocket;
              tlsActive = true;
              buffer = '';
              attachListeners(socket);
              state = 'EHLO';
              send(`EHLO ${helloName}`);
            });
            secureSocket.on('error', (err) => finish(new Error(`TLS handshake failed: ${err.message}`)));
            break;
          }

          case 'AUTH_LOGIN':
            state = 'AUTH_USER';
            send(Buffer.from(this.user).toString('base64'));
            break;

          case 'AUTH_USER':
            state = 'AUTH_PASS';
            send(Buffer.from(this.pass).toString('base64'));
            break;

          case 'AUTH_PASS':
            state = 'MAIL_FROM';
            send(`MAIL FROM:<${this.from}>`);
            break;

          case 'MAIL_FROM':
            state = 'RCPT_TO';
            send(`RCPT TO:<${recipients[rcptIndex++]}>`);
            break;

          case 'RCPT_TO':
            if (rcptIndex < recipients.length) {
              send(`RCPT TO:<${recipients[rcptIndex++]}>`);
            } else {
              state = 'DATA';
              send('DATA');
            }
            break;

          case 'DATA':
            state = 'MESSAGE';
            send(`${this.buildMessage({ recipients, subject, html, text })}\r\n.`);
            break;

          case 'MESSAGE':
            state = 'QUIT';
            send('QUIT');
            finish(null, { success: true, response: last });
            break;

          default:
            break;
        }
      };

      const attachListeners = (s) => {
        s.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\r\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line.length < 3) continue;
            responseLines.push(line);
            if (line[3] === '-') continue; // multi-line response continues
            const code = parseInt(line.substring(0, 3), 10);
            const all = responseLines;
            responseLines = [];
            handleResponse(code, all);
          }
        });
        s.on('error', (err) => finish(new Error(`SMTP connection error: ${err.message}`)));
        s.setTimeout(this.timeout, () => finish(new Error(`SMTP connection timed out after ${this.timeout}ms`)));
      };

      try {
        socket = this.secure
          ? tls.connect({ host: this.host, port: this.port, servername: net.isIP(this.host) ? undefined : this.host, rejectUnauthorized: this.rejectUnauthorized })
          : net.connect({ host: this.host, port: this.port });
        attachListeners(socket);
      } catch (err) {
        finish(err);
      }
    });
  }
}

SmtpClient.parseRecipients = parseRecipients;
module.exports = SmtpClient;
