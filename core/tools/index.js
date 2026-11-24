'use strict';

/**
 * One place that assembles the tool engine.
 *
 * Every module below exports an array of tool definitions; registration is
 * strict, so a duplicate name or a missing run() fails at startup rather than at
 * 2 a.m. when the model decides to call it.
 */

const { ToolRegistry } = require('./registry');

const MODULES = ['system', 'network', 'files', 'code', 'docs', 'math', 'dev', 'device', 'memory', 'ai', 'tasks', 'security', 'voice', 'patch', 'graph', 'mcp', 'runtime', 'org', 'neural', 'reason', 'skills', 'repo', 'lab', 'research', 'analytics', 'text'];

/**
 * @param {{config, log, sandbox, approvals, services}} deps
 * @returns {ToolRegistry}
 */
function buildTools({ config, log, sandbox, approvals, services = {} }) {
  const registry = new ToolRegistry({ config, log, sandbox, approvals, services });
  const loaded = [];
  for (const name of MODULES) {
    let module_;
    try {
      module_ = require(`./${name}.tools`);
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(`${name}.tools`)) continue;
      throw err;
    }
    const tools = Array.isArray(module_) ? module_ : module_.tools || [];
    registry.registerAll(tools);
    loaded.push({ module: name, tools: tools.length });
  }
  if (log) log.info('tools', `${registry.tools.size} tools across ${registry.categories().length} categories`, { modules: loaded.length });
  return registry;
}

module.exports = { buildTools, MODULES };
