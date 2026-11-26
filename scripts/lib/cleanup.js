'use strict';

const fs = require('node:fs');

/**
 * Removes a temporary SENTINEL_HOME after a run.
 *
 * SQLite on Windows keeps the database handle briefly after close(), so an
 * immediate recursive delete fails with EBUSY/EPERM. Retrying preserves the
 * real result of the run instead of failing the build in cleanup.
 */
async function removeHome(home, { agent = null, log = console } = {}) {
  try {
    agent?.store?.close?.();
  } catch {
    /* already closed */
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code)) {
        log.warn(`warning: could not remove ${home}: ${err.message}`);
        return false;
      }
      if (attempt === 5) {
        if (process.platform === 'win32') log.warn(`warning: could not remove ${home}: ${err.message}`);
        return false;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  return false;
}

module.exports = { removeHome };
