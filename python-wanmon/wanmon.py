#!/usr/bin/env python3
"""
wanmon.py - FortiGate WAN link monitor & alerter.

Polls the FortiGate REST API for SD-WAN performance-SLA data (latency, jitter,
packet loss, probe status) and interface link state for each WAN link. Each
link is classified OK / DEGRADED / DOWN with hysteresis, so one bad sample
does not page you, and alerts go out by email, Telegram, Slack and/or Teams.
Every sample is stored in SQLite so you can produce per-ISP availability reports.

Usage:
  python wanmon.py -c config.yaml               run the monitor (foreground)
  python wanmon.py -c config.yaml --once        one poll, print status, exit
  python wanmon.py -c config.yaml --test-alert  send a test alert to all channels
  python wanmon.py -c config.yaml --report 7    availability report, last 7 days
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import smtplib
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import requests
import urllib3
import yaml

log = logging.getLogger("wanmon")

OK, DEGRADED, DOWN, UNKNOWN = "OK", "DEGRADED", "DOWN", "UNKNOWN"
RANK = {UNKNOWN: -1, OK: 0, DEGRADED: 1, DOWN: 2}
ICON = {OK: "✅", DEGRADED: "⚠️", DOWN: "🔴", UNKNOWN: "❔"}

DEFAULT_THRESHOLDS = {
    "latency_ms": 150,     # above this -> DEGRADED
    "jitter_ms": 30,       # above this -> DEGRADED
    "loss_pct": 3,         # at/above this -> DEGRADED
    "loss_down_pct": 50,   # at/above this -> treated as DOWN
}


# --------------------------------------------------------------------------- helpers
def now() -> datetime:
    return datetime.now().astimezone()


def utc_iso(dt: datetime | None = None) -> str:
    return (dt or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(timespec="seconds")


def fmt_duration(td: timedelta) -> str:
    s = max(int(td.total_seconds()), 0)
    d, rem = divmod(s, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def fmt_num(v, unit="", digits=0) -> str:
    return "n/a" if v is None else f"{v:.{digits}f}{unit}"


def expand_env(obj):
    """Allow ${ENV_VAR} in config values so secrets can live outside the file."""
    if isinstance(obj, dict):
        return {k: expand_env(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [expand_env(v) for v in obj]
    if isinstance(obj, str):
        return os.path.expandvars(obj)
    return obj


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        cfg = expand_env(yaml.safe_load(f) or {})
    for key in ("fortigate", "links"):
        if key not in cfg:
            sys.exit(f"Config error: '{key}' section is missing")
    for key in ("host", "api_token"):
        if not cfg["fortigate"].get(key):
            sys.exit(f"Config error: fortigate.{key} is missing")
    if not cfg["links"]:
        sys.exit("Config error: 'links' must list at least one WAN interface")
    return cfg


# --------------------------------------------------------------------------- FortiGate API
class FortiGateClient:
    SDWAN_HEALTH = "/api/v2/monitor/virtual-wan/health-check"
    INTERFACES = "/api/v2/monitor/system/interface"

    def __init__(self, cfg: dict):
        self.base = f"https://{cfg['host']}:{cfg.get('port', 443)}"
        self.vdom = cfg.get("vdom")
        self.timeout = cfg.get("timeout", 10)
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {cfg['api_token']}"
        verify = cfg.get("verify_ssl", True)
        self.session.verify = verify
        if verify is False:
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    def _get(self, path: str) -> dict:
        params = {"vdom": self.vdom} if self.vdom else None
        r = self.session.get(self.base + path, params=params, timeout=self.timeout)
        if r.status_code == 401:
            raise RuntimeError("401 Unauthorized: check the API token, and that this machine's IP "
                               "is in the REST API admin's trusted hosts")
        if r.status_code == 403:
            raise RuntimeError("403 Forbidden: the REST API admin profile lacks read access")
        r.raise_for_status()
        return r.json().get("results", {}) or {}

    def sdwan_health(self) -> dict:
        return self._get(self.SDWAN_HEALTH)

    def interfaces(self) -> dict:
        return self._get(self.INTERFACES)


# --------------------------------------------------------------------------- evaluation
@dataclass
class Sample:
    interface: str
    state: str
    reason: str = ""
    latency: float | None = None
    jitter: float | None = None
    loss: float | None = None
    link_up: bool | None = None

    def metrics(self) -> str:
        return (f"latency {fmt_num(self.latency, ' ms')}, jitter {fmt_num(self.jitter, ' ms')}, "
                f"loss {fmt_num(self.loss, '%', 1)}")


def evaluate(link: dict, thresholds: dict, hc_results: dict, if_results: dict,
             hc_name: str | None) -> Sample:
    ifname = link["interface"]
    th = {**thresholds, **(link.get("thresholds") or {})}
    s = Sample(interface=ifname, state=OK)

    # 1) Physical / interface state (cable, ONT, radio, modem)
    if if_results and link.get("check_interface", True):
        info = if_results.get(ifname)
        if isinstance(info, dict) and "link" in info:
            s.link_up = bool(info["link"])
    if s.link_up is False:
        s.state, s.reason, s.loss = DOWN, "interface link is down (cable / ONT / radio / modem)", 100.0
        return s

    # 2) SD-WAN performance SLA probe results for this member
    entries = []
    if hc_name:
        hc = hc_results.get(hc_name) or {}
        if isinstance(hc, dict) and isinstance(hc.get(ifname), dict):
            entries.append(hc[ifname])
    else:
        for hc in hc_results.values():
            if isinstance(hc, dict) and isinstance(hc.get(ifname), dict):
                entries.append(hc[ifname])
    if not entries:
        s.state = UNKNOWN
        s.reason = (f"no SD-WAN health-check data for '{ifname}'"
                    + (f" in health check '{hc_name}'" if hc_name else ""))
        return s

    up = [e for e in entries if str(e.get("status", "")).lower() == "up"]
    if not up:
        s.state, s.loss = DOWN, 100.0
        s.reason = "health-check probes failing: interface is up but the ISP is not passing traffic"
        return s

    def worst(key):
        vals = []
        for e in up:
            try:
                if e.get(key) is not None:
                    vals.append(float(e[key]))
            except (TypeError, ValueError):
                pass
        return max(vals) if vals else None

    s.latency, s.jitter, s.loss = worst("latency"), worst("jitter"), worst("packet_loss")

    if s.loss is not None and s.loss >= th["loss_down_pct"]:
        s.state = DOWN
        s.reason = f"severe packet loss {s.loss:.1f}% (link effectively unusable)"
        return s

    problems = []
    if s.loss is not None and s.loss >= th["loss_pct"]:
        problems.append(f"packet loss {s.loss:.1f}% (limit {th['loss_pct']}%)")
    if s.latency is not None and s.latency > th["latency_ms"]:
        problems.append(f"latency {s.latency:.0f} ms (limit {th['latency_ms']} ms)")
    if s.jitter is not None and s.jitter > th["jitter_ms"]:
        problems.append(f"jitter {s.jitter:.0f} ms (limit {th['jitter_ms']} ms)")
    if problems:
        s.state, s.reason = DEGRADED, "; ".join(problems)
    return s


@dataclass
class LinkTracker:
    """Holds the confirmed state of one link and applies hysteresis."""
    interface: str
    name: str
    raise_after: int
    clear_after: int
    state: str = UNKNOWN
    since: datetime = field(default_factory=now)
    worse: int = 0
    better: int = 0
    last_reminder: datetime | None = None
    last: Sample | None = None
    last_bad: Sample | None = None

    @property
    def label(self) -> str:
        return f"{self.name} ({self.interface})"

    def update(self, obs: Sample):
        """Returns (old_state, old_since) when the confirmed state changes, else None."""
        if obs.state == UNKNOWN:          # missing data never changes confirmed state
            return None
        self.last = obs
        if obs.state != OK:
            self.last_bad = obs
        if RANK[obs.state] > RANK[self.state]:
            self.worse += 1
            self.better = 0
            needed = 1 if self.state == UNKNOWN else self.raise_after
            if self.worse >= needed:
                return self._transition(obs.state)
        elif RANK[obs.state] < RANK[self.state]:
            self.better += 1
            self.worse = 0
            if self.better >= self.clear_after:
                return self._transition(obs.state)
        else:
            self.worse = self.better = 0
        return None

    def _transition(self, new_state: str):
        old, old_since = self.state, self.since
        self.state, self.since = new_state, now()
        self.worse = self.better = 0
        self.last_reminder = None
        return old, old_since


# --------------------------------------------------------------------------- notifications
class Notifier:
    """Sends alerts; if delivery fails (e.g. internet is down), queues and retries."""

    MAX_QUEUE = 200

    def __init__(self, cfg: dict):
        self.cfg = cfg or {}
        self.channels = {}
        if self._on("email"):
            self.channels["email"] = self._email
        if self._on("telegram"):
            self.channels["telegram"] = self._telegram
        if self._on("slack"):
            self.channels["slack"] = self._slack
        if self._on("teams"):
            self.channels["teams"] = self._teams
        if not self.channels:
            log.warning("No alert channels enabled - alerts will only be written to the log")
        self.queue: list[dict] = []

    def _on(self, name):
        return bool((self.cfg.get(name) or {}).get("enabled"))

    def send(self, subject: str, body: str):
        log.info("ALERT: %s", subject)
        if self.channels:
            self.queue.append({"subject": subject, "body": body, "created": now(),
                               "pending": list(self.channels)})
            if len(self.queue) > self.MAX_QUEUE:
                self.queue = self.queue[-self.MAX_QUEUE:]
        self.flush()

    def flush(self):
        for item in list(self.queue):
            body = item["body"]
            age = now() - item["created"]
            if age > timedelta(seconds=90):
                body = (f"[Delayed alert: raised {item['created']:%Y-%m-%d %H:%M:%S}, "
                        f"{fmt_duration(age)} ago. It could not be sent earlier, most likely "
                        f"because internet access was unavailable.]\n\n" + body)
            for ch in list(item["pending"]):
                try:
                    self.channels[ch](item["subject"], body)
                    item["pending"].remove(ch)
                except Exception as e:
                    log.warning("Could not send via %s (will retry): %s", ch, e)
            if not item["pending"]:
                self.queue.remove(item)

    # --- channels
    def _email(self, subject, body):
        c = self.cfg["email"]
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = c["from"]
        to = c["to"] if isinstance(c["to"], list) else [c["to"]]
        msg["To"] = ", ".join(to)
        msg.set_content(body)
        port = c.get("smtp_port", 587)
        if c.get("use_ssl"):
            server = smtplib.SMTP_SSL(c["smtp_host"], port, timeout=20)
        else:
            server = smtplib.SMTP(c["smtp_host"], port, timeout=20)
        with server as s:
            if not c.get("use_ssl") and c.get("starttls", True):
                s.starttls()
            if c.get("username"):
                s.login(c["username"], c["password"])
            s.send_message(msg)

    def _telegram(self, subject, body):
        c = self.cfg["telegram"]
        r = requests.post(f"https://api.telegram.org/bot{c['bot_token']}/sendMessage",
                          json={"chat_id": c["chat_id"], "text": f"{subject}\n\n{body}"[:4000]},
                          timeout=15)
        r.raise_for_status()

    def _slack(self, subject, body):
        r = requests.post(self.cfg["slack"]["webhook_url"],
                          json={"text": f"*{subject}*\n```{body}```"}, timeout=15)
        r.raise_for_status()

    def _teams(self, subject, body):
        # Payload for a Teams "Workflows" webhook
        # ("Post to a channel when a webhook request is received" template).
        card = {
            "type": "message",
            "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": [
                        {"type": "TextBlock", "text": subject, "weight": "Bolder",
                         "size": "Medium", "wrap": True},
                        {"type": "TextBlock", "text": body.replace("\n", "\n\n"),
                         "wrap": True, "fontType": "Monospace"},
                    ],
                },
            }],
        }
        r = requests.post(self.cfg["teams"]["webhook_url"], json=card, timeout=15)
        r.raise_for_status()


# --------------------------------------------------------------------------- storage
class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS samples(
                ts TEXT, interface TEXT, state TEXT,
                latency REAL, jitter REAL, loss REAL, reason TEXT);
            CREATE INDEX IF NOT EXISTS ix_samples ON samples(interface, ts);
            CREATE TABLE IF NOT EXISTS events(
                ts TEXT, interface TEXT, old_state TEXT, new_state TEXT, reason TEXT);
            CREATE INDEX IF NOT EXISTS ix_events ON events(interface, ts);
        """)

    def add_samples(self, samples: list[Sample]):
        ts = utc_iso()
        self.db.executemany(
            "INSERT INTO samples VALUES (?,?,?,?,?,?,?)",
            [(ts, s.interface, s.state, s.latency, s.jitter, s.loss, s.reason) for s in samples])
        self.db.commit()

    def add_event(self, interface, old, new, reason):
        self.db.execute("INSERT INTO events VALUES (?,?,?,?,?)",
                        (utc_iso(), interface, old, new, reason))
        self.db.commit()

    def prune(self, days: int):
        cutoff = utc_iso(datetime.now(timezone.utc) - timedelta(days=days))
        self.db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
        self.db.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
        self.db.commit()


