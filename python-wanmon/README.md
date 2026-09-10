# wanmon — FortiGate WAN link monitor

wanmon polls your FortiGate every few seconds, reads the SD-WAN Performance SLA results (latency, jitter, packet loss and probe status) plus the physical interface state for each WAN link, and alerts you when a link becomes **DEGRADED**, goes **DOWN**, or **RECOVERS**. Every alert also shows the state of the other link, so you immediately know whether you are running on a single link or have lost internet completely. All measurements are stored in SQLite so you can produce availability reports to hold your ISPs accountable.

## 1. Prepare the FortiGate

### 1a. Make sure SD-WAN has a Performance SLA (this also fixes the user impact)

wanmon reads the SD-WAN health-check data, and the same health check is what lets the FortiGate pull a dead link out of the load-balancing pool. If users are hit every time one link fails, the usual cause is that the FortiGate does not *know* the link has failed: the interface stays physically up while the ISP upstream is broken, so half the sessions keep going into a black hole. A health check with `update-static-route enable` fixes that.

```
config system sdwan
    config health-check
        edit "WAN_SLA"
            set server "8.8.8.8" "1.1.1.1"
            set protocol ping
            set interval 1000
            set failtime 3
            set recoverytime 5
            set members 1 2          # seq-num of your SD-WAN members (see: show system sdwan)
            set update-static-route enable
            config sla
                edit 1
                    set latency-threshold 150
                    set jitter-threshold 30
                    set packetloss-threshold 3
                next
            end
        next
    end
end
```

In the GUI this is **Network > SD-WAN > Performance SLAs**. If you already have one, just note its exact name for `config.yaml`. You can also reference the SLA in your SD-WAN rules so traffic is steered away from a link that is merely degraded, not only one that is dead.

> If you are *not* using SD-WAN (for example two ECMP default static routes), wanmon will report "no SD-WAN health-check data". Either move the links into SD-WAN (recommended) or adapt the collector to `/api/v2/monitor/system/link-monitor`.

### 1b. Create a read-only REST API admin

1. **System > Admin Profiles > Create New**: name it `wanmon_ro`, set everything to **Read** (at minimum System and Network). No write access is needed.
2. **System > Administrators > Create New > REST API Admin**: name `wanmon`, profile `wanmon_ro`, and under **Trusted Hosts** enter only the IP of the machine that will run wanmon (e.g. `192.168.1.50/32`).
3. Copy the generated API key. It is shown only once.

## 2. Install

Any always-on machine on the LAN works (a small Linux VM, a Windows server, even a Raspberry Pi). Python 3.8+.

```
pip install requests pyyaml
```

Edit `config.yaml`: FortiGate IP and port, health check name, your two WAN interface names (exactly as they appear on the FortiGate, e.g. `wan1`, `port2`) with friendly ISP names, and at least one alert channel.

Keep secrets out of the file by using environment variables. The config supports `${VAR}` syntax:

```
export WANMON_FGT_TOKEN="your-api-key"          # Linux
setx WANMON_FGT_TOKEN "your-api-key"            # Windows (then open a new terminal)
```

## 3. Verify

```
python wanmon.py --once          # shows health checks found and current state of each link
python wanmon.py --test-alert    # sends a test message to every enabled channel
```

`--once` lists the health check names and member interfaces the FortiGate returns, which is the quickest way to fix a wrong name in the config.

## 4. Run it permanently

**Linux (systemd)** — save as `/etc/systemd/system/wanmon.service`:

```
[Unit]
Description=FortiGate WAN link monitor
After=network-online.target

[Service]
WorkingDirectory=/opt/wanmon
ExecStart=/usr/bin/python3 /opt/wanmon/wanmon.py -c /opt/wanmon/config.yaml
Environment=WANMON_FGT_TOKEN=your-api-key
Environment=WANMON_TG_TOKEN=your-telegram-bot-token
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now wanmon` and watch it with `journalctl -u wanmon -f`.

**Windows** — use NSSM (nssm.cc) to run it as a service:

```
nssm install wanmon "C:\Python312\python.exe" "C:\wanmon\wanmon.py -c C:\wanmon\config.yaml"
nssm set wanmon AppDirectory C:\wanmon
nssm set wanmon AppEnvironmentExtra WANMON_FGT_TOKEN=your-api-key
nssm start wanmon
```

## 5. Alert channels

**Telegram** (instant on your phone, easy): message `@BotFather`, send `/newbot`, copy the token. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`. For a team group, add the bot to the group and use the group's (negative) chat id.

**Microsoft Teams**: in the channel, open **Workflows** and choose the template *"Post to a channel when a webhook request is received"*, then copy the URL into `alerts.teams.webhook_url`.

**Email (Microsoft 365)**: the sending mailbox needs *Authenticated SMTP* enabled (M365 admin center > user > Mail > Manage email apps). If your tenant blocks SMTP AUTH, use Telegram or Teams instead, or your own SMTP relay.

**Slack**: create an Incoming Webhook and paste the URL.

## 6. How detection works

Each poll, every link is classified as:

| State | Condition |
|---|---|
| DOWN | interface physically down, **or** all SLA probes failing, **or** loss ≥ `loss_down_pct` |
| DEGRADED | latency > `latency_ms`, jitter > `jitter_ms`, or loss ≥ `loss_pct` |
| OK | everything within limits |

A change is only confirmed (and alerted) after `raise_after` consecutive bad polls, and recovery only after `clear_after` consecutive good polls. This stops flapping links from flooding you. While a link stays bad you get a reminder every `reminder_minutes`. If wanmon cannot reach the FortiGate API itself, you get a separate alert.

**Important limitation:** if *both* links are down, internet-based alerts (Telegram, Teams, M365 email) cannot be delivered. wanmon queues them and sends them the moment connectivity returns, marked as delayed with the original time. If you need a notification during a total outage, use an SMTP relay on your LAN or an SMS gateway/GSM modem attached to the monitoring machine.

## 7. Reports for your ISPs

```
python wanmon.py --report 30
```

Shows per-link availability %, time spent degraded, number of outages, approximate downtime, average latency and average loss over the period. Raw data is in `wanmon.db` (tables `samples` and `events`) if you want to build charts in Excel or Power BI.
