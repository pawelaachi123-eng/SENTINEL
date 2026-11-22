#!/usr/bin/env node
'use strict';

/**
 * Copies the shared UI into the Capacitor project so the Android app ships the
 * exact same interface as the desktop window, then syncs it into the native
 * project. Run: npm run mobile:sync
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'ui');
const target = path.join(root, 'mobile', 'www');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

fs.rmSync(target, { recursive: true, force: true });
copyDir(source, target);
console.log(`UI copied to ${path.relative(root, target)}`);

try {
  const { execFileSync } = require('node:child_process');
  execFileSync('npx', ['cap', 'sync', 'android'], { cwd: path.join(root, 'mobile'), stdio: 'inherit' });
} catch (err) {
  console.log('Capacitor sync skipped (run "npx cap sync android" inside mobile/ once dependencies are installed).');
}
