#!/usr/bin/env node
'use strict';

/**
 * SENTINEL headless agent.
 *
 *   sentinel-agent                 start with the saved config
 *   sentinel-agent --open          start and open the control window in a browser
 *   sentinel-agent --pair          print the ESP32 / phone pairing block
 *   sentinel-agent --port 8080     override the UI port for this run
 *   sentinel-agent --install       print how to auto-start at login
 */

const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAgent } = require('../core/agent');
const { dataDir } = require('../core/paths');

function parseArgs(argv) {
  const args = { open: false, pair: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--open') args.open = true;
    else if (arg === '--pair') args.pair = true;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--link-port') args.linkPort = Number(argv[++i]);
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--install') args.install = true;
    else if (arg === '--version') args.version = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* no browser available (headless server) */
  }
}

const args = parseArgs(process.argv);

if (args.version) {
  console.log(require('../package.json').version);
  process.exit(0);
}

if (args.help) {
  console.log(`SENTINEL agent
  --open            open the control UI in a browser
  --pair            print pairing details and exit
  --port <n>        UI/API port (default 7878)
  --link-port <n>   ESP32 link port (default 7879)
  --config <path>   use an alternative config file
  --install         print auto-start instructions
  --verbose         mirror the activity log to stdout
  --version
`);
  process.exit(0);
}

if (args.install) {
  console.log(`Auto-start SENTINEL with your session:

  Windows (recommended): run "SENTINEL Setup" and tick "Start with Windows",
  or create a shortcut in shell:startup pointing at SENTINEL-Agent.exe.

  Linux (systemd user unit):
    mkdir -p ~/.config/systemd/user
    cat > ~/.config/systemd/user/sentinel.service <<'EOF'
    [Unit]
    Description=SENTINEL agent
    [Service]
    ExecStart=${process.execPath} ${path.resolve(__dirname, 'sentinel-agent.js')}
    Restart=always
    [Install]
    WantedBy=default.target
    EOF
    systemctl --user enable --now sentinel

  macOS: add a LaunchAgent plist in ~/Library/LaunchAgents.

  Config and logs live in: ${dataDir()}`);
  process.exit(0);
}

if (args.verbose) process.env.SENTINEL_VERBOSE = '1';

const agent = createAgent({ configPath: args.config });
if (args.port) agent.config.merge({ ports: { ui: args.port } });
if (args.linkPort) agent.config.merge({ ports: { link: args.linkPort } });
agent.start();

const token = agent.config.get('uiToken');
const host = agent.http.primaryAddress();

if (args.pair) {
  const snippet = agent.config.pairingSnippet(host);
  console.log('\n--- ESP32 provisioning -------------------------------------');
  for (const [key, value] of Object.entries(snippet)) console.log(`${key.padEnd(12)} = ${value}`);
  console.log('------------------------------------------------------------');
  console.log(`Phone UI  http://${host}:${agent.config.get('ports.ui')}/?t=${token}`);
  console.log(`Config    ${agent.config.file}`);
  agent.stop();
  process.exit(0);
}

console.log(`
  ███████ ███████ ███    ██ ████████ ██ ███    ██ ███████ ██
  ██      ██      ████   ██    ██    ██ ████   ██ ██      ██
  ███████ █████   ██ ██  ██    ██    ██ ██ ██  ██ █████   ██
       ██ ██      ██  ██ ██    ██    ██ ██  ██ ██ ██      ██
  ███████ ███████ ██   ████    ██    ██ ██   ████ ███████ ███████

  PC agent  ${os.hostname()} · ${process.platform}/${process.arch}
  Control   ${agent.loginUrl}
  Phone     ${agent.lanUrl}
  Data      ${dataDir()}
  ESP32     waiting on TCP ${agent.config.get('ports.link')} (pairing key in the UI)
`);

if (args.open) openBrowser(agent.loginUrl);

const shutdown = (signal) => {
  console.log(`\n[${signal}] shutting down`);
  agent.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  agent.log.error('agent', `Unhandled rejection: ${err && err.message ? err.message : err}`);
});
