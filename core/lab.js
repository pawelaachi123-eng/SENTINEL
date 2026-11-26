'use strict';

/**
 * Compatibility entry point. The laboratory now has one facade:
 * `core/lab/index.js` exports both the training lab and the legacy learning
 * lab. Older requires of `./lab` keep working without a second implementation.
 */

module.exports = require('./lab/index.js');
