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
- **Monitoring PC**: an always-on 64-bit Windows 10/11 or Windows Server 2016+ machine on the LAN with a fixed IP. The installer takes care of Node.js. Linux and macOS also work (see [Linux / macOS](#linux--macos)).
- **Network**: PC → FortiGate HTTPS admin port; PC → internet for installation and alerts; FortiGate → PC on the monitor's port only if you use the optional webhook.

The app's built-in **❓ Help** page (`http://localhost:4000/help.html`) has the full requirements list and a step-by-step FortiGate setup.

---

## Quick start (Windows)

1. Download this repository (**Code → Download ZIP**) and extract it on the monitoring PC.
2. Double-click **`Install.cmd`** and approve the **UAC prompt**.
3. When the installer finishes, open **http://localhost:4000/help.html#connect** and follow the FortiGate connection steps.

That's it: Node.js is installed automatically if needed, and the monitor runs in the background from then on, including after reboots. The [Deployment guide](#deployment-guide) below covers every option.

---

## Deployment guide

### What the installer does

`Install.cmd` runs `install.ps1`, which:

1. **Requests administrator rights once** through the Windows UAC prompt, then re-launches itself elevated (and as 64-bit PowerShell if needed). If you decline, nothing is changed.
2. **Checks the PC**: 64-bit Windows 10 / Server 2016 or newer, PowerShell 5.1+, at least 500 MB free disk space.
3. **Installs Node.js if needed.** If `C:\Program Files\nodejs\node.exe` is missing or older than 22.13, it looks up the newest Node.js LTS on nodejs.org and downloads the MSI for your CPU (x64 or ARM64). It then verifies the file against nodejs.org's published SHA-256 checksum *and* its digital signature, and installs it silently (`msiexec /qn`, no wizard, no reboot). If nodejs.org can't be reached it falls back to `winget`. The app itself has no other dependencies.
4. **Gets the application files**, either from the folder it's run from or, with `-FromGitHub`, by downloading the repository from GitHub.
5. **Stops a previous installation** (if any), then copies the app to `C:\Program Files\FortiGate WAN Monitor`.
6. **Creates the data folder** `C:\ProgramData\FortiGate WAN Monitor` and restricts it to Administrators and SYSTEM, because the database contains your FortiGate API token and alert credentials. A database from an older, in-place installation is imported automatically.
7. **Applies options** such as the port and dashboard password.
8. **Opens the Windows Firewall** for the monitor's port.
9. **Registers the background task** `FortiGate-WAN-Monitor`: starts at boot (before anyone logs in), runs as SYSTEM, and restarts every minute if it stops.
10. **Adds Start-menu shortcuts** for the dashboard and Help, **starts the monitor** and **checks it is listening** before reporting success.

Everything is logged to `C:\ProgramData\FortiGate WAN Monitor\install.log`.

> **Why Program Files and ProgramData?** The monitor runs as SYSTEM. Running code from a folder that ordinary users can modify would let any user take over the PC. The installer therefore only uses the machine-wide Node.js in `C:\Program Files\nodejs`, never a per-user copy.

### Before you start

- [ ] An **always-on PC** that stays on the LAN (a small server or VM is ideal), with a **fixed IP address** (DHCP reservation or static). The FortiGate's trusted-host setting and the optional webhook point at it.
- [ ] An account that can approve **UAC** (local administrator), or a deployment tool that runs as SYSTEM.
- [ ] **Internet access during installation** to `nodejs.org` (Node.js download) and, if you use `-FromGitHub`, `codeload.github.com` and `raw.githubusercontent.com`. Behind a proxy, add `-Proxy`. Without internet access, see [Offline installation](#method-d-offline-pc).
- [ ] **Your FortiGate prepared** (SD-WAN health check, read-only REST API admin with this PC's IP as trusted host). You can also do this after installing; the Help page walks you through it.

### Method A: Interactive install from the ZIP (recommended)

1. On the monitoring PC, download the ZIP from GitHub (**Code → Download ZIP**), or use a package built with `package-app.ps1`.
2. Right-click the ZIP → **Properties** → tick **Unblock** → **OK**. This stops Windows showing a security warning for each extracted file.
3. Extract it anywhere, for example `C:\Temp\fortigate-wan-monitor`. The installer copies what it needs, so you can delete this folder afterwards (keep it if you want `Uninstall.cmd` handy).
4. Double-click **`Install.cmd`**, then click **Yes** on the UAC prompt.
5. Wait for **"FortiGate WAN Monitor is installed"**. The window lists the dashboard address, the setup guide and the admin commands. Press Enter to close it.

To set the dashboard password (needed for access from other PCs) or choose a port during installation, run it from a command prompt instead:

```bat
Install.cmd -PromptForPassword -Port 5000
```

### Method B: Download and install straight from GitHub

In a normal (non-admin) PowerShell window on the monitoring PC:

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$f = "$env:TEMP\install-wanmon.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/mzuogha/Fortigate-WAN-Monitor/main/install.ps1 -UseBasicParsing -OutFile $f
powershell -NoProfile -ExecutionPolicy Bypass -File $f -FromGitHub
```

The script asks for UAC, downloads the latest code from the `main` branch, installs Node.js if needed, and installs the monitor. Use `-Branch <name>` to install a different branch.

### Method C: Unattended / mass deployment (RMM, Intune, GPO, PDQ, SCCM)

Deployment tools run scripts as **SYSTEM**, which is already elevated, so **no UAC prompt appears**. Use `-Silent` so the installer never waits for input:

```bat
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "install.ps1" -Silent
```

or, without copying any files to the PC first:

```bat
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $f=\"$env:TEMP\install-wanmon.ps1\"; iwr https://raw.githubusercontent.com/mzuogha/Fortigate-WAN-Monitor/main/install.ps1 -UseBasicParsing -OutFile $f; & $f -FromGitHub -Silent"
```

| Tool | Setting |
|---|---|
| **Exit codes** | `0` success · `1` failed (see `install.log`) · `1223` UAC declined (interactive only) |
| **Intune (Win32 app)** | Install: the command above · Uninstall: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -Silent` · Detection: file exists `C:\Program Files\FortiGate WAN Monitor\server.js` · Install behaviour: System |
| **Group Policy** | Computer Configuration → Policies → Windows Settings → Scripts → **Startup** (runs as SYSTEM) |
| **RMM / PDQ / SCCM** | Run as SYSTEM / Local System, with the command above |

To set the dashboard password unattended, pass it as a secure string from an elevated wrapper script (it is never written to the command line):

```powershell
$pw = ConvertTo-SecureString $env:WANMON_PASSWORD -AsPlainText -Force
& .\install.ps1 -Silent -DashboardPassword $pw
```

Or leave it unset and set it later with `wanmon.cmd --set-password`.

### Method D: Offline PC

1. On a PC with internet access, download the Node.js **LTS Windows Installer (.msi)** for 64-bit from <https://nodejs.org/en/download> (version 22.13 or newer).
2. Copy it next to the extracted app on the offline PC (optionally bundle both with `.\package-app.ps1 -IncludeNodeMsi <path-to-msi>`).
3. Install with:

```bat
Install.cmd -NodeMsi .\node-v24.11.1-x64.msi
```

The MSI's digital signature is still verified. The monitor still needs internet access afterwards to send Telegram, WhatsApp, Teams, Slack or Discord alerts; email through an internal SMTP relay works fully offline.

### Behind a proxy

```bat
Install.cmd -Proxy http://proxy.company.local:8080
```

Downloads use your Windows credentials for the proxy. The monitor's own outgoing alert traffic uses the system's network settings.

### Installer options

| Option | Default | Description |
|---|---|---|
| `-Port <n>` | keep current (4000 on a new install) | Listening port for the dashboard and webhook |
| `-PromptForPassword` | off | Ask for a dashboard password during installation (enables remote access) |
| `-DashboardPassword <SecureString>` | — | Set the password unattended (only from an already-elevated script) |
| `-FromGitHub` | off | Download the app from GitHub instead of using the local folder |
| `-Branch <name>` / `-Repository <owner/name>` | `main` / `mzuogha/Fortigate-WAN-Monitor` | Source for `-FromGitHub` |
| `-NodeVersion <x.y.z>` | newest LTS | Install a specific Node.js version |
| `-NodeMsi <path>` | — | Use a pre-downloaded Node.js MSI (offline) |
| `-Proxy <url>` | — | HTTP proxy for downloads |
| `-FirewallRemoteAddress <addr>` | `Any` | Limit who can reach the port, e.g. `LocalSubnet` or `192.168.1.0/24` (the FortiGate must be included if you use the webhook) |
| `-NoFirewall` | off | Don't create a firewall rule (dashboard reachable from this PC only) |
| `-InstallDir <path>` | `C:\Program Files\FortiGate WAN Monitor` | Program folder |
| `-DataDir <path>` | `C:\ProgramData\FortiGate WAN Monitor` | Settings, history and logs |
| `-NoStart` | off | Install but start only at next boot |
| `-Silent` | off | No prompts and no "Press Enter" (for unattended use) |

Run `Get-Help .\install.ps1 -Full` for the same information in PowerShell.

### What gets installed where

| Item | Location |
|---|---|
| Program files | `C:\Program Files\FortiGate WAN Monitor\` |
| Admin helper | `C:\Program Files\FortiGate WAN Monitor\wanmon.cmd` |
| Settings and history (database) | `C:\ProgramData\FortiGate WAN Monitor\monitor.db` (Administrators and SYSTEM only) |
| Monitor log (rotated at 5 MB) | `C:\ProgramData\FortiGate WAN Monitor\monitor.log` |
| Installer log | `C:\ProgramData\FortiGate WAN Monitor\install.log` (Node.js MSI log: `nodejs-install.log`) |
| Node.js runtime | `C:\Program Files\nodejs\` |
| Background task | Task Scheduler → `FortiGate-WAN-Monitor` (SYSTEM, at startup, restart on failure) |
| Firewall rule | `FortiGate WAN Monitor (Port 4000)` |
| Shortcuts | Start menu → *FortiGate WAN Monitor* and *FortiGate WAN Monitor Help* |

### After installation: first-time setup

1. Open **Start → FortiGate WAN Monitor Help** (or `http://localhost:4000/help.html#connect`).
2. Prepare the FortiGate if you haven't: SD-WAN health check with both links, read-only admin profile, REST API admin with this PC's IP as trusted host. The guide gives GUI and CLI steps.
3. On the dashboard, open **⚙️ Settings & Alerts → FortiGate API**. Enter the FortiGate address, API key, interface names and health check, then **Test FortiGate Connection** and **Save**.
4. Make sure **Simulate WAN Traffic** is **off**. Both link cards should show live numbers within seconds.
5. Configure at least one alert channel under **Notifications & Alerts** and press its **Test** button.
6. Optional: enable **Daily Reports**, set display names for the links, and set up the FortiGate webhook.
7. To use the dashboard from other PCs, set a password (Administrator command prompt):

   ```bat
   "C:\Program Files\FortiGate WAN Monitor\wanmon.cmd" --set-password
   "C:\Program Files\FortiGate WAN Monitor\wanmon.cmd" restart
   ```

   Then browse to `http://<monitoring-pc-ip>:4000` and sign in as `admin`.

### Check that it's working

- `wanmon.cmd status` should show the task as **Running**.
- `wanmon.cmd logs` follows the log; you should see the startup banner and no repeated errors.
- The dashboard's top bar should show **FortiGate: Online**.
- **Reboot test:** restart the PC and, without logging in, open the dashboard from another PC. It should be up within a minute of Windows starting.

### Day-to-day administration

From an **Administrator** command prompt in `C:\Program Files\FortiGate WAN Monitor`:

| Command | Purpose |
|---|---|
| `wanmon.cmd status` | Is the background task running? |
| `wanmon.cmd restart` / `stop` / `start` | Control the monitor |
| `wanmon.cmd logs` | Follow the log (Ctrl+C to stop) |
| `wanmon.cmd --set-password` | Set or change the dashboard password (then `restart`) |
| `wanmon.cmd --set-port 5000` | Change the port (easier: Settings → Server) |
| `wanmon.cmd --show-webhook-token` | Print the FortiGate webhook token |

### Upgrading

Run the installer from the newer version (**`Install.cmd`**, or `install.ps1 -FromGitHub`). It stops the monitor, replaces the program files, upgrades Node.js if the new version needs it, and starts the monitor again. **Settings, history and the webhook token are kept.**

**Upgrading from v1** (the old `register-service.ps1` / run-in-place setup): just run the new `Install.cmd`. It replaces the old background task and imports the old `monitor.db`. Then note the [v1 upgrade changes](#upgrading-from-v1) below; in particular, update the FortiGate webhook URL to include the token.

### Backup, restore and moving to another PC

Everything that matters is in the data folder.

1. `wanmon.cmd stop`
2. Copy `C:\ProgramData\FortiGate WAN Monitor\` somewhere safe. **It contains credentials**, so store it like a password.
3. `wanmon.cmd start`

To restore or move: install on the new PC, `wanmon.cmd stop`, copy the folder back, `wanmon.cmd start`. If the PC's IP changed, update the REST API admin's trusted host on the FortiGate and the webhook URL.

### Uninstalling

Double-click **`Uninstall.cmd`** (in the extracted folder) and approve UAC. This removes the task, firewall rule, shortcuts and program files. Settings and history are kept for a future re-install unless you run:

```bat
Uninstall.cmd -RemoveData
```

Node.js is left installed because other software may use it; remove it from **Settings → Apps** if you don't need it.

### Troubleshooting installation

| Problem | Fix |
|---|---|
| Nothing happens / window closes immediately | Run `Install.cmd` from a command prompt to see the message, and check `C:\ProgramData\FortiGate WAN Monitor\install.log`. |
| "Setup cancelled: administrator permission was not granted" (exit 1223) | Click **Yes** on the UAC prompt, or sign in with an administrator account. |
| "Windows protected your PC" / security warning on each file | Unblock the ZIP before extracting (Properties → Unblock), or click **Run**. |
| "Could not install Node.js" / download failed | Check access to `nodejs.org` (firewall, web filter, SSL inspection). Use `-Proxy`, or install offline with `-NodeMsi`. |
| "Checksum mismatch" or "signature is not valid" | The download was altered (often by a proxy or SSL inspection). Download the MSI manually from nodejs.org and use `-NodeMsi`. |
| Node.js MSI error | See `nodejs-install.log` in the data folder. Error 1618 (another installation running) is retried automatically for a few minutes. |
| "did not start listening on port …" | Another program may be using the port: reinstall with `-Port <other>`. The reason is in `monitor.log`. |
| "already exists and does not look like a FortiGate WAN Monitor installation" | `-InstallDir` points to a folder with other files; choose an empty or new folder. |
| Dashboard works on the PC but not from others | Set a dashboard password, check the firewall rule (and `-FirewallRemoteAddress`), and any network firewall between you and the PC. |
| Antivirus quarantines the scripts | Allow `install.ps1` / the program folder; the scripts are plain text you can review. |

### Linux / macOS

Install Node.js 22.13+ from your package manager or nodejs.org, copy the app to e.g. `/opt/wanmon`, and run it as a service. Example systemd unit (`/etc/systemd/system/wanmon.service`):

```ini
[Unit]
Description=FortiGate WAN Monitor
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/wanmon/server.js --data-dir /var/lib/wanmon
Restart=always
RestartSec=10
User=wanmon

[Install]
WantedBy=multi-user.target
```

Create the service account and data folder first (`sudo useradd -r -s /usr/sbin/nologin wanmon && sudo install -d -o wanmon -m 700 /var/lib/wanmon`), then `sudo systemctl enable --now wanmon`. Set a password with `sudo -u wanmon node /opt/wanmon/server.js --data-dir /var/lib/wanmon --set-password` and `sudo systemctl restart wanmon`.

---

## Daily reports

- **On demand**: click **📊 Reports**, pick a date, then *Generate*, *Open full report* (print or save as PDF), *Download CSV*, or *Send now*.
- **Automatic**: **Settings → Daily Reports**, enable and choose a time. Every day after that time, yesterday's report is sent through all enabled channels (email gets the full report, chat channels get a summary). Days without data are skipped.
- **API**: `GET /api/reports/daily?date=YYYY-MM-DD&format=json|html|csv`

History is kept for 14 days by default (`METRIC_RETENTION_DAYS`); incidents are kept for a year.

---

## Changing the port

**Settings → Server & 24/7 Service → Web server port → Apply port.** The monitor starts listening on the new port before closing the old one, and the dashboard reloads at the new address. On Windows, the firewall rule is updated automatically when the monitor runs as the service. Remember to update the FortiGate webhook URL if you use it.

Alternatives: `wanmon.cmd --set-port 5000` (then `wanmon.cmd restart`), `Install.cmd -Port 5000`, or the `PORT` environment variable (which overrides the setting).

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

CLI (`node server.js …` or `wanmon.cmd …` on installed copies): `--set-password`, `--set-port <n>`, `--get-port`, `--show-webhook-token`, `--data-dir <folder>`.

Data location: `DB_PATH` > `WANMON_DATA_DIR` / `--data-dir` > the installer's `install.json` > the app folder.

---

## Upgrading from v1

- **Simulation is now off by default.** v1 started in simulation mode, so a fresh install showed fake data.
- **Remote dashboard access now requires a password** (`wanmon.cmd --set-password`). Localhost works without one.
- **Installation is now done by `Install.cmd`** (Program Files + ProgramData, Node.js installed automatically). `register-service.ps1` still works and simply runs the new installer.
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
├── Install.cmd            Double-click installer (runs install.ps1, asks for UAC once)
├── install.ps1            Installs Node.js if needed, the app, data folder, firewall rule and task
├── Uninstall.cmd          Double-click uninstaller (runs uninstall.ps1)
├── uninstall.ps1          Removes task, firewall rule, shortcuts and program files
├── package-app.ps1        Builds a ZIP for copying to another PC (optionally with a Node.js MSI)
├── register-service.ps1   Compatibility wrapper for install.ps1
├── uninstall-service.ps1  Compatibility wrapper for uninstall.ps1
├── tests/                 node:test suites
└── public/                Dashboard (index.html, app.js, style.css) and Help (help.html, help.js)
```
