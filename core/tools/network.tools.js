'use strict';

/**
 * Network tools, deliberately LAN-only.
 *
 * The assistant has no business reaching the public internet on its own: every
 * host is checked against private ranges first, so a prompt-injected "scan
 * 8.8.8.8" cannot turn into outbound traffic. Discovery exists so pairing with
 * the ESP32 is a real feature rather than "type the IP and hope".
 */

const os = require('node:os');
const net = require('node:net');
const dns = require('node:dns').promises;
const { run, powershellJson, linux, IS_WINDOWS, ExecError } = require('./helpers');

function isPrivateAddress(address) {
  if (!address) return false;
  if (address === 'localhost' || address.endsWith('.local') || address.endsWith('.lan') || address.endsWith('.home')) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
    return address === '0.0.0.0';
  }
  return address === '::1' || address.startsWith('fe80:') || address.startsWith('fd') || address.startsWith('fc');
}

/** Throws unless the host is on the user's own network. */
async function assertLocal(host) {
  const target = String(host || '').trim();
  if (!target) throw Object.assign(new Error('host is required'), { code: 'BAD_ARGS' });
  if (isPrivateAddress(target)) return target;
  if (net.isIP(target)) throw Object.assign(new Error(`${target} is not a private address; SENTINEL only talks to your own network`), { code: 'PUBLIC_TARGET' });
  if (!/^[a-z0-9.-]+$/i.test(target)) throw Object.assign(new Error('invalid hostname'), { code: 'BAD_ARGS' });
  let resolved;
  try {
    resolved = await dns.lookup(target, { all: true });
  } catch {
    throw Object.assign(new Error(`cannot resolve ${target}`), { code: 'DNS_FAILED' });
  }
  if (!resolved.every((entry) => isPrivateAddress(entry.address))) {
    throw Object.assign(new Error(`${target} resolves outside your local network; refusing`), { code: 'PUBLIC_TARGET' });
  }
  return target;
}

function connect(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (open, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, ms: Date.now() - started, error: error || null });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}

function allInterfaces() {
  const out = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      out.push({ name, address: address.address, netmask: address.netmask, cidr: address.cidr, mac: address.mac });
    }
  }
  return out;
}

