# FortiGate Dual-WAN Link Monitor & Failover Guard

Monitors both WAN links of a FortiGate in real time, alerts you the moment one degrades or goes down (and when it recovers), and produces daily availability reports you can hold your ISPs to.

It reads the FortiGate's own **SD-WAN Performance SLA** results through the REST API, so latency, jitter and packet loss are measured **per link**, which pings from a PC behind a load-balanced firewall cannot do.

---

## Features

- **Per-link health from the FortiGate**: SLA probe status, latency, jitter, packet loss, physical link state and throughput for each WAN interface.
- **Smart alerting**: a problem must persist before you're alerted and the link must be stable before it's declared recovered, so flapping links don't flood you. Escalations (e.g. degraded → down), recoveries and reminders while a link stays bad are all notified.
- **Context in every alert**: each message shows the other link's state, e.g. *"running on a single link"* or *"TOTAL OUTAGE: all WAN links are down"*.
- **Alerts survive outages**: if alerts can't be sent (typically because both links are down), they're queued and delivered when connectivity returns, marked as delayed.
- **Channels**: Email (SMTP), WhatsApp (CallMeBot / Twilio / webhook), Telegram, Microsoft Teams (Workflows), Slack, Discord, Windows toast, and an audible alarm on the dashboard.
- **Daily reports**: availability, outages, down time, degraded time, latency (avg / p95 / max), loss, and how long the site had no internet at all. View any day on demand, open as HTML (print / save as PDF), download as CSV, or have yesterday's report sent automatically each morning.
- **Live dashboard** with rolling charts and an incident log.
- **Built-in Help** (`/help.html`): requirements, step-by-step FortiGate connection guide filled in with your own values, webhook setup, failover tuning and troubleshooting.
- **Zero dependencies**: Node.js standard library only; no `npm install`.

---

## Requirements

- **FortiGate**: FortiOS 6.4+ with **SD-WAN** enabled, both WAN interfaces as members of a **Performance SLA (health check)**, and a read-only **REST API admin**.
- **Monitoring server**: an always-on machine on the LAN (Windows 10/11 / Server 2016+, Linux or macOS) with **Node.js 22.13 or newer** (24 LTS recommended) and a fixed IP.
- **Network**: server → FortiGate HTTPS admin port; server → internet for alerts; FortiGate → server on the monitor's port only if you use the optional webhook.

Full details and the step-by-step FortiGate setup are in the app: **❓ Help** (or `http://localhost:4000/help.html`).

---

## Quick start

```powershell
node server.js          # or double-click start.bat
```

1. Open **http://localhost:4000** on the server.
2. Click **❓ Help → Connect to your FortiGate** and follow the steps (read-only API admin, trusted host, health check).
3. Enter the details under **⚙️ Settings & Alerts → FortiGate API**, click **Test FortiGate Connection**, then **Save**.
4. Configure at least one channel under **Notifications & Alerts** and use its **Test** button.
5. Make sure **Simulate WAN Traffic** is **off**.

### Remote access

Until a password is set, the dashboard only works on the server itself. To allow access from other PCs:

```powershell
node server.js --set-password
```

Then restart the monitor and sign in as `admin`.

### Run 24/7 on Windows

