/**
 * Help page: fills the guide with this installation's actual values (server IP, port,
 * interface names, health check, webhook URL) and shows the live connection status.
 */
(async function () {
  const fill = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    document.querySelectorAll(`[data-fill="${key}"]`).forEach((node) => { node.textContent = value; });
  };

  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  fill('port', port);

  let cfg = null;
  try {
    const res = await fetch('/api/settings');
    if (res.ok) cfg = await res.json();
  } catch { /* help still works without live values */ }

  if (cfg) {
    const ip = (cfg.server?.addresses || [])[0] || (location.hostname !== 'localhost' ? location.hostname : null);
    fill('monitorIp', ip);
    fill('port', cfg.server?.port || port);
    fill('wan1Interface', cfg.fortigate?.wan1Interface);
    fill('wan2Interface', cfg.fortigate?.wan2Interface);
    fill('healthCheck', cfg.fortigate?.healthCheckName);
    try {
      fill('fgHost', new URL(cfg.fortigate?.host).host);
    } catch { /* not a URL yet */ }
    if (cfg.webhook?.token) {
      fill('webhookUrl', `http://${ip || '<this-server-ip>'}:${cfg.server?.port || port}${cfg.webhook.path}?token=${cfg.webhook.token}`);
    }
  }

  const box = document.getElementById('setupStatus');
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error();
    const s = await res.json();
    const fg = s.fortigateStatus || {};
    if (s.isSimulating) {
      box.className = 'setup-status warn';
      box.textContent = 'Simulation mode is ON: the dashboard shows fake data. Complete the steps below, then switch it off (step 7).';
    } else if (fg.connected) {
      const unknown = ['wan1', 'wan2'].filter(l => s[l]?.status === 'UNKNOWN').map(l => s[l].interface);
      box.className = unknown.length ? 'setup-status warn' : 'setup-status ok';
      box.textContent = unknown.length
        ? `Connected to ${fg.hostname || 'the FortiGate'}, but there is no health-check data for ${unknown.join(', ')}. See step 1 and step 6.`
        : `Connected to ${fg.hostname || 'the FortiGate'}${fg.version ? ` (${fg.version})` : ''}. Both links are being monitored.`;
    } else {
      box.className = 'setup-status bad';
      box.textContent = `Not connected yet: ${fg.lastError || 'no FortiGate configured'}. Follow the steps below.`;
    }
  } catch {
    box.className = 'setup-status';
    box.textContent = 'Live status is only shown when you are signed in to the dashboard.';
  }
}());