module.exports = [
  {
    name: 'net.interfaces',
    title: 'Network interfaces',
    description: 'Local IPv4 addresses, netmasks and MAC addresses.',
    category: 'network',
    permission: 'read',
    tags: ['network', 'ip', 'lan'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return { interfaces: allInterfaces(), hostname: os.hostname() };
    },
  },
  {
    name: 'net.ping',
    title: 'Ping a local device',
    description: 'ICMP ping to a device on your own network (latency and packet loss).',
    category: 'network',
    permission: 'network',
    requiresNetwork: true,
    tags: ['ping', 'latency', 'esp32'],
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'private IP or .local name', minLength: 1, maxLength: 120 },
        count: { type: 'integer', default: 4, minimum: 1, maximum: 10 },
      },
      required: ['host'],
      additionalProperties: false,
    },
    async run(args) {
      const host = await assertLocal(args.host);
      const command = IS_WINDOWS ? 'ping' : 'ping';
      const argv = IS_WINDOWS ? ['-n', String(args.count), '-w', '1500', host] : ['-c', String(args.count), '-W', '2', host];
      const result = await run(command, argv, { timeout: 20000 });
      const out = result.stdout;
      const loss = (out.match(/\((\d+)% ?(?:loss|straty)\)/i) || [])[1];
      const avg = (out.match(/(?:Average|Średnia)\s*=\s*(\d+)\s*ms/i) || out.match(/min\/avg\/max\/(?:mdev|stddev)\s*=\s*[\d.]+\/([\d.]+)/i) || [])[1];
      return {
        host,
        reachable: result.code === 0,
        avgMs: avg ? Number(avg) : null,
        packetLossPercent: loss ? Number(loss) : result.code === 0 ? 0 : 100,
        raw: out.split('\n').slice(-4).join('\n').trim(),
      };
    },
  },
  {
    name: 'net.ports',
    title: 'Listening ports',
    description: 'TCP ports this machine is listening on, with the owning process.',
    category: 'network',
    permission: 'read',
    tags: ['ports', 'listening'],
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', default: 40, minimum: 1, maximum: 300 } },
      additionalProperties: false,
    },
    async run(args) {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -First ${Number(args.limit)} | ` +
            `ForEach-Object { [pscustomobject]@{ port = $_.LocalPort; address = "$($_.LocalAddress)"; pid = $_.OwningProcess; process = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } }`,
          { timeout: 25000 },
        );
        return { ports: rows.sort((a, b) => a.port - b.port) };
      }
      const result = await linux('ss', ['-ltnp'], { timeout: 10000 });
      const ports = result.stdout
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 4)
        .map((parts) => ({ address: parts[3], process: (parts[parts.length - 1].match(/users:\(\("([^"]+)"/) || [])[1] || null }))
        .slice(0, args.limit);
      return { ports };
    },
  },
  {
    name: 'net.port.check',
    title: 'Check a TCP port',
    description: 'Can this machine open a TCP connection to host:port? Measures the handshake time.',
    category: 'network',
    permission: 'network',
    requiresNetwork: true,
    tags: ['port', 'connect', 'esp32'],
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', minLength: 1, maxLength: 120 },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        timeoutMs: { type: 'integer', default: 1500, minimum: 200, maximum: 5000 },
      },
      required: ['host', 'port'],
      additionalProperties: false,
    },
    async run(args) {
      const host = await assertLocal(args.host);
      return { host, port: args.port, ...(await connect(host, args.port, args.timeoutMs)) };
    },
  },
  {
    name: 'net.dns',
    title: 'Resolve a name',
    description: 'Resolve a hostname to local addresses using the system resolver.',
    category: 'network',
    permission: 'read',
    tags: ['dns', 'resolve'],
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args) {
      try {
        const result = await dns.lookup(args.name, { all: true });
        return { name: args.name, addresses: result, private: result.every((entry) => isPrivateAddress(entry.address)) };
      } catch (err) {
        throw Object.assign(new Error(`could not resolve ${args.name}: ${err.code || err.message}`), { code: 'DNS_FAILED' });
      }
    },
  },
  {
    name: 'net.discover',
    title: 'Find SENTINEL devices',
    description: 'Probe the local /24 for the ESP32 link port (default 7879) and report which addresses answer.',
    category: 'network',
    permission: 'network',
    requiresNetwork: true,
    tags: ['discover', 'esp32', 'pairing', 'lan'],
    parameters: {
      type: 'object',
      properties: {
        subnet: { type: 'string', description: 'e.g. 192.168.1 — defaults to your subnet', maxLength: 20 },
        port: { type: 'integer', default: 7879, minimum: 1, maximum: 65535 },
        timeoutMs: { type: 'integer', default: 320, minimum: 100, maximum: 2000 },
      },
      additionalProperties: false,
    },
    async run(args) {
      let prefix = args.subnet;
      if (!prefix) {
        const iface = allInterfaces()[0];
        if (!iface) throw Object.assign(new Error('no LAN interface found'), { code: 'NO_INTERFACE' });
        prefix = iface.address.split('.').slice(0, 3).join('.');
      }
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) throw Object.assign(new Error('subnet must look like 192.168.1'), { code: 'BAD_ARGS' });
      const hosts = Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`);
      const found = [];
      const queue = [...hosts];
      const workers = Array.from({ length: 48 }, async () => {
        while (queue.length) {
          const host = queue.shift();
          const result = await connect(host, args.port, args.timeoutMs).catch(() => ({ open: false }));
          if (result.open) found.push({ host, port: args.port, ms: result.ms });
        }
      });
      await Promise.all(workers);
      found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
      return { subnet: `${prefix}.0/24`, port: args.port, scanned: hosts.length, hosts: found };
    },
  },
  {
    name: 'net.connections',
    title: 'Active connections',
    description: 'Established TCP connections with the remote endpoint and owning process.',
    category: 'network',
    permission: 'read',
    tags: ['connections', 'tcp'],
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', default: 30, minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
    async run(args) {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          `Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Select-Object -First ${Number(args.limit)} | ` +
            `ForEach-Object { [pscustomobject]@{ local = "$($_.LocalAddress):$($_.LocalPort)"; remote = "$($_.RemoteAddress):$($_.RemotePort)"; pid = $_.OwningProcess; process = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } }`,
          { timeout: 25000 },
        );
        return { connections: rows };
      }
      const result = await linux('ss', ['-tun', 'state', 'established'], { timeout: 8000 });
      return {
        connections: result.stdout
          .split('\n')
          .slice(1)
          .filter(Boolean)
          .slice(0, args.limit)
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            return { local: parts[4], remote: parts[5] };
          }),
      };
    },
  },
  {
    name: 'net.wifi',
    title: 'Wi-Fi status',
    description: 'Connected SSID, signal strength and link speed.',
    category: 'network',
    permission: 'read',
    tags: ['wifi', 'signal'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (IS_WINDOWS) {
        const result = await run('netsh', ['wlan', 'show', 'interfaces'], { timeout: 10000 });
        const text = result.stdout;
        const pick = (label) => (text.match(new RegExp(`${label}\\s*:\\s*(.+)`, 'i')) || [])[1];
        return {
          ssid: (pick('SSID') || '').trim() || null,
          bssid: (pick('BSSID') || '').trim() || null,
          signal: (pick('Signal') || '').trim() || null,
          state: (pick('State') || '').trim() || null,
          receiveRate: (pick('Receive rate') || '').trim() || null,
          transmitRate: (pick('Transmit rate') || '').trim() || null,
        };
      }
      const result = await linux('iw', ['dev'], { timeout: 6000 }).catch(() => null);
      const iface = result && result.stdout ? (result.stdout.match(/Interface (\S+)/) || [])[1] : null;
      if (!iface) return { connected: false, note: 'no wireless interface (iw not installed or wired only)' };
      const link = await linux('iw', ['dev', iface, 'link'], { timeout: 6000 });
      const ssid = (link.stdout.match(/SSID:\s*(.+)/) || [])[1];
      const signal = (link.stdout.match(/signal:\s*(-?\d+)/) || [])[1];
      return { interface: iface, connected: Boolean(ssid), ssid: ssid ? ssid.trim() : null, signalDbm: signal ? Number(signal) : null };
    },
  },
  {
    name: 'net.route',
    title: 'Routing table',
    description: 'Default gateway and the IPv4 routing table, so a connectivity problem can be attributed to a real interface.',
    category: 'network',
    permission: 'read',
    tags: ['route', 'gateway'],
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    async run(args) {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          `Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First ${Number(args.limit)} | ` +
            `Select-Object DestinationPrefix, NextHop, RouteMetric, InterfaceAlias`,
          { timeout: 20000 },
        );
        return { routes: rows };
      }
      const result = await linux('ip', ['route'], { timeout: 6000 });
      return {
        routes: result.stdout
          .split('\n')
          .filter(Boolean)
          .slice(0, args.limit)
          .map((line) => ({ line: line.trim() })),
      };
    },
  },
  {
    name: 'net.esp.link',
    title: 'ESP32 link check',
    description: 'Is the ESP32 reachable, and is the encrypted session up right now?',
    category: 'esp32',
    permission: 'read',
    tags: ['esp32', 'link', 'status'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const host = ctx.config.get('esp.host', '192.168.1.1');
      const port = ctx.config.get('esp.port', 7879);
      const probe = await connect(host, port, 1800);
      const link = ctx.link ? ctx.link.status() : null;
      return { host, port, tcpReachable: probe.open, handshakeMs: probe.ms, error: probe.error, session: link };
    },
  },
];

module.exports.isPrivateAddress = isPrivateAddress;
module.exports.assertLocal = assertLocal;