In an **Administrator** PowerShell in the app folder:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
.\register-service.ps1              # optional: -Port 5000
```

This registers a startup task (runs before login, restarts on failure) and a firewall rule for the monitor's port. Remove it with `.\uninstall-service.ps1`.

Windows toast notifications are not visible while running as a background service; use email, Telegram, WhatsApp or Teams for 24/7 alerting.

---

## Daily reports

- **On demand**: click **📊 Reports**, pick a date, then *Generate*, *Open full report* (print or save as PDF), *Download CSV*, or *Send now*.
- **Automatic**: **Settings → Daily Reports**, enable and choose a time. Every day after that time, yesterday's report is sent through all enabled channels (email gets the full report, chat channels get a summary). Days without data are skipped.
- **API**: `GET /api/reports/daily?date=YYYY-MM-DD&format=json|html|csv`

History is kept for 14 days by default (`METRIC_RETENTION_DAYS`); incidents are kept for a year.

---

## Changing the port

**Settings → Server & 24/7 Service → Web server port → Apply port.** The monitor starts listening on the new port before closing the old one, and the dashboard reloads at the new address. On Windows, the firewall rule is updated automatically when the monitor runs as the service. Remember to update the FortiGate webhook URL if you use it.

Alternatives: `node server.js --set-port 5000`, `.\register-service.ps1 -Port 5000`, or the `PORT` environment variable (which overrides the setting).

---

## Optional: FortiGate webhook

Polling detects everything on its own. A FortiGate Automation Stitch can additionally push SD-WAN events instantly. The webhook URL, including its secret token, is shown under **Settings → FortiGate API**, and setup steps are in **Help → Real-time webhook**. Requests without the token are rejected.

---

## Configuration reference

Most settings are changed in the dashboard and stored in `monitor.db`. Environment variables (see `config.js`) override them:

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | Listening port / address (default 4000, all interfaces) |
| `FORTIGATE_HOST`, `FORTIGATE_API_TOKEN`, `FORTIGATE_VDOM` | FortiGate connection |
| `FORTIGATE_VERIFY_TLS=true` | Verify the FortiGate certificate (default off, for self-signed certs) |
| `WAN1_INTERFACE`, `WAN2_INTERFACE`, `WAN1_LABEL`, `WAN2_LABEL` | Interface names and display names |
| `POLL_INTERVAL_MS` | Poll interval (default 5000) |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | Dashboard login (alternative to `--set-password`) |
| `WEBHOOK_TOKEN` | Fixed webhook token (otherwise generated on first run) |
| `DAILY_REPORT=true`, `DAILY_REPORT_TIME=07:00` | Automatic daily report |
| `SIMULATION=true` | Start in simulation mode (demo data) |
| `DB_PATH`, `METRIC_RETENTION_DAYS` | Database location and history length |

CLI: `--set-password`, `--set-port <n>`, `--get-port`, `--show-webhook-token`.

---

## Upgrading from v1

- **Simulation is now off by default.** v1 started in simulation mode, so a fresh install showed fake data.
- **Remote dashboard access now requires a password** (`node server.js --set-password`). Localhost works without one.
- **The FortiGate webhook now requires the token** shown in Settings. Update your Automation Stitch URL.
- **Microsoft Teams has its own channel.** Teams Workflows webhooks do not accept the Slack payload.
- **Node.js 22.13+** is required (built-in SQLite).
- The v1 local-ping fallback was removed: pinging 8.8.8.8 and 1.1.1.1 from the PC cannot measure WAN1 and WAN2 separately and produced misleading per-link numbers. If the FortiGate is unreachable, the dashboard now says so and you get an alert.

---

## Development

```bash
npm test        # node --test: 33 unit and integration tests (mock FortiGate + mock SMTP server)
```

```
├── server.js              HTTP server, REST API, SSE feed, auth, webhook, polling, scheduler
├── config.js              Defaults and environment variables
├── fortigate-client.js    FortiOS REST API client (SD-WAN health-check + interfaces)
├── alert-manager.js       Link state machine (hysteresis) and alert dispatch/retry queue
├── report-generator.js    Daily report calculation and HTML / text / CSV rendering
├── db.js                  SQLite persistence (node:sqlite)
├── smtp-client.js         Zero-dependency SMTP client (STARTTLS / TLS, AUTH LOGIN)
├── whatsapp-client.js     CallMeBot / Twilio / webhook
├── probe-engine.js        Simulation engine for demos and alert testing
├── register-service.ps1   Install as a 24/7 Windows background task
├── uninstall-service.ps1  Remove the background task and firewall rule
├── tests/                 node:test suites
└── public/                Dashboard (index.html, app.js, style.css) and Help (help.html, help.js)
```
