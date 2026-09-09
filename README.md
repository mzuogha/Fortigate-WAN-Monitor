# FortiGate Dual-WAN Link Monitor & Failover Guard

A standalone, real-time network monitoring application that continuously monitors both WAN links on a FortiGate firewall, detects service degradation (packet loss, latency spikes, jitter, link flaps, or hard drops) before users feel the outage, and delivers instant alerts across multiple notification channels.

---

## Key Features

1. **Dual FortiGate Monitoring Modes**:
   - **REST API Polling**: Pulls SD-WAN Performance SLA metrics (`/api/v2/monitor/virtual-wan/sla`) and interface health (`/api/v2/monitor/system/interface`) directly from FortiOS.
   - **FortiGate Webhook Receiver**: Ingests real-time events triggered by FortiOS Automation Stitches (log ID `0100022922`).
   - **Local ICMP Ping Prober**: Direct secondary validation to public DNS (8.8.8.8, 1.1.1.1) or gateway IPs.

2. **Early Degradation Detection**:
   - Detects packet loss, latency spikes, and high jitter with customizable Warning and Critical thresholds.
   - Anti-flapping detection and hysteresis (requires consecutive clean samples before declaring recovery).
   - Automated degradation incident audit trail persisted in SQLite.

3. **Multi-Channel Instant Notifications**:
   - **Windows Native Desktop Notifications** (Action Center toast via PowerShell WinRT).
   - **Telegram Bot** alerts with markdown cards.
   - **Discord Webhook** alerts with color-coded severity embeds.
   - **Slack / MS Teams** incoming webhooks.
   - **Browser Web Audio Alarm** on the dashboard.

4. **Modern NOC Web Dashboard**:
   - Side-by-side WAN1 & WAN2 live status cards with carrier state, latency, packet loss, jitter, and throughput.
   - Real-time rolling canvas charts for Latency and Packet Loss with threshold reference lines.
   - Degradation incident audit log.
   - Built-in Interactive Simulation Toolbar to test alerts and degradation scenarios immediately.

5. **Zero External Dependencies**:
   - Built entirely with modern Node 24 native standard modules (`node:http`, `node:sqlite`, `node:child_process`, `node:fs`).
   - Runs out of the box with zero `npm install` needed.

---

## Quick Start

### 1. Launch the Application

Double-click `start.bat` (or run in PowerShell / Command Prompt):
```bat
start.bat
```
Or directly with the installed Node runtime:
```powershell
agy-node.cmd server.js
```

Open your browser at:
👉 **[http://localhost:4000](http://localhost:4000)**

---

## Connecting to Your FortiGate Firewall

### Step 1: Create a REST API Administrator Token on FortiGate
1. Log in to your FortiGate Web GUI.
2. Go to **System > Administrators > Create New > REST API Admin**.
3. Set **Username** to `wan-monitor-admin`.
4. Create or assign an Admin Profile with **Read-Only** access to:
   - `Router` (SD-WAN / SLA monitoring)
   - `Network` (Interface statistics)
5. Under **PKI Group**, leave disabled.
6. Click **Save**. FortiOS will display your **API Token**. Copy it.

### Step 2: Configure in the Web Dashboard
1. Open the dashboard at `http://localhost:4000`.
2. Click **⚙️ Settings & Alerts** in the top right.
3. In the **FortiGate API** tab:
   - Enter your FortiGate IP (e.g., `https://192.168.1.1`).
   - Paste your API Token.
   - Set WAN interface names (default: `wan1` and `wan2`).
   - Set Health Check Name (default: `Default_DNS`).
4. Click **Test FortiGate Connection** to verify.
5. In the top toolbar, toggle off "Simulate WAN Traffic" to switch to live FortiGate telemetry.

---

## FortiGate Tuning: Stop User Disconnections During Failover

If your users experience disconnects whenever one link degrades, run these commands in the FortiOS CLI:

### 1. Enable Immediate Session Reset on SLA Failover
Forces TCP RST to clients so web browsers, VPNs, and applications reconnect instantly via the healthy link instead of freezing:
```fortios
config system sdwan
    config service
        edit 1
            set name "Internet-Traffic"
            set service-reset enable
        next
    end
end
```

### 2. Enable SNAT Route Change
Ensures active NAT sessions gracefully switch to the second WAN IP:
```fortios
config system interface
    edit "wan1"
        set snat-route-change enable
    next
    edit "wan2"
        set snat-route-change enable
    next
end
```

### 3. Fine-Tune Performance SLA Sensitivity
Shortens the failover detection window to under 1.5 seconds:
```fortios
config system sdwan
    config health-check
        edit "Default_DNS"
            set server "8.8.8.8" "1.1.1.1"
            set interval 500       # Probe every 500ms
            set failtime 3         # Declare fail after 3 consecutive misses (1.5s)
            set recoverytime 5     # Require 5 clean probes to recover
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

### 4. Direct FortiGate Webhook into this App
In FortiGate GUI under **Security Fabric > Automation > Create Stitch**:
- **Trigger:** FortiOS Event Log -> Event ID `0100022922` (SD-WAN SLA status change).
- **Action:** Webhook -> URL: `http://<this-machine-ip>:4000/api/webhook/fortigate`.

---

## Directory Structure

```
fortigate-wan-monitor/
├── config.js              # Default thresholds, FortiGate & notification configs
├── db.js                  # Native SQLite persistence (node:sqlite)
├── fortigate-client.js    # FortiOS REST API client
├── probe-engine.js        # ICMP probing & degradation simulation engine
├── alert-manager.js       # Threshold evaluator, state transitions & multi-channel alerts
├── server.js              # HTTP server, REST API, SSE live broadcast, and webhook receiver
├── start.bat              # One-click Windows launch batch file
├── start.ps1              # PowerShell launch script
├── tests/
│   └── test-monitor.js    # Automated unit & integration tests (node:test)
└── public/
    ├── index.html         # Responsive NOC monitoring dashboard
    ├── style.css          # Dark NOC theme stylesheet
    └── app.js             # Canvas charts, Web Audio alarms, SSE receiver
```
