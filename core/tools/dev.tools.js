'use strict';

/**
 * Developer tooling: running builds, tests and linters.
 *
 * This is the only place where the assistant can execute a command, and it is
 * not a shell. A command is accepted only when it matches an allow-list, is
 * passed as an argv array, contains no shell metacharacters, and runs inside the
 * workspace or project root with a timeout. `ai.tools.allowShell` must be on —
 * it is off by default.
 *
 * The point is not to stop a determined user; it is to make a prompt-injected
 * "run this" impossible by construction.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { run, readTextFile, which, IS_WINDOWS } = require('./helpers');

const ALLOWED = [
  { pattern: /^npm (test|run [a-z0-9:_-]+)$/i, note: 'npm scripts' },
  { pattern: /^npm ci$/i, note: 'npm install' },
  { pattern: /^node --check [\w./-]+$/i, note: 'syntax check' },
  { pattern: /^node [\w./-]+\.js( [\w./=-]+)*$/i, note: 'run a script' },
  { pattern: /^npx (eslint|tsc|prettier|jest|vitest)( [\w./=@-]+)*$/i, note: 'npx tools' },
  { pattern: /^python3? -m (pytest|unittest|compileall)( [\w./=-]+)*$/i, note: 'python tests' },
  { pattern: /^dotnet (build|test|run)( [\w./=-]+)*$/i, note: 'dotnet' },
  { pattern: /^git (status|diff|log|show|rev-parse|fetch|pull)( [\w./~^@=-]+)*$/i, note: 'git read operations' },
  { pattern: /^gradlew? (test|build|assembleDebug)( [\w./=-]+)*$/i, note: 'gradle' },
  { pattern: /^pio (run|test)( [-a-z0-9]+)*$/i, note: 'platformio' },
  { pattern: /^cargo (test|build|check)( [-a-z0-9]+)*$/i, note: 'cargo' },
];

const FORBIDDEN_CHARS = /[;&|><`$(){}\n\r]/;

function splitCommand(command) {
  // Deliberately naive: we reject quotes/escapes rather than interpret them.
  return String(command).trim().split(/\s+/).filter(Boolean);
}

module.exports = [
  {
    name: 'dev.command',
    title: 'Run an allowed command',
    description: 'Run a build/test/lint command from the allow-list (npm test, node --check, pytest, git status...). Needs the shell switch and approval.',
    category: 'dev',
    permission: 'system',
    tags: ['dev', 'build', 'test', 'command'],
    timeoutMs: 180000,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 2, maxLength: 300 },
        cwd: { type: 'string', description: 'working directory', default: '.' },
        timeoutMs: { type: 'integer', default: 120000, minimum: 1000, maximum: 300000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'cwd', mode: 'read' }],
    guard(args, ctx) {
      if (ctx.config.get('ai.tools.allowShell') !== true) {
        return { ok: false, code: 'SHELL_DISABLED', message: 'running commands is switched off (Settings → AI → allowShell)' };
      }
      const command = String(args.command || '').trim();
      if (FORBIDDEN_CHARS.test(command)) {
        return { ok: false, code: 'SHELL_INJECTION', message: 'the command contains shell metacharacters, which are never allowed' };
      }
      if (!ALLOWED.some((entry) => entry.pattern.test(command))) {
        return { ok: false, code: 'COMMAND_NOT_ALLOWED', message: 'that command is not on the allow-list' };
      }
      return { ok: true };
    },
    async run(args, ctx) {
      const [binary, ...argv] = splitCommand(args.command);
      const executable = binary === 'gradlew' || binary === 'gradlew.bat' ? path.join(args.cwd, IS_WINDOWS ? 'gradlew.bat' : 'gradlew') : binary;
      if (binary !== 'gradlew' && binary !== 'gradlew.bat' && !(await which(binary))) {
        throw Object.assign(new Error(`${binary} is not installed on this machine`), { code: 'NOT_INSTALLED' });
      }
      const result = await run(executable, argv, {
        cwd: args.cwd,
        timeout: args.timeoutMs,
        signal: ctx.signal,
        maxBytes: 2 * 1024 * 1024,
        env: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      });
      if (this.log) this.log.info('dev', `${args.command} → exit ${result.code} (${result.ms}ms)`);
      const tail = (text, limit = 6000) => (text.length > limit ? `…\n${text.slice(-limit)}` : text);
      return {
        command: args.command,
        cwd: args.cwd,
        exitCode: result.code,
        ok: result.code === 0,
        ms: result.ms,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
      };
    },
    format(data) {
      return `$ ${data.command}  (exit ${data.exitCode}, ${data.ms}ms)\n${data.stdout}${data.stderr ? `\n${data.stderr}` : ''}`.trim();
    },
  },
  {
    name: 'dev.scripts',
    title: 'Package scripts',
    description: 'Scripts available in package.json (or Makefile targets), so the assistant knows how to run the project.',
    category: 'dev',
    permission: 'read',
    tags: ['npm', 'scripts', 'build'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', default: '.' } },
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      const scripts = {};
      try {
        const parsed = JSON.parse((await readTextFile(path.join(args.path, 'package.json'), { maxBytes: 400000 })).text);
        Object.assign(scripts, parsed.scripts || {});
      } catch {
        /* no package.json */
      }
      let makeTargets = [];
      try {
        const makefile = await readTextFile(path.join(args.path, 'Makefile'), { maxBytes: 200000 });
        makeTargets = [...makefile.text.matchAll(/^([a-zA-Z0-9_-]+):(?!=)/gm)].map((match) => match[1]);
      } catch {
        /* no Makefile */
      }
      return { path: args.path, scripts, makeTargets, hints: ['npm test', 'npm run build', 'node --check file.js'] };
    },
  },
  {
    name: 'dev.versions',
    title: 'Toolchain versions',
    description: 'Node, npm, Python, Git, Java, dotnet and PlatformIO versions available on this machine.',
    category: 'dev',
    permission: 'read',
    tags: ['versions', 'toolchain'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const probes = [
        ['node', ['--version']],
        ['npm', ['--version']],
        ['python3', ['--version']],
        ['python', ['--version']],
        ['git', ['--version']],
        ['java', ['-version']],
        ['dotnet', ['--version']],
        ['pio', ['--version']],
        ['ffmpeg', ['-version']],
        ['tesseract', ['--version']],
        ['nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader']],
      ];
      const versions = {};
      for (const [binary, argv] of probes) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await which(binary))) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await run(binary, argv, { timeout: 6000 });
          const line = (result.stdout || result.stderr).split('\n')[0].trim();
          if (line) versions[binary] = line.slice(0, 120);
        } catch {
          /* ignore probe failures */
        }
      }
      return { versions, platform: process.platform, arch: process.arch, nodeRuntime: process.version };
    },
  },
  {
    name: 'dev.lint.syntax',
    title: 'Syntax check',
    description: 'Run node --check on a JavaScript file and report the exact error if it does not parse.',
    category: 'dev',
    permission: 'read',
    tags: ['syntax', 'check', 'javascript'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    async run(args) {
      if (!/\.(js|cjs|mjs)$/i.test(args.path)) {
        throw Object.assign(new Error('syntax checking is implemented for JavaScript files'), { code: 'UNSUPPORTED' });
      }
      const result = await run(process.execPath, ['--check', args.path], { timeout: 20000 });
      return { path: args.path, ok: result.code === 0, stderr: result.stderr.slice(0, 4000) };
    },
  },
  {
    name: 'project.roots',
    title: 'Where the assistant may work',
    description: 'The sandbox roots: workspace, data, project checkout and any extra folders the user allowed.',
    category: 'dev',
    permission: 'read',
    tags: ['sandbox', 'roots', 'paths'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return {
        roots: ctx.sandbox.roots().map((root) => ({ label: root.label, path: root.path, mode: root.mode })),
        allowShell: ctx.config.get('ai.tools.allowShell') === true,
        network: ctx.config.get('ai.tools.allowNetwork') !== false,
        note: 'writes are limited to workspace and data; secrets such as .ssh and .env are refused everywhere',
      };
    },
  },
];

module.exports.ALLOWED = ALLOWED;
