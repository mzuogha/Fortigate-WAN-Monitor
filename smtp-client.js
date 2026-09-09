/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Zero-Dependency Native Node.js SMTP Client
 * Supports Port 25 (Plain), Port 587 (STARTTLS), and Port 465 (Direct SSL/TLS)
 */

const net = require('node:net');
const tls = require('node:tls');

class SmtpClient {
  constructor(options = {}) {
    this.host = options.host || 'smtp.gmail.com';
    this.port = parseInt(options.port || '587', 10);
    this.secure = options.secure ?? (this.port === 465);
    this.user = options.user || '';
    this.pass = options.pass || '';
    this.from = options.from || 'wan-monitor@fortigate.local';
    this.to = options.to || '';
    this.timeout = options.timeoutMs || 10000;
  }

  updateConfig(options = {}) {
    if (options.host !== undefined) this.host = options.host;
    if (options.port !== undefined) this.port = parseInt(options.port, 10);
    if (options.secure !== undefined) this.secure = options.secure;
    if (options.user !== undefined) this.user = options.user;
    if (options.pass !== undefined) this.pass = options.pass;
    if (options.from !== undefined) this.from = options.from;
    if (options.to !== undefined) this.to = options.to;
  }

  async sendMail({ to, subject, html, text }) {
    const recipient = to || this.to;
    if (!recipient) {
      throw new Error('SMTP recipient email address is required');
    }
    if (!this.host) {
      throw new Error('SMTP server host is required');
    }

    return new Promise((resolve, reject) => {
      let socket = null;
      let buffer = '';
      let state = 'INIT';
      let resolved = false;

      const finish = (err, res) => {
        if (resolved) return;
        resolved = true;
        if (socket) {
          try { socket.end(); socket.destroy(); } catch (_) {}
        }
        if (err) reject(err);
        else resolve(res);
      };

      const send = (cmd) => {
        if (socket && !socket.destroyed) {
          socket.write(cmd + '\r\n');
        }
      };

      const handleResponse = (line) => {
        const code = parseInt(line.substring(0, 3), 10);

        if (code >= 400) {
          return finish(new Error(`SMTP Error (${code}): ${line}`));
        }

        switch (state) {
          case 'INIT':
            if (code === 220) {
              state = 'HELO';
              send(`EHLO ${net.isIP(this.host) ? '[127.0.0.1]' : 'localhost'}`);
            }
            break;

          case 'HELO':
            if (code === 250) {
              if (this.port === 587 && !this.secure) {
                state = 'STARTTLS';
                send('STARTTLS');
              } else if (this.user && this.pass) {
                state = 'AUTH_LOGIN';
                send('AUTH LOGIN');
              } else {
                state = 'MAIL_FROM';
                send(`MAIL FROM:<${this.from}>`);
              }
            }
            break;

          case 'STARTTLS':
            if (code === 220) {
              // Upgrade socket to TLS
              const secureSocket = tls.connect({
                socket,
                host: this.host,
                rejectUnauthorized: false
              }, () => {
                socket = secureSocket;
                attachListeners(socket);
                state = 'HELO_AFTER_TLS';
                send(`EHLO ${net.isIP(this.host) ? '[127.0.0.1]' : 'localhost'}`);
              });
              secureSocket.on('error', (err) => finish(new Error(`TLS Handshake Failed: ${err.message}`)));
            }
            break;

          case 'HELO_AFTER_TLS':
            if (code === 250) {
              if (this.user && this.pass) {
                state = 'AUTH_LOGIN';
                send('AUTH LOGIN');
              } else {
                state = 'MAIL_FROM';
                send(`MAIL FROM:<${this.from}>`);
              }
            }
            break;

          case 'AUTH_LOGIN':
            if (code === 334) {
              state = 'AUTH_USER';
              send(Buffer.from(this.user).toString('base64'));
            }
            break;

          case 'AUTH_USER':
            if (code === 334) {
              state = 'AUTH_PASS';
              send(Buffer.from(this.pass).toString('base64'));
            }
            break;

          case 'AUTH_PASS':
            if (code === 235) {
              state = 'MAIL_FROM';
              send(`MAIL FROM:<${this.from}>`);
            } else {
              finish(new Error(`SMTP Authentication failed: ${line}`));
            }
            break;

          case 'MAIL_FROM':
            if (code === 250) {
              state = 'RCPT_TO';
              send(`RCPT TO:<${recipient}>`);
            }
            break;

          case 'RCPT_TO':
            if (code === 250) {
              state = 'DATA';
              send('DATA');
            }
            break;

          case 'DATA':
            if (code === 354) {
              state = 'MESSAGE';
              const boundary = `----=_Part_${Date.now()}`;
              const message = [
                `From: "FortiGate WAN Monitor" <${this.from}>`,
                `To: <${recipient}>`,
                `Subject: ${subject}`,
                `MIME-Version: 1.0`,
                `Content-Type: multipart/alternative; boundary="${boundary}"`,
                ``,
                `--${boundary}`,
                `Content-Type: text/plain; charset=utf-8`,
                ``,
                text || 'FortiGate WAN Alert',
                ``,
                `--${boundary}`,
                `Content-Type: text/html; charset=utf-8`,
                ``,
                html || `<p>${text || 'FortiGate WAN Alert'}</p>`,
                ``,
                `--${boundary}--`,
                `.`
              ].join('\r\n');

              send(message);
            }
            break;

          case 'MESSAGE':
            if (code === 250) {
              state = 'QUIT';
              send('QUIT');
              finish(null, { success: true, messageId: line });
            }
            break;

          case 'QUIT':
            finish(null, { success: true });
            break;
        }
      };

      const attachListeners = (s) => {
        s.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\r\n');
          buffer = lines.pop(); // keep last incomplete chunk

          for (const line of lines) {
            if (line.length >= 3 && (line[3] === ' ' || line.length === 3)) {
              handleResponse(line);
            }
          }
        });

        s.on('error', (err) => finish(new Error(`SMTP connection error: ${err.message}`)));
        s.setTimeout(this.timeout, () => {
          finish(new Error(`SMTP connection timed out after ${this.timeout}ms`));
        });
      };

      // Connect
      try {
        if (this.secure) {
          socket = tls.connect({
            host: this.host,
            port: this.port,
            rejectUnauthorized: false
          }, () => {
            attachListeners(socket);
          });
        } else {
          socket = net.connect({
            host: this.host,
            port: this.port
          }, () => {
            attachListeners(socket);
          });
        }
      } catch (err) {
        finish(err);
      }
    });
  }
}

module.exports = SmtpClient;