# --------------------------------------------------------------------------- monitor
class Monitor:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.site = cfg.get("site_name", cfg["fortigate"]["host"])
        self.fgt = FortiGateClient(cfg["fortigate"])
        self.hc_name = cfg["fortigate"].get("health_check") or None
        self.thresholds = {**DEFAULT_THRESHOLDS, **(cfg.get("thresholds") or {})}
        mon = cfg.get("monitor") or {}
        self.interval = int(mon.get("poll_seconds", 15))
        self.reminder = timedelta(minutes=float(mon.get("reminder_minutes", 30)))
        self.api_fail_limit = int(mon.get("api_fail_alert_after", 4))
        self.retention_days = int(mon.get("retention_days", 90))
        self.links = cfg["links"]
        self.trackers = {
            l["interface"]: LinkTracker(l["interface"], l.get("name", l["interface"]),
                                        int(mon.get("raise_after", 3)),
                                        int(mon.get("clear_after", 4)))
            for l in self.links
        }
        self.notifier = Notifier(cfg.get("alerts") or {})
        self.store = Store(mon.get("db_path", "wanmon.db"))
        self.api_failures = 0
        self.api_alerted = False
        self.running = True

    # ---- data collection
    def collect(self) -> list[Sample]:
        hc = self.fgt.sdwan_health()
        ifs = {}
        if any(l.get("check_interface", True) for l in self.links):
            try:
                ifs = self.fgt.interfaces()
            except Exception as e:
                log.warning("Interface status unavailable (continuing with SLA data only): %s", e)
        self._last_hc = hc
        return [evaluate(l, self.thresholds, hc, ifs, self.hc_name) for l in self.links]

    # ---- one monitoring cycle
    def poll(self):
        try:
            samples = self.collect()
        except Exception as e:
            self.api_failures += 1
            log.warning("FortiGate API poll failed (%d in a row): %s", self.api_failures, e)
            if self.api_failures >= self.api_fail_limit and not self.api_alerted:
                self.api_alerted = True
                self.notifier.send(
                    f"[wanmon] {self.site}: monitor cannot reach FortiGate",
                    f"Site: {self.site}\nTime: {now():%Y-%m-%d %H:%M:%S %z}\n"
                    f"{self.api_failures} consecutive API polls failed.\nLast error: {e}\n\n"
                    "WAN link status is unknown until this clears. Check the FortiGate, the "
                    "LAN path to it, and the REST API token.")
            return

        if self.api_alerted:
            self.notifier.send(f"[wanmon] {self.site}: FortiGate reachable again",
                               f"API polling resumed at {now():%Y-%m-%d %H:%M:%S %z}.")
        self.api_failures, self.api_alerted = 0, False

        self.store.add_samples(samples)
        changes = []
        for s in samples:
            t = self.trackers[s.interface]
            if s.state == UNKNOWN:
                log.warning("%s: %s", t.label, s.reason)
            result = t.update(s)
            if result:
                changes.append((t, result[0], result[1], s))
            log.debug("%s obs=%s confirmed=%s %s", t.label, s.state, t.state, s.metrics())

        for t, old, old_since, s in changes:
            self.store.add_event(t.interface, old, t.state, s.reason)
            if old == UNKNOWN and t.state == OK:
                log.info("%s is OK (initial state)", t.label)
                continue
            self._alert_change(t, old, old_since, s)

        self._reminders()

    # ---- alert composition
    def _overview(self) -> str:
        lines = []
        for t in self.trackers.values():
            s = t.last
            detail = s.metrics() if s and t.state != DOWN else (s.reason if s else "no data yet")
            lines.append(f"{ICON[t.state]} {t.label}: {t.state} for {fmt_duration(now() - t.since)}"
                         f" - {detail}")
        healthy = [t for t in self.trackers.values() if t.state == OK]
        down = [t for t in self.trackers.values() if t.state == DOWN]
        if len(down) == len(self.trackers):
            lines.append("\nIMPACT: ALL WAN LINKS DOWN - site has no internet access.")
        elif down and len(healthy) == 1:
            lines.append(f"\nIMPACT: running on a single link ({healthy[0].label}). No redundancy left.")
        elif down and not healthy:
            lines.append("\nIMPACT: remaining link(s) are degraded - expect poor performance.")
        return "\n".join(lines)

    def _alert_change(self, t: LinkTracker, old, old_since, s: Sample):
        was = f"{old} for {fmt_duration(now() - old_since)}" if old != UNKNOWN else "starting up"
        if t.state == OK:
            title = f"✅ RECOVERED: {t.label}"
            what = f"Link is healthy again: {s.metrics()}"
            if t.last_bad:
                what += f"\nLast problem seen: {t.last_bad.reason}"
        else:
            title = f"{ICON[t.state]} WAN {t.state}: {t.label}"
            what = f"Reason: {s.reason}\nMeasurements: {s.metrics()}"
        body = (f"Site: {self.site}\nTime: {now():%Y-%m-%d %H:%M:%S %z}\n"
                f"Change: {old} -> {t.state} (was {was})\n{what}\n\nAll links:\n{self._overview()}")
        self.notifier.send(f"[wanmon] {self.site} {title}", body)

    def _reminders(self):
        if self.reminder.total_seconds() <= 0:
            return
        for t in self.trackers.values():
            if t.state not in (DEGRADED, DOWN):
                continue
            ref = t.last_reminder or t.since
            if now() - ref >= self.reminder:
                t.last_reminder = now()
                reason = t.last.reason if t.last else ""
                self.notifier.send(
                    f"[wanmon] {self.site} STILL {t.state}: {t.label} "
                    f"({fmt_duration(now() - t.since)})",
                    f"Site: {self.site}\n{t.label} has been {t.state} since "
                    f"{t.since:%Y-%m-%d %H:%M:%S} ({fmt_duration(now() - t.since)}).\n"
                    f"Latest: {reason}\n\nAll links:\n{self._overview()}")

    # ---- main loop
    def run(self):
        def stop(*_):
            self.running = False
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, stop)
            except (ValueError, OSError):
                pass
        log.info("wanmon started: site=%s, links=%s, poll every %ss",
                 self.site, ", ".join(t.label for t in self.trackers.values()), self.interval)
        last_prune = 0.0
        while self.running:
            started = time.monotonic()
            try:
                self.poll()
            except Exception:
                log.exception("Unexpected error during poll")
            self.notifier.flush()
            if time.time() - last_prune > 3600:
                try:
                    self.store.prune(self.retention_days)
                except Exception:
                    log.exception("Prune failed")
                last_prune = time.time()
            while self.running and time.monotonic() - started < self.interval:
                time.sleep(0.5)
        log.info("wanmon stopped")


