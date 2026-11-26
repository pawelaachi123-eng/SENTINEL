'use strict';

/**
 * System tools: the machine itself — processes, services, disks, GPU, memory,
 * startup entries, event logs, clipboard, screen.
 *
 * Windows paths use PowerShell with static scripts and parameterised values
 * passed through stdin, so nothing the model writes becomes code. Linux paths
 * use coreutils/procfs. Where a capability genuinely does not exist, the tool
 * says so instead of returning an invented answer.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { run, powershell, powershellJson, linux, IS_WINDOWS, ExecError, humanBytes, which, truncate } = require('./helpers');

const P = (name, description, extra = {}) => ({ description, ...extra });

const psString = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function processList({ limit = 25, sort = 'cpu' } = {}) {
  if (IS_WINDOWS) {
    const rows = await powershellJson(
      `Get-Process | Where-Object { $_.Id -ne $PID } | ForEach-Object { ` +
        `[pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; cpuSec = [math]::Round($_.CPU, 1); ` +
        `memMB = [math]::Round($_.WorkingSet64 / 1MB, 1); threads = $_.Threads.Count; title = $_.MainWindowTitle } }`,
      { timeout: 20000 },
    );
    const sorted = rows
      .filter((row) => row && row.name)
      .sort((a, b) => (sort === 'mem' ? (b.memMB || 0) - (a.memMB || 0) : (b.cpuSec || 0) - (a.cpuSec || 0)))
      .slice(0, limit);
    return { platform: 'windows', count: rows.length, processes: sorted };
  }
  const result = await linux('ps', ['-eo', 'pid=,comm=,pcpu=,pmem=,rss=,etimes='], { timeout: 10000 });
  const rows = result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6)
    .map((parts) => ({
      pid: Number(parts[0]),
      name: parts[1],
      cpuPercent: Number(parts[2]),
      memPercent: Number(parts[3]),
      memMB: Math.round(Number(parts[4]) / 1024),
      elapsedSec: Number(parts[5]),
    }));
  rows.sort((a, b) => (sort === 'mem' ? b.memPercent - a.memPercent : b.cpuPercent - a.cpuPercent));
  return { platform: 'linux', count: rows.length, processes: rows.slice(0, limit) };
}

async function findProcesses(needle) {
  const list = await processList({ limit: 500 });
  const lower = String(needle || '').toLowerCase();
  return list.processes.filter((proc) => String(proc.name).toLowerCase().includes(lower));
}

module.exports = [
  {
    name: 'system.info',
    title: 'Machine information',
    description: 'Hostname, OS, CPU, memory, uptime and who is logged in. Read-only.',
    category: 'system',
    permission: 'read',
    tags: ['system', 'info', 'pc'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const info = await ctx.commander.handlers['system.info']();
      return {
        hostname: info.hostname,
        platform: `${info.platformLabel} ${info.release}`,
        arch: info.arch,
        cpu: `${info.cpuModel} × ${info.cpuCount}`,
        memoryGB: Math.round(info.memory / 1024 ** 3),
        uptime: info.uptimeLabel,
        user: info.user,
        agent: info.agentVersion,
        node: info.node,
      };
    },
  },
  {
    name: 'system.snapshot',
    title: 'Everything at once',
    description: 'CPU load, memory pressure, ESP32 state, policy and counters in one call.',
    category: 'system',
    permission: 'read',
    tags: ['system', 'snapshot', 'health'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const snap = await ctx.commander.handlers['system.snapshot']();
      return {
        hostname: snap.hostname,
        cpuPercent: snap.cpuPercent,
        memory: snap.memoryDetail,
        uptime: snap.uptimeLabel,
        esp: snap.esp ? { connected: snap.esp.connected, pc: snap.esp.pc, tempC: snap.esp.tempC, fw: snap.esp.fw } : null,
        policy: snap.policy,
        counters: snap.agent && snap.agent.counters,
      };
    },
  },
  {
    name: 'system.power',
    title: 'Power actions',
    description: 'Shut down, restart, sleep, lock, log out, or cancel a pending shutdown. Needs approval.',
    category: 'system',
    permission: 'system',
    tags: ['power', 'shutdown', 'restart', 'lock', 'sleep'],
    parameters: {
      type: 'object',
      properties: {
        action: P('what to do', { type: 'string', enum: ['shutdown', 'reboot', 'sleep', 'lock', 'logout', 'cancel'], default: 'lock' }),
        delaySeconds: P('countdown before shutdown/restart', { type: 'number', default: 30, minimum: 0, maximum: 3600 }),
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const map = {
        shutdown: 'system.shutdown',
        reboot: 'system.reboot',
        sleep: 'system.sleep',
        lock: 'system.lock',
        logout: 'system.logout',
        cancel: 'system.cancel_shutdown',
      };
      const command = map[args.action];
      if (!command) throw Object.assign(new Error(`unknown action ${args.action}`), { code: 'BAD_ARGS' });
      const result = await ctx.commander.execute(command, { delay: args.delaySeconds, confirm: true }, { source: 'ai' });
      return { action: args.action, result: result.data };
    },
  },
  {
    name: 'process.list',
    title: 'List processes',
    description: 'Running processes with CPU, memory and window titles.',
    category: 'system',
    permission: 'read',
    tags: ['process', 'task manager'],
    parameters: {
      type: 'object',
      properties: {
        limit: P('how many to return', { type: 'integer', default: 25, minimum: 1, maximum: 200 }),
        sort: P('sort order', { type: 'string', enum: ['cpu', 'mem'], default: 'cpu' }),
      },
      additionalProperties: false,
    },
    run: (args) => processList(args),
  },
  {
    name: 'process.find',
    title: 'Find a process',
    description: 'Find processes by name or window title fragment.',
    category: 'system',
    permission: 'read',
    tags: ['process', 'search'],
    parameters: {
      type: 'object',
      properties: { name: P('name fragment, e.g. "chrome"', { type: 'string', minLength: 2, maxLength: 120 }) },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args) {
      const found = await findProcesses(args.name);
      return { query: args.name, count: found.length, matches: found.slice(0, 30) };
    },
  },
  {
    name: 'process.kill',
    title: 'End a process',
    description: 'Terminate a process by PID. Requires approval; refuses protected system processes.',
    category: 'system',
    permission: 'system',
    tags: ['process', 'kill', 'terminate'],
    parameters: {
      type: 'object',
      properties: {
        pid: P('process id', { type: 'integer', minimum: 1 }),
        name: P('or a process name (first match is used)', { type: 'string', maxLength: 80 }),
      },
      additionalProperties: false,
    },
    guard(args) {
      if (!args.pid && !args.name) return { ok: false, code: 'BAD_ARGS', message: 'give pid or name' };
      if (args.name && /^(csrss|wininit|winlogon|services|lsass|smss|system|idle)$/i.test(args.name)) {
        return { ok: false, code: 'PROTECTED', message: `${args.name} is a core Windows process; refusing` };
      }
      if (args.pid === process.pid) return { ok: false, code: 'PROTECTED', message: 'that is the SENTINEL agent itself' };
      return { ok: true };
    },
    async run(args) {
      let pid = args.pid;
      if (!pid && args.name) {
        const found = await findProcesses(args.name);
        if (!found.length) throw Object.assign(new Error(`no process matching "${args.name}"`), { code: 'NOT_FOUND' });
        pid = found[0].pid;
      }
      if (IS_WINDOWS) await powershell(`Stop-Process -Id ${Number(pid)} -Force`, { timeout: 15000 });
      else await linux('kill', ['-TERM', String(pid)], { timeout: 8000 });
      return { pid, killed: true };
    },
  },
  {
    name: 'process.start',
    title: 'Start an application',
    description: 'Launch an application from the allow-list configured on the PC.',
    category: 'system',
    permission: 'system',
    tags: ['app', 'launch', 'start'],
    parameters: {
      type: 'object',
      properties: { name: P('the allow-listed application name', { type: 'string', minLength: 1, maxLength: 80 }) },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const result = await ctx.commander.execute('app.launch', { name: args.name, confirm: true }, { source: 'ai' });
      return result.data;
    },
  },
  {
    name: 'process.top',
    title: 'Heaviest processes',
    description: 'The five heaviest processes by CPU and by memory.',
    category: 'system',
    permission: 'read',
    tags: ['process', 'performance'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const byCpu = await processList({ limit: 5, sort: 'cpu' });
      const byMem = await processList({ limit: 5, sort: 'mem' });
      return { byCpu: byCpu.processes, byMemory: byMem.processes };
    },
  },
  {
    name: 'service.list',
    title: 'List services',
    description: 'Windows services (or systemd units) with their state.',
    category: 'system',
    permission: 'read',
    tags: ['service', 'daemon'],
    parameters: {
      type: 'object',
      properties: {
        runningOnly: P('only show running ones', { type: 'boolean', default: true }),
        limit: P('max entries', { type: 'integer', default: 40, minimum: 1, maximum: 300 }),
      },
      additionalProperties: false,
    },
    async run(args) {
      if (IS_WINDOWS) {
        const filter = args.runningOnly ? "| Where-Object { $_.Status -eq 'Running' }" : '';
        const rows = await powershellJson(
          `Get-Service ${filter} | Select-Object -First ${Number(args.limit)} | ForEach-Object { ` +
            `[pscustomobject]@{ name = $_.Name; display = $_.DisplayName; status = "$($_.Status)"; startup = "$($_.StartType)" } }`,
          { timeout: 20000 },
        );
        return { platform: 'windows', services: rows };
      }
      const rows = await linux('systemctl', ['list-units', '--type=service', '--no-pager', '--plain', args.runningOnly ? '--state=running' : '--all'], { timeout: 15000 });
      const services = rows.stdout
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts[0] && parts[0].endsWith('.service'))
        .slice(0, args.limit)
        .map((parts) => ({ name: parts[0], load: parts[1], active: parts[2], sub: parts[3], description: parts.slice(4).join(' ') }));
      return { platform: 'linux', services };
    },
  },
  {
    name: 'service.status',
    title: 'Service status',
    description: 'State and start type of one Windows service, read through the platform layer; never changes it.',
    category: 'system',
    permission: 'read',
    tags: ['service'],
    parameters: {
      type: 'object',
      properties: { name: P('service name', { type: 'string', minLength: 1, maxLength: 120 }) },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args) {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          `Get-Service -Name ${psString(args.name)} | ForEach-Object { [pscustomobject]@{ name = $_.Name; status = "$($_.Status)"; startup = "$($_.StartType)"; canStop = $_.CanStop } }`,
        );
        if (!rows.length) throw Object.assign(new Error(`service ${args.name} not found`), { code: 'NOT_FOUND' });
        return rows[0];
      }
      const result = await linux('systemctl', ['show', args.name, '--no-pager', '--property=ActiveState,SubState,UnitFileState,Description'], { timeout: 10000 });
      const fields = Object.fromEntries(
        result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const index = line.indexOf('=');
            return [line.slice(0, index), line.slice(index + 1)];
          }),
      );
      return { name: args.name, ...fields };
    },
  },
  {
    name: 'startup.list',
    title: 'Startup entries',
    description: 'Programs that start with the machine or at login.',
    category: 'system',
    permission: 'read',
    tags: ['startup', 'autostart', 'boot'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          'Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User',
          { timeout: 20000 },
        );
        return { platform: 'windows', entries: rows };
      }
      const dirs = [
        path.join(os.homedir(), '.config', 'autostart'),
        '/etc/xdg/autostart',
      ];
      const entries = [];
      for (const dir of dirs) {
        try {
          for (const name of await fsp.readdir(dir)) {
            if (!name.endsWith('.desktop')) continue;
            const text = await fsp.readFile(path.join(dir, name), 'utf8');
            const exec = (text.match(/^Exec=(.+)$/m) || [])[1] || '';
            const title = (text.match(/^Name=(.+)$/m) || [])[1] || name;
            entries.push({ name: title, command: exec.trim(), location: dir });
          }
        } catch {
          /* directory absent */
        }
      }
      return { platform: 'linux', entries };
    },
  },
  {
    name: 'windows.list',
    title: 'Open windows',
    description: 'Visible application windows with titles and process ids.',
    category: 'system',
    permission: 'read',
    tags: ['window', 'ui'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          `Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { ` +
            `[pscustomobject]@{ pid = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle } }`,
          { timeout: 15000 },
        );
        return { windows: rows };
      }
      const result = await linux('wmctrl', ['-l'], { timeout: 8000 }).catch(() => null);
      if (!result || result.code !== 0) {
        return { windows: [], note: 'no window manager control available on this system (install wmctrl for X11)' };
      }
      return {
        windows: result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const parts = line.split(/\s+/);
            return { id: parts[0], desktop: parts[1], host: parts[2], title: parts.slice(3).join(' ') };
          }),
      };
    },
  },
  {
    name: 'windows.focus',
    title: 'Focus a window',
    description: 'Bring the window of a process to the foreground. Needs approval.',
    category: 'system',
    permission: 'system',
    tags: ['window', 'focus'],
    parameters: {
      type: 'object',
      properties: { title: P('window title fragment', { type: 'string', minLength: 2, maxLength: 200 }) },
      required: ['title'],
      additionalProperties: false,
    },
    async run(args) {
      if (!IS_WINDOWS) throw new ExecError('focusing windows is implemented for Windows', { code: 'UNSUPPORTED_PLATFORM' });
      const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$target = Get-Process | Where-Object { $_.MainWindowTitle -like ${psString(`*${args.title}*`)} } | Select-Object -First 1
if (-not $target) { Write-Output '{"found":false}'; exit 0 }
[Win]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
[Win]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
Write-Output ("{""found"":true,""process"":""" + $target.ProcessName + """,""title"":""" + ($target.MainWindowTitle -replace '"','') + """}")
`;
      const result = await powershell(script, { timeout: 15000 });
      try {
        return JSON.parse(result.stdout.trim());
      } catch {
        return { found: false, raw: truncate(result.stdout, 300) };
      }
    },
  },
  {
    name: 'eventlog.read',
    title: 'Read event log',
    description: 'Recent error/warning entries from the system log (or journalctl on Linux).',
    category: 'system',
    permission: 'read',
    tags: ['log', 'event', 'diagnostics'],
    parameters: {
      type: 'object',
      properties: {
        limit: P('how many entries', { type: 'integer', default: 20, minimum: 1, maximum: 200 }),
        level: P('minimum level', { type: 'string', enum: ['error', 'warning', 'all'], default: 'error' }),
        source: P('optional provider/source filter, e.g. "Disk"', { type: 'string', maxLength: 80 }),
      },
      additionalProperties: false,
    },
    async run(args) {
      if (IS_WINDOWS) {
        const levelMap = { error: '1,2', warning: '2,3', all: '0,1,2,3' };
        const filter = args.source ? ` -ProviderName ${psString(args.source)}` : '';
        const rows = await powershellJson(
          `Get-WinEvent -FilterHashtable @{LogName='System'; Level=${levelMap[args.level] || '1,2'}}${filter} -MaxEvents ${Number(args.limit)} -ErrorAction SilentlyContinue | ` +
            `ForEach-Object { [pscustomobject]@{ time = $_.TimeCreated.ToString('s'); level = "$($_.LevelDisplayName)"; source = $_.ProviderName; id = $_.Id; message = ($_.Message -split "\`n")[0] } }`,
          { timeout: 30000 },
        );
        return { platform: 'windows', entries: rows };
      }
      const priority = args.level === 'error' ? 'err' : args.level === 'warning' ? 'warning' : 'info';
      const result = await linux('journalctl', [`-p`, priority, '-n', String(args.limit), '--no-pager', '-o', 'short-iso'], { timeout: 20000 });
      return {
        platform: 'linux',
        entries: result.stdout
          .split('\n')
          .filter(Boolean)
          .slice(-args.limit)
          .map((line) => ({ line: truncate(line, 300) })),
      };
    },
  },
  {
    name: 'memory.status',
    title: 'Memory and swap',
    description: 'Physical memory, swap and the heaviest consumers.',
    category: 'system',
    permission: 'read',
    tags: ['memory', 'ram'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const memory = ctx.stats ? ctx.stats.memory() : null;
      const total = os.totalmem();
      const free = os.freemem();
      const base = memory || { total, free, used: total - free, percent: Math.round(((total - free) / total) * 100) };
      const top = await processList({ limit: 5, sort: 'mem' });
      return { ...base, totalLabel: humanBytes(base.total), top: top.processes };
    },
  },
  {
    name: 'cpu.info',
    title: 'CPU information',
    description: 'CPU model, physical and logical cores, clock speed and current load, for sizing local model profiles.',
    category: 'system',
    permission: 'read',
    tags: ['cpu', 'processor'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const cpus = os.cpus();
      return {
        model: cpus[0] ? cpus[0].model.trim() : 'unknown',
        cores: cpus.length,
        speedMHz: cpus[0] ? cpus[0].speed : null,
        loadPercent: ctx.stats ? ctx.stats.read() : null,
        loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
        arch: os.arch(),
      };
    },
  },
  {
    name: 'gpu.info',
    title: 'GPU information',
    description: 'Graphics cards, VRAM and (with nvidia-smi) temperature, utilisation and memory in use.',
    category: 'system',
    permission: 'read',
    tags: ['gpu', 'nvidia', 'vram'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const out = { cards: [], nvidia: null };
      if (IS_WINDOWS) {
        const rows = await powershellJson('Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion, VideoProcessor', {
          timeout: 20000,
        });
        out.cards = rows.map((row) => ({
          name: row.Name,
          vramGB: row.AdapterRAM ? Number((row.AdapterRAM / 1024 ** 3).toFixed(1)) : null,
          driver: row.DriverVersion,
        }));
      } else {
        const result = await linux('lspci', [], { timeout: 8000 }).catch(() => null);
        if (result && result.code === 0) {
          out.cards = result.stdout
            .split('\n')
            .filter((line) => /vga|3d|display/i.test(line))
            .map((line) => ({ name: line.split(':').slice(2).join(':').trim() }));
        }
      }
      if (await which('nvidia-smi')) {
        const smi = await run(
          'nvidia-smi',
          ['--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,driver_version', '--format=csv,noheader,nounits'],
          { timeout: 10000 },
        );
        out.nvidia = smi.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [name, total, used, util, temp, driver] = line.split(',').map((part) => part.trim());
            return { name, vramTotalMB: Number(total), vramUsedMB: Number(used), utilisationPercent: Number(util), tempC: Number(temp), driver };
          });
      }
      if (!out.cards.length && !out.nvidia) out.note = 'no GPU reported by WMI/lspci/nvidia-smi';
      return out;
    },
  },
  {
    name: 'disk.volumes',
    title: 'Disk volumes',
    description: 'Mounted volumes with size, free space and filesystem.',
    category: 'system',
    permission: 'read',
    tags: ['disk', 'storage', 'free space'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          `Get-CimInstance Win32_LogicalDisk | ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID; label = $_.VolumeName; ` +
            `sizeGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1); filesystem = $_.FileSystem; type = $_.DriveType } }`,
          { timeout: 20000 },
        );
        return { volumes: rows };
      }
      const result = await linux('df', ['-kP'], { timeout: 10000 });
      const volumes = result.stdout
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 6)
        .map((parts) => ({
          filesystem: parts[0],
          sizeGB: Number((Number(parts[1]) / 1024 / 1024).toFixed(1)),
          usedGB: Number((Number(parts[2]) / 1024 / 1024).toFixed(1)),
          freeGB: Number((Number(parts[3]) / 1024 / 1024).toFixed(1)),
          percentUsed: Number(parts[4].replace('%', '')),
          mounted: parts.slice(5).join(' '),
        }));
      return { volumes };
    },
  },
  {
    name: 'disk.usage',
    title: 'What is using the disk',
    description: 'Size of the largest directories inside the workspace or a given path.',
    category: 'system',
    permission: 'read',
    tags: ['disk', 'size', 'du'],
    parameters: {
      type: 'object',
      properties: {
        path: P('directory to measure', { type: 'string', default: '.' }),
        limit: P('how many entries', { type: 'integer', default: 10, minimum: 1, maximum: 50 }),
      },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const target = args.path;
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const sizes = [];
      for (const entry of entries.slice(0, 200)) {
        const full = path.join(target, entry.name);
        try {
          if (entry.isDirectory()) {
            const result = await run(IS_WINDOWS ? 'powershell.exe' : 'du', IS_WINDOWS ? ['-NoProfile', '-Command', `(Get-ChildItem -LiteralPath '${full.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum`] : ['-sk', full], { timeout: 20000 });
            const kb = IS_WINDOWS ? Number(result.stdout.trim() || 0) : Number((result.stdout.split(/\s+/)[0] || 0)) * 1024;
            sizes.push({ name: `${entry.name}/`, bytes: kb, label: humanBytes(kb) });
          } else {
            const stat = await fsp.stat(full);
            sizes.push({ name: entry.name, bytes: stat.size, label: humanBytes(stat.size) });
          }
        } catch {
          /* unreadable entry */
        }
      }
      sizes.sort((a, b) => b.bytes - a.bytes);
      return { path: target, entries: sizes.slice(0, args.limit) };
    },
  },
  {
    name: 'battery.status',
    title: 'Battery',
    description: 'Battery charge state and remaining time, when the machine has one.',
    category: 'system',
    permission: 'read',
    tags: ['battery', 'power'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime',
          { timeout: 15000 },
        );
        if (!rows.length) return { present: false, note: 'this machine reports no battery (desktop)' };
        return { present: true, chargePercent: rows[0].EstimatedChargeRemaining, status: rows[0].BatteryStatus, minutesLeft: rows[0].EstimatedRunTime };
      }
      try {
        const capacity = Number((await fsp.readFile('/sys/class/power_supply/BAT0/capacity', 'utf8')).trim());
        const status = (await fsp.readFile('/sys/class/power_supply/BAT0/status', 'utf8')).trim();
        return { present: true, chargePercent: capacity, status };
      } catch {
        return { present: false, note: 'no BAT0 device (desktop or VM)' };
      }
    },
  },
  {
    name: 'sensors.temps',
    title: 'Temperatures',
    description: 'CPU/board temperatures from the OS, plus GPU temperature when nvidia-smi exists.',
    category: 'system',
    permission: 'read',
    tags: ['temperature', 'thermal', 'sensors'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const temps = [];
      if (!IS_WINDOWS) {
        try {
          const zones = await fsp.readdir('/sys/class/thermal');
          for (const zone of zones.filter((name) => name.startsWith('thermal_zone'))) {
            try {
              const kind = (await fsp.readFile(`/sys/class/thermal/${zone}/type`, 'utf8')).trim();
              const milli = Number((await fsp.readFile(`/sys/class/thermal/${zone}/temp`, 'utf8')).trim());
              temps.push({ source: kind, celsius: Number((milli / 1000).toFixed(1)) });
            } catch {
              /* zone disappeared */
            }
          }
        } catch {
          /* no thermal class */
        }
      }
      if (await which('nvidia-smi')) {
        const smi = await run('nvidia-smi', ['--query-gpu=temperature.gpu,fan.speed,power.draw', '--format=csv,noheader,nounits'], { timeout: 8000 });
        temps.push({ source: 'gpu', celsius: Number(smi.stdout.split(',')[0]), fanPercent: Number(smi.stdout.split(',')[1]), watts: Number(smi.stdout.split(',')[2]) });
      }
      if (!temps.length) return { temps: [], note: 'no temperature sensors exposed by this OS' };
      return { temps };
    },
  },
  {
    name: 'time.now',
    title: 'Current time',
    description: 'Local time, timezone and uptime of the machine.',
    category: 'system',
    permission: 'read',
    tags: ['time', 'date'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return {
        iso: new Date().toISOString(),
        local: new Date().toLocaleString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
      };
    },
  },
  {
    name: 'env.get',
    title: 'Environment variable',
    description: 'Read one environment variable (secrets are refused).',
    category: 'system',
    permission: 'read',
    tags: ['env', 'configuration'],
    parameters: {
      type: 'object',
      properties: { name: P('variable name', { type: 'string', minLength: 1, maxLength: 80 }) },
      required: ['name'],
      additionalProperties: false,
    },
    guard(args) {
      if (/key|token|secret|password|credential|psk/i.test(args.name || '')) {
        return { ok: false, code: 'SECRET', message: 'refusing to read a variable that looks like a credential' };
      }
      return { ok: true };
    },
    async run(args) {
      const value = process.env[args.name];
      return { name: args.name, defined: value !== undefined, value: value === undefined ? null : truncate(value, 500) };
    },
  },
  {
    name: 'clipboard.read',
    title: 'Read the clipboard',
    description: 'Current clipboard text (first 4000 characters).',
    category: 'system',
    permission: 'read',
    tags: ['clipboard'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (IS_WINDOWS) {
        const result = await powershell('Get-Clipboard -Raw', { timeout: 8000 });
        return { text: truncate(result.stdout, 4000), length: result.stdout.length };
      }
      const result = await linux('xclip', ['-selection', 'clipboard', '-o'], { timeout: 5000 }).catch(() => null);
      if (!result || result.code !== 0) return { text: '', note: 'no clipboard access (install xclip on X11)' };
      return { text: truncate(result.stdout, 4000), length: result.stdout.length };
    },
  },
  {
    name: 'clipboard.write',
    title: 'Write the clipboard',
    description: 'Put text on the clipboard. Needs approval.',
    category: 'system',
    permission: 'system',
    tags: ['clipboard'],
    parameters: {
      type: 'object',
      properties: { text: P('text to place on the clipboard', { type: 'string', maxLength: 20000 }) },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      if (IS_WINDOWS) await powershell(`Set-Clipboard -Value ${psString(args.text)}`, { timeout: 8000 });
      else {
        const child = require('node:child_process').spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end(args.text);
        await new Promise((resolve) => child.on('close', resolve));
      }
      return { written: args.text.length };
    },
  },
  {
    name: 'screen.info',
    title: 'Screen resolution',
    description: 'Display resolution and Windows scale factor, used when the assistant reasons about screenshots and coordinates.',
    category: 'system',
    permission: 'read',
    tags: ['screen', 'display'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          'Get-CimInstance Win32_VideoController | Select-Object CurrentHorizontalResolution, CurrentVerticalResolution, Name',
          { timeout: 15000 },
        );
        return {
          displays: rows.map((row) => ({
            name: row.Name,
            width: row.CurrentHorizontalResolution,
            height: row.CurrentVerticalResolution,
          })),
        };
      }
      const result = await linux('xrandr', ['--current'], { timeout: 6000 }).catch(() => null);
      if (!result || result.code !== 0) return { displays: [], note: 'no display server reachable' };
      return {
        displays: result.stdout
          .split('\n')
          .filter((line) => /\d+x\d+\+/.test(line))
          .map((line) => {
            const match = line.match(/(\d+)x(\d+)\+(\d+)\+(\d+)/);
            return { width: Number(match[1]), height: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
          }),
      };
    },
  },
  {
    name: 'screenshot.capture',
    title: 'Screenshot',
    description: 'Capture the screen to the workspace and return the file path.',
    category: 'system',
    permission: 'read',
    tags: ['screenshot', 'screen'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const result = await ctx.commander.execute('screen.screenshot', { confirm: true }, { source: 'ai' });
      return result.data;
    },
  },
  {
    name: 'installed.apps',
    title: 'Installed applications',
    description: 'Programs installed on this machine (Windows registry / Linux desktop entries).',
    category: 'system',
    permission: 'read',
    tags: ['apps', 'installed'],
    parameters: {
      type: 'object',
      properties: {
        filter: P('optional name fragment', { type: 'string', maxLength: 80 }),
        limit: P('max entries', { type: 'integer', default: 40, minimum: 1, maximum: 300 }),
      },
      additionalProperties: false,
    },
    async run(args) {
      let apps = [];
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          `Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | ` +
            `Where-Object { $_.DisplayName } | ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; version = $_.DisplayVersion; publisher = $_.Publisher; date = $_.InstallDate } }`,
          { timeout: 40000 },
        );
        apps = rows;
      } else {
        const dirs = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')];
        for (const dir of dirs) {
          try {
            for (const name of await fsp.readdir(dir)) {
              if (!name.endsWith('.desktop')) continue;
              const text = await fsp.readFile(path.join(dir, name), 'utf8');
              const title = (text.match(/^Name=(.+)$/m) || [])[1];
              const exec = (text.match(/^Exec=(.+)$/m) || [])[1];
              if (title) apps.push({ name: title.trim(), command: exec ? exec.trim().split(' ')[0] : null });
            }
          } catch {
            /* absent */
          }
        }
      }
      if (args.filter) {
        const needle = args.filter.toLowerCase();
        apps = apps.filter((app) => String(app.name).toLowerCase().includes(needle));
      }
      const seen = new Set();
      const unique = apps.filter((app) => {
        const key = String(app.name).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { count: unique.length, apps: unique.slice(0, args.limit) };
    },
  },
  {
    name: 'hotfix.list',
    title: 'Installed updates',
    description: 'Recently installed OS updates (Windows hotfixes / Linux package manager summary).',
    category: 'system',
    permission: 'read',
    tags: ['updates', 'windows update', 'patch'],
    parameters: {
      type: 'object',
      properties: { limit: P('max entries', { type: 'integer', default: 10, minimum: 1, maximum: 50 }) },
      additionalProperties: false,
    },
    async run(args) {
      if (IS_WINDOWS) {
        const rows = await powershellJson(
          `Get-CimInstance Win32_QuickFixEngineering | Sort-Object InstalledOn -Descending | Select-Object -First ${Number(args.limit)} | Select-Object HotFixID, Description, InstalledOn`,
          { timeout: 30000 },
        );
        return { platform: 'windows', hotfixes: rows };
      }
      const result = await linux('bash', ['-lc', 'tail -n 20 /var/log/dpkg.log 2>/dev/null | grep " install " | tail -10'], { timeout: 8000 }).catch(() => null);
      return { platform: 'linux', recentInstalls: result ? result.stdout.split('\n').filter(Boolean) : [] };
    },
  },
];
