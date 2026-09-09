# FortiGate Dual-WAN Link Monitor & Failover Guard

A standalone, real-time network monitoring application that continuously monitors both WAN links on a FortiGate firewall, detects service degradation (packet loss, latency spikes, jitter, link flaps, or hard drops) before users feel the outage, and delivers instant alerts across multiple notification channels.

---

## Key Features

1. **Multi-Channel Instant Notifications**:
   - **📧 Email Alerts (SMTP)**: Direct zero-dependency delivery supporting Office 365, Gmail, Exchange, or local SMTP relays (STARTTLS & SSL/TLS).
   - **💬 WhatsApp Alerts**: Real-time push notifications supporting **CallMeBot** (free 30-second setup), **Twilio for WhatsApp**, or custom webhooks.
   - **🖥️ Windows Desktop Toast Notifications**: Native Action Center alerts via PowerShell WinRT.
   - **✈️ Telegram Bot Alerts**: Instant rich markdown messages.
   - **🎮 Discord Webhook & 💼 Slack / MS Teams Webhooks**: Color-coded embed cards.
   - **🔔 Web Audio Synthesizer Alarm**: Real-time audible alarm on the browser dashboard.

2. **Dual FortiGate Monitoring Modes**:
   - **REST API Polling**: Pulls SD-WAN Performance SLA metrics (`/api/v2/monitor/virtual-wan/sla`) and interface health (`/api/v2/monitor/system/interface`) directly from FortiOS.
   - **FortiGate Webhook Receiver**: Ingests real-time events triggered by FortiOS Automation Stitches (log ID `0100022922`).
   - **Local ICMP Ping Prober**: Direct secondary validation to public DNS (8.8.8.8, 1.1.1.1) or gateway IPs.

3. **24/7 Service Persistence Across Restarts**:
   - Includes `register-service.ps1` to register as a 24/7 Windows background task (`NT AUTHORITY\SYSTEM`).
   - Starts automatically at machine boot (`AtStartup`) before any user logs in.
   - Auto-recovery: restarts within 1 minute if interrupted or terminated.
   - Firewall automation: automatically allows port 4000 inbound.

4. **Modern NOC Web Dashboard**:
   - Side-by-side WAN1 & WAN2 live status cards with carrier state, latency, packet loss, jitter, and throughput.
   - Real-time rolling canvas charts for Latency and Packet Loss with threshold reference lines.
   - Degradation incident audit log with peak metrics and duration.
   - Built-in Interactive Simulation Toolbar to test alerts immediately.

5. **Zero External Dependencies**:
   - Built entirely with modern Node 24 native standard modules (`node:http`, `node:net`, `node:tls`, `node:sqlite`, `node:child_process`, `node:fs`).
   - Runs out of the box with zero `npm install` needed.

---

## Quick Start

### 1. Launch the Application Locally

Double-click `start.bat` (or run in PowerShell / Command Prompt):
```bat
start.bat
```
Or directly with Node:
```powershell
node server.js
```

Open your browser at:
👉 **[http://localhost:4000](http://localhost:4000)**

---

## 24/7 Persistent Background Service (Windows Server / Desktop)

To run the application continuously across reboots and user logoffs:

1. Open **PowerShell as Administrator** in the project directory.
2. Run:
   ```powershell
   Set-ExecutionPolicy Bypass -Scope Process -Force
   .\register-service.ps1
   ```
3. To stop or remove the service later, run:
   ```powershell
   .\uninstall-service.ps1
   ```

---

## Configuring Notification Channels

Open the dashboard at `http://localhost:4000` and click **⚙️ Settings & Alerts > Notifications & Alerts**:

### 1. WhatsApp Notifications (CallMeBot - 30-Second Setup)
1. Add the CallMeBot phone number `+34 941 070 000` to your phone contacts.
2. Send the following WhatsApp message to that number:
   `I allow callmebot to send me messages`
3. CallMeBot will reply immediately with your **apikey**.
4. In the monitor settings:
   - Check **WhatsApp Instant Notifications**.
   - Provider: **CallMeBot**.
   - Phone: Your phone number with international country code (e.g. `+1234567890`).
   - API Key: The key provided by CallMeBot.
   - Click **Send Test WhatsApp** to verify!

*(Twilio for WhatsApp and custom webhooks are also supported in the dropdown)*.

### 2. Email Alerts (SMTP)
1. Check **Email Alerts (SMTP)**.
2. Enter your SMTP Host (e.g., `smtp.office365.com` or `smtp.gmail.com`).
3. Port: `587` (STARTTLS) or `465` (SSL).
4. Enter SMTP Username & Password (for Gmail/O365, use an App Password).
5. From: `wan-monitor@yourdomain.com`, To: `noc-team@yourdomain.com`.
6. Click **Send Test Email** to verify!

---

## FortiGate Tuning: Stop User Disconnections During Failover

If your users experience disconnects whenever one link degrades, run these commands in the FortiOS CLI:

```fortios
# 1. Immediate TCP Session Reset on SLA Failover
config system sdwan
    config service
        edit 1
            set name "Internet-Traffic"
            set service-reset enable
        next
    end
end

# 2. Enable SNAT Route Change
config system interface
    edit "wan1"
        set snat-route-change enable
    next
    edit "wan2"
        set snat-route-change enable
    next
end

# 3. High-Sensitivity Performance SLA (1.5s detection)
config system sdwan
    config health-check
        edit "Default_DNS"
            set server "8.8.8.8" "1.1.1.1"
            set interval 500
            set failtime 3
            set recoverytime 5
            config sla
                edit 1
                    set latency-threshold 120
                    set jitter-threshold 25
                    set packetloss-threshold 2
                next
            end
        next
    end
end
```

---

## Directory Structure

```
fortigate-wan-monitor/
├── config.js              # Thresholds, FortiGate & notification defaults
├── db.js                  # Native SQLite persistence (node:sqlite)
├── fortigate-client.js    # FortiOS REST API client
├── smtp-client.js         # Native zero-dependency SMTP client (STARTTLS & SSL)
├── whatsapp-client.js     # WhatsApp client (CallMeBot / Twilio / Webhook)
├── alert-manager.js       # Multi-channel alert dispatcher
├── probe-engine.js        # ICMP probing & degradation simulation engine
├── server.js              # HTTP server, REST API, SSE live broadcast, & webhook receiver
├── register-service.ps1   # Installs 24/7 persistent background service on Windows
├── uninstall-service.ps1  # Uninstalls the persistent background service
├── package-app.ps1        # Bundles migration zip file
├── start.bat & start.ps1  # Quick launch scripts
├── tests/
│   └── test-monitor.js    # Automated unit & integration tests (node:test)
└── public/
    ├── index.html         # Responsive NOC monitoring dashboard
    ├── style.css          # Dark NOC theme stylesheet
    └── app.js             # Canvas charts, Web Audio alarms, & SSE logic
```