# --------------------------------------------------------------------------- CLI actions
def print_once(mon: Monitor):
    samples = mon.collect()
    hc = getattr(mon, "_last_hc", {}) or {}
    print(f"\nSD-WAN health checks found on FortiGate: {', '.join(hc) or '(none)'}")
    for name, members in hc.items():
        if isinstance(members, dict):
            print(f"  {name}: members {', '.join(members)}")
    print(f"Using health check: {mon.hc_name or '(all)'}\n")
    for s in samples:
        t = mon.trackers[s.interface]
        print(f"{ICON[s.state]} {t.label:<32} {s.state:<9} {s.metrics()}")
        if s.reason:
            print(f"   {s.reason}")
    print()


def report(mon: Monitor, days: int):
    db = mon.store.db
    since = utc_iso(datetime.now(timezone.utc) - timedelta(days=days))
    print(f"\nWAN availability report - {mon.site} - last {days} day(s)\n")
    hdr = (f"{'Link':<34}{'Avail %':>9}{'Degr %':>8}{'Outages':>9}{'Down time':>12}"
           f"{'Avg lat':>9}{'Avg loss':>10}")
    print(hdr)
    print("-" * len(hdr))
    for l in mon.links:
        ifn = l["interface"]
        t = mon.trackers[ifn]
        rows = dict((st, n) for st, n in db.execute(
            "SELECT state, COUNT(*) FROM samples WHERE interface=? AND ts>=? "
            "AND state!='UNKNOWN' GROUP BY state", (ifn, since)))
        total = sum(rows.values())
        if not total:
            print(f"{t.label:<34}{'no data':>9}")
            continue
        down, degr = rows.get(DOWN, 0), rows.get(DEGRADED, 0)
        avg_lat, avg_loss = db.execute(
            "SELECT AVG(latency), AVG(loss) FROM samples WHERE interface=? AND ts>=? "
            "AND state IN ('OK','DEGRADED')", (ifn, since)).fetchone()
        outages = db.execute("SELECT COUNT(*) FROM events WHERE interface=? AND ts>=? "
                             "AND new_state='DOWN'", (ifn, since)).fetchone()[0]
        down_time = fmt_duration(timedelta(seconds=down * mon.interval))
        print(f"{t.label:<34}{100 * (total - down) / total:>9.2f}{100 * degr / total:>8.2f}"
              f"{outages:>9}{down_time:>12}{fmt_num(avg_lat, ' ms'):>9}{fmt_num(avg_loss, '%', 2):>10}")
    print("\nAvail % = share of polls where the link was not DOWN. Down time is approximate "
          "(DOWN polls x poll interval).\n")


def main():
    ap = argparse.ArgumentParser(description="FortiGate WAN link monitor")
    ap.add_argument("-c", "--config", default="config.yaml")
    ap.add_argument("--once", action="store_true", help="poll once, print status, exit")
    ap.add_argument("--test-alert", action="store_true", help="send a test alert and exit")
    ap.add_argument("--report", type=int, metavar="DAYS", help="print availability report")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    cfg = load_config(args.config)
    handlers = [logging.StreamHandler()]
    log_file = (cfg.get("monitor") or {}).get("log_file")
    if log_file:
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", handlers=handlers)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    mon = Monitor(cfg)
    if args.once:
        print_once(mon)
    elif args.test_alert:
        mon.notifier.send(f"[wanmon] {mon.site}: test alert",
                          f"This is a test from wanmon at {now():%Y-%m-%d %H:%M:%S %z}.\n"
                          "If you can read this, the alert channel works.")
        if mon.notifier.queue:
            sys.exit("Some channels failed - see warnings above.")
        print("Test alert sent.")
    elif args.report:
        report(mon, args.report)
    else:
        mon.run()


if __name__ == "__main__":
    main()
