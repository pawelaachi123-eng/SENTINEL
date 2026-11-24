'use strict';

/**
 * Filesystem sandbox.
 *
 * Default deny. A path is usable only if it resolves — after symlinks — inside
 * one of the configured roots, and only in the mode that root allows:
 *
 *   workspace   read + write   (SENTINEL's own scratch space)
 *   data        read + write   (memory, knowledge, logs — but never config.json)
 *   project     read only      (the SENTINEL checkout, for code questions)
 *   knowledge   read only      (folders the user indexed)
 *   extra       explicit opt-in roots from settings
 *
 * Secrets and credential stores are refused everywhere, including inside the
 * workspace, because "write a file next to my project" is a normal request and
 * "write my SSH key" is not.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

class SandboxError extends Error {
  constructor(message, { code = 'SANDBOX_DENIED', path: attempted = '' } = {}) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.path = attempted;
  }
}

const SECRET_PATTERNS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[\\/])(credentials|secrets?|passwords?)(\.[a-z0-9]+)?$/i,
  /(^|[\\/])\.env(\.|$)/i,
  /\.(pem|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])config\.json$/i,
  /(^|[\\/])Login Data$/i,
  /(^|[\\/])Cookies$/i,
  /(^|[\\/])Local State$/i,
];

function isSecretPath(target) {
  const value = String(target || '').replace(/\\/g, '/');
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

class Sandbox {
  constructor({ config, log, paths }) {
    this.config = config;
    this.log = log;
    this.paths = paths;
    this.extraRoots = Array.isArray(config && config.get('ai.tools.roots')) ? config.get('ai.tools.roots') : [];
  }

  roots() {
    const ai = (this.config && this.config.get('ai')) || {};
    const workspace = (ai.tools && ai.tools.workspace) || this.paths.workspaceDir();
    const list = [
      { path: workspace, mode: 'rw', label: 'workspace' },
      { path: this.paths.dataDir(), mode: 'rw', label: 'data' },
      { path: this.paths.knowledgeDir(), mode: 'ro', label: 'knowledge' },
      { path: path.join(__dirname, '..', '..'), mode: 'ro', label: 'project' },
    ];
    for (const extra of this.extraRoots) {
      const resolved = path.resolve(String(extra));
      list.push({ path: resolved, mode: 'ro', label: 'extra' });
    }
    return list;
  }

  /** Expands ~ and makes the path absolute without touching the disk. */
  normalise(input) {
    let value = String(input == null ? '' : input).trim();
    if (!value) throw new SandboxError('empty path', { code: 'BAD_PATH' });
    if (value === '~') value = os.homedir();
    else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
    value = value.replace(/%([A-Z_]+)%/gi, (match, name) => process.env[name] || match);
    if (/^[a-z]+:\/\//i.test(value)) throw new SandboxError('URLs are not paths', { code: 'BAD_PATH' });
    const absolute = path.isAbsolute(value) ? value : path.resolve(this.defaultRoot(), value);
    if (absolute.length > 4096) throw new SandboxError('path too long', { code: 'BAD_PATH' });
    if (absolute.includes('\0')) throw new SandboxError('path contains a null byte', { code: 'BAD_PATH' });
    return path.normalize(absolute);
  }

  defaultRoot() {
    const ai = (this.config && this.config.get('ai')) || {};
    return (ai.tools && ai.tools.workspace) || this.paths.workspaceDir();
  }

  /** Real path of the nearest existing ancestor, so symlink escapes are caught. */
  realAncestor(target) {
    let current = target;
    for (let depth = 0; depth < 40; depth += 1) {
      try {
        return fs.realpathSync(current);
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    }
    return current;
  }

  contains(rootPath, target) {
    const root = path.resolve(rootPath);
    const value = path.resolve(target);
    const relative = path.relative(root, value);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  /**
   * @param {string} input
   * @param {{write?: boolean, mustExist?: boolean, allowSecret?: boolean}} options
   * @returns {string} absolute, verified path
   */
  resolve(input, { write = false, mustExist = false, allowSecret = false } = {}) {
    const absolute = this.normalise(input);
    if (!allowSecret && isSecretPath(absolute)) {
      throw new SandboxError('that path holds credentials and is never readable by the assistant', {
        code: 'SECRET_PATH',
        path: absolute,
      });
    }

    const roots = this.roots();
    const real = this.realAncestor(absolute);
    const owner = roots.find((root) => {
      const realRoot = this.realAncestor(path.resolve(root.path));
      return this.contains(realRoot, real) || this.contains(path.resolve(root.path), absolute);
    });

    if (!owner) {
      throw new SandboxError(
        `outside the allowed roots. SENTINEL may work inside ${roots.map((root) => root.label).join(', ')}${this.extraRoots.length ? ' and the roots you added' : ''}`,
        { code: 'OUTSIDE_SANDBOX', path: absolute },
      );
    }
    if (write && owner.mode !== 'rw') {
      throw new SandboxError(`${owner.label} is read-only`, { code: 'READ_ONLY', path: absolute });
    }
    if (write && !allowSecret && isSecretPath(path.dirname(absolute))) {
      throw new SandboxError('refusing to write inside a credential directory', { code: 'SECRET_PATH', path: absolute });
    }
    if (mustExist && !fs.existsSync(absolute)) {
      throw new SandboxError('no such file or directory', { code: 'NOT_FOUND', path: absolute });
    }
    return absolute;
  }

  /** Relative form for display and audit logs. */
  display(absolute) {
    const workspace = path.resolve(this.defaultRoot());
    const relative = path.relative(workspace, absolute);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    return absolute;
  }
}

module.exports = { Sandbox, SandboxError, isSecretPath };
