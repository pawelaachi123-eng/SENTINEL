'use strict';

/**
 * Hierarchical organisation over the existing roster.
 *
 * This adds structure, not head-count. Every agent that exists keeps its single
 * responsibility; no duplicates are created to reach a number. The hierarchy is
 * derived from what an agent can actually do:
 *
 *   executive    supervisor/planning — decompose and arbitrate
 *   lead         the agent whose capabilities cover a domain
 *   specialist   model-backed agents with domain instructions
 *   worker       deterministic tool agents
 *
 * Delegation is one-way and bounded: a lead may hand work to workers or
 * specialists, never to itself, never upward, and never more than
 * `maxDepth` levels. An organisation chart that cannot change its own
 * permissions is the point.
 */

const TIERS = ['executive', 'lead', 'specialist', 'worker'];

const DOMAINS = {
  windows: ['windows', 'configuration'],
  hardware: ['hardware', 'gaming', 'optimization'],
  code: ['coding', 'debugging', 'testing', 'repair'],
  knowledge: ['research', 'knowledge', 'document', 'memory'],
  security: ['security', 'verification', 'verification_planner'],
  devices: ['esp32', 'mobile', 'automation'],
  communication: ['conversation', 'voice', 'vision'],
  operations: ['loganalysis', 'network', 'update', 'file', 'esp32'],
};

function tierOf(agent) {
  if (['supervisor', 'planning'].includes(agent.name)) return 'executive';
  if (agent.role === 'tool' || agent.role === 'deterministic') return 'worker';
  if (agent.role === 'llm') return 'specialist';
  return 'specialist';
}

class Organisation {
  constructor({ agents = null, log = null, maxDepth = 2 } = {}) {
    this.agents = agents;
    this.log = log;
    this.maxDepth = Math.max(1, Math.min(3, Number(maxDepth) || 2));
  }

  roster() {
    if (!this.agents) return [];
    return [...this.agents.agents.values()];
  }

  capabilitiesOf(agent) {
    const capabilities = new Set();
    for (const category of agent.categories || []) capabilities.add(category);
    for (const trigger of agent.triggers || []) capabilities.add(String(trigger).toLowerCase());
    return [...capabilities];
  }

  chart() {
    const tiers = Object.fromEntries(TIERS.map((tier) => [tier, []]));
    for (const agent of this.roster()) {
      tiers[tierOf(agent)].push({
        name: agent.name,
        title: agent.title,
        role: agent.role,
        categories: agent.categories || [],
        capabilities: this.capabilitiesOf(agent).slice(0, 8),
      });
    }
    const leads = {};
    for (const [domain, members] of Object.entries(DOMAINS)) {
      const present = members.filter((name) => this.agents.get(name));
      if (!present.length) continue;
      // The lead is the first listed specialist for the domain that exists; no
      // invented appointment and no second persona.
      leads[domain] = present[0];
    }
    return {
      tiers,
      counts: Object.fromEntries(TIERS.map((tier) => [tier, tiers[tier].length])),
      total: this.roster().length,
      domains: Object.fromEntries(Object.entries(leads).map(([domain, lead]) => [domain, { lead, members: DOMAINS[domain].filter((name) => this.agents.get(name)) }])),
      maxDepth: this.maxDepth,
    };
  }

  /** Picks a lead by capability overlap, deterministically. */
  leadFor(capability) {
    const wanted = String(capability || '').toLowerCase().trim();
    if (!wanted) return { ok: false, code: 'BAD_ARGS', message: 'a capability is required' };
    const scored = this.roster()
      .filter((agent) => tierOf(agent) !== 'executive')
      .map((agent) => {
        const capabilities = this.capabilitiesOf(agent);
        const exact = capabilities.filter((entry) => entry === wanted).length;
        const partial = capabilities.filter((entry) => entry.includes(wanted) || wanted.includes(entry)).length;
        return { agent, score: exact * 3 + partial };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));
    if (!scored.length) return { ok: false, code: 'NO_LEAD', message: `no agent advertises ${wanted}` };
    return { ok: true, lead: scored[0].agent.name, score: scored[0].score, alternatives: scored.slice(1, 4).map((entry) => entry.agent.name) };
  }

  /**
   * A delegation preview: lead plus the workers/specialists it would use.
   * It returns a plan, never executes anything, and it cannot assign an agent to
   * a tier above itself.
   */
  planDelegation({ capability, taskClass = null, workers = 2 } = {}) {
    const lead = this.leadFor(capability);
    if (!lead.ok) return lead;
    const leadTier = TIERS.indexOf(tierOf(this.agents.get(lead.lead)));
    const domainMembers = (DOMAINS[String(capability).toLowerCase()] || []).filter((name) => name !== lead.lead && this.agents.get(name));
    const candidates = this.roster()
      .filter((agent) => agent.name !== lead.lead)
      .filter((agent) => TIERS.indexOf(tierOf(agent)) >= leadTier)
      // A domain's listed members are the first choice for support, because the
      // domain list encodes which responsibilities actually belong together.
      .sort((a, b) => (domainMembers.includes(b.name) ? 1 : 0) - (domainMembers.includes(a.name) ? 1 : 0))
      .map((agent) => ({
        agent,
        overlap: domainMembers.includes(agent.name)
          ? 2
          : this.capabilitiesOf(agent).filter((entry) => String(capability).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).some((part) => entry.includes(part) || part.includes(entry))).length,
      }))
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.agent.name.localeCompare(b.agent.name));
    const chosen = candidates.slice(0, Math.max(0, workers));
    const depth = chosen.length ? 2 : 1;
    if (depth > this.maxDepth) return { ok: false, code: 'DEPTH_EXCEEDED', message: `delegation depth ${depth} exceeds ${this.maxDepth}` };
    return {
      ok: true,
      capability: String(capability),
      taskClass,
      lead: lead.lead,
      leadTier: tierOf(this.agents.get(lead.lead)),
      workers: chosen.map((entry) => ({ name: entry.agent.name, tier: tierOf(entry.agent), overlap: entry.overlap })),
      depth,
      maxDepth: this.maxDepth,
      note: 'preview only — nothing was executed and no permissions changed',
    };
  }
}

module.exports = { Organisation, DOMAINS, TIERS, tierOf };
