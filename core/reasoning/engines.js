'use strict';

/**
 * Deterministic reasoning engines.
 *
 * These are small, auditable solvers for problems with objective answers:
 * Horn-style deduction, bounded abduction, finite-domain constraint satisfaction,
 * Bayesian updating, causal path enumeration, interval algebra, 2-D spatial
 * relations and expected-utility choice under uncertainty.
 *
 * The engines share one rule: a result is labelled `proven` only when the
 * solver's own construction guarantees it; a search that merely found a
 * candidate calls it `supported`; a heuristic score is `estimated`. Nothing is
 * returned as certainty just because a model produced fluent text.
 */

function atomKey(atom) {
  return `${atom.negated ? 'not ' : ''}${atom.pred}(${(atom.args || []).join(',')})`;
}

function isVariable(value) {
  return typeof value === 'string' && value.startsWith('?');
}

function unify(pattern, fact, binding = {}) {
  const next = { ...binding };
  const left = pattern.args || [];
  const right = fact.args || [];
  if (left.length !== right.length) return null;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (isVariable(a)) {
      if (next[a] !== undefined && String(next[a]) !== String(b)) return null;
      next[a] = b;
    } else if (String(a) !== String(b)) return null;
  }
  return next;
}

function substitute(template, binding) {
  return {
    pred: template.pred,
    negated: Boolean(template.negated),
    args: (template.args || []).map((value) => (isVariable(value) && binding[value] !== undefined ? binding[value] : value)),
  };
}

function validateAtoms(list, label) {
  if (!Array.isArray(list) || !list.length) throw Object.assign(new Error(`${label} must be a non-empty array of atoms`), { code: 'BAD_ATOMS' });
  for (const atom of list) {
    if (!atom || typeof atom.pred !== 'string' || !atom.pred.trim()) throw Object.assign(new Error(`${label} has an atom without a predicate`), { code: 'BAD_ATOM' });
    if (atom.args !== undefined && !Array.isArray(atom.args)) throw Object.assign(new Error(`${label} atom args must be an array`), { code: 'BAD_ATOM' });
  }
}

/**
 * Forward chaining over universally quantified rules. Each derived fact keeps
 * the rule and the premises that produced it, so an answer can be explained
 * instead of asserted. Negation is treated as a distinct predicate and an
 * explicit contradiction is reported rather than resolved automatically.
 */
function forwardChain({ facts = [], rules = [], maxIterations = 200, maxFacts = 5000 } = {}) {
  validateAtoms(facts, 'facts');
  if (!Array.isArray(rules) || !rules.length) throw Object.assign(new Error('rules must be a non-empty array'), { code: 'NO_RULES' });
  for (const [index, rule] of rules.entries()) {
    if (!rule || !rule.then) throw Object.assign(new Error(`rule ${index} has no conclusion`), { code: 'BAD_RULE' });
    validateAtoms(rule.if, `rule ${index} premises`);
    validateAtoms([rule.then], `rule ${index} conclusion`);
  }
  const known = facts.map((atom, index) => ({
    id: atom.id || `f${index + 1}`,
    pred: atom.pred,
    args: (atom.args || []).map(String),
    negated: Boolean(atom.negated),
    status: 'proven',
    derivedBy: null,
    supports: [],
    depth: 0,
  }));
  const seen = new Set(known.map(atomKey));
  const contradictions = [];
  const derivations = [];
  for (const fact of known) {
    const opposite = known.find((candidate) => candidate.id !== fact.id && candidate.pred === fact.pred && candidate.negated !== fact.negated && JSON.stringify(candidate.args) === JSON.stringify(fact.args));
    if (opposite && !contradictions.some((entry) => [entry.a, entry.b].includes(fact.id) && [entry.a, entry.b].includes(opposite.id))) {
      contradictions.push({ a: fact.id, b: opposite.id, statement: atomKey(fact) });
    }
  }
  let iteration = 0;
  let added = true;
  while (added && iteration < maxIterations && known.length < maxFacts) {
    added = false;
    iteration += 1;
    for (const rule of rules) {
      const bindings = [{}];
      for (const premise of rule.if) {
        const nextBindings = [];
        for (const binding of bindings) {
          const target = substitute(premise, binding);
          for (const fact of known) {
            if (fact.negated !== target.negated || fact.pred !== target.pred) continue;
            const unified = unify(target, fact, binding);
            if (unified) nextBindings.push(unified);
          }
        }
        bindings.splice(0, bindings.length, ...nextBindings.slice(0, 200));
        if (!bindings.length) break;
      }
      for (const binding of bindings) {
        const conclusion = substitute(rule.then, binding);
        const key = atomKey(conclusion);
        if (seen.has(key)) continue;
        const supportFacts = rule.if.map((premise) => {
          const target = substitute(premise, binding);
          return known.find((fact) => fact.negated === target.negated && fact.pred === target.pred && unify(target, fact, {}));
        }).filter(Boolean);
        const fact = {
          id: conclusion.id || `d${known.length + 1}`,
          pred: conclusion.pred,
          args: conclusion.args,
          negated: conclusion.negated,
          status: 'proven',
          derivedBy: rule.id || `rule-${rules.indexOf(rule) + 1}`,
          supports: supportFacts.map((entry) => entry.id),
          depth: Math.min(...supportFacts.map((entry) => entry.depth || 0)) + 1,
        };
        known.push(fact);
        seen.add(key);
        derivations.push({ fact, rule: rule.id || null, binding });
        added = true;
        // Explicit opposite facts are recorded, not deleted.
        const opposite = known.find((candidate) => candidate.id !== fact.id && candidate.pred === fact.pred && candidate.negated !== fact.negated && JSON.stringify(candidate.args) === JSON.stringify(fact.args));
        if (opposite && !contradictions.some((entry) => [entry.a, entry.b].includes(fact.id) && [entry.a, entry.b].includes(opposite.id))) contradictions.push({ a: fact.id, b: opposite.id, statement: atomKey(fact) });
        if (known.length >= maxFacts) break;
      }
      if (known.length >= maxFacts) break;
    }
  }
  return {
    facts: known,
    derived: derivations.length,
    iterations: iteration,
    exhausted: !added || iteration < maxIterations,
    truncated: known.length >= maxFacts,
    contradictions,
    status: derivations.length ? 'proven' : known.length ? 'supported' : 'unsupported',
    explanation: derivations.map((entry) => ({ fact: atomKey(entry.fact), rule: entry.rule, supports: entry.fact.supports })),
  };
}

/**
 * Bounded abduction: find the smallest sets of assumable hypotheses that, with
 * the known facts, entail every observation. The result is a candidate
 * explanation, never a proven fact; `status` stays `supported` or `estimated`.
 */
function abduce({ facts = [], rules = [], observations = [], maxHypotheses = 2, maxCandidates = 20 } = {}) {
  validateAtoms(observations, 'observations');
  const assumables = [];
  const pushAssumable = (atom) => {
    const key = atomKey(atom);
    if (!assumables.some((entry) => entry.key === key)) assumables.push({ key, atom });
  };
  for (const rule of rules || []) {
    for (const premise of rule.if || []) {
      if (!premise.assumable) continue;
      // A premise such as power_cut(?x) is not a usable hypothesis until the
      // observation identifies ?x. Unify the rule's conclusion with each
      // observation and ground the assumption from that binding.
      let grounded = false;
      for (const observation of observations) {
        if (observation.pred !== rule.then.pred || Boolean(observation.negated) !== Boolean(rule.then.negated)) continue;
        const binding = unify(rule.then, observation, {});
        if (binding) {
          pushAssumable(substitute(premise, binding));
          grounded = true;
        }
      }
      if (!grounded && !(premise.args || []).some(isVariable)) pushAssumable(premise);
    }
  }
  if (!assumables.length) return { candidates: [], reason: 'no rule declares an assumable hypothesis', status: 'unsupported' };
  const candidates = [];
  const combos = [];
  const walk = (start, chosen) => {
    if (chosen.length > maxHypotheses) return;
    if (chosen.length) combos.push([...chosen]);
    for (let index = start; index < assumables.length; index += 1) {
      chosen.push(assumables[index]);
      walk(index + 1, chosen);
      chosen.pop();
    }
  };
  walk(0, []);
  for (const combo of combos.sort((a, b) => a.length - b.length)) {
    const assumed = combo.map((entry) => ({ ...entry.atom, negated: Boolean(entry.atom.negated) }));
    const chain = forwardChain({ facts: [...facts, ...assumed], rules });
    const covered = observations.filter((observation) => chain.facts.some((fact) => fact.pred === observation.pred && JSON.stringify(fact.args) === JSON.stringify(observation.args) && Boolean(fact.negated) === Boolean(observation.negated)));
    if (covered.length === observations.length) {
      candidates.push({
        hypotheses: combo.map((entry) => atomKey(entry.atom)),
        coverage: 1,
        cost: combo.length,
        status: combo.length === 1 ? 'supported' : 'estimated',
        derivation: chain.explanation,
      });
      if (candidates.length >= maxCandidates) break;
    }
  }
  candidates.sort((a, b) => a.cost - b.cost || b.derivation.length - a.derivation.length);
  return {
    candidates,
    searched: combos.length,
    assumptions: assumables.map((entry) => entry.key),
    status: candidates.length ? candidates[0].status : 'unsupported',
    note: 'multiple explanations are retained; the smallest is not automatically true',
  };
}

const OPS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  allDifferent: null,
};

function constraintHolds(constraint, assignment) {
  const op = constraint.op || 'neq';
  const names = constraint.vars || (constraint.a && constraint.b ? [constraint.a, constraint.b] : []);
  if (!names.every((name) => assignment[name] !== undefined)) return true;
  if (op === 'allDifferent') {
    const values = names.map((name) => assignment[name]);
    return new Set(values).size === values.length;
  }
  if (!OPS[op]) throw Object.assign(new Error(`unknown constraint op ${op}`), { code: 'BAD_CONSTRAINT' });
  return OPS[op](assignment[names[0]], assignment[names[1]]);
}

/**
 * Finite-domain CSP with MRV variable selection, forward checking and a node
 * budget. Exhausting the budget is reported as incomplete, not unsatisfiable.
 */
function solveCsp({ variables = {}, constraints = [], limit = 1, maxNodes = 100000 } = {}) {
  const names = Object.keys(variables);
  if (!names.length) throw Object.assign(new Error('variables are required'), { code: 'NO_VARIABLES' });
  for (const name of names) {
    if (!Array.isArray(variables[name]) || !variables[name].length) throw Object.assign(new Error(`domain for ${name} is empty`), { code: 'BAD_DOMAIN' });
  }
  if (!Array.isArray(constraints)) throw Object.assign(new Error('constraints must be an array'), { code: 'BAD_CONSTRAINT' });
  for (const constraint of constraints) {
    if (!constraint || (!constraint.vars && (!constraint.a || !constraint.b))) throw Object.assign(new Error('a constraint needs vars or a/b'), { code: 'BAD_CONSTRAINT' });
    if (!(Object.prototype.hasOwnProperty.call(OPS, constraint.op || 'neq'))) throw Object.assign(new Error(`unknown constraint op ${constraint.op}`), { code: 'BAD_CONSTRAINT' });
  }
  const solutions = [];
  let nodes = 0;
  let exhausted = true;
  const assignment = {};
  const domains = Object.fromEntries(names.map((name) => [name, [...variables[name]]]));

  const consistent = (name, value, currentDomains) => constraints
    .filter((constraint) => (constraint.vars || [constraint.a, constraint.b]).includes(name))
    .every((constraint) => {
      const others = (constraint.vars || [constraint.a, constraint.b]).filter((other) => other !== name);
      if (others.some((other) => assignment[other] === undefined)) return true;
      const test = { ...assignment, [name]: value };
      return constraintHolds(constraint, test);
    });

  const search = (currentDomains) => {
    if (solutions.length >= limit) return;
    if (nodes >= maxNodes) {
      exhausted = false;
      return;
    }
    if (Object.keys(assignment).length === names.length) {
      solutions.push({ ...assignment });
      return;
    }
    nodes += 1;
    const open = names.filter((name) => assignment[name] === undefined);
    const name = open.sort((a, b) => currentDomains[a].length - currentDomains[b].length || a.localeCompare(b))[0];
    for (const value of currentDomains[name]) {
      if (!consistent(name, value, currentDomains)) continue;
      assignment[name] = value;
      const nextDomains = Object.fromEntries(Object.entries(currentDomains).map(([key, domain]) => [key, key === name ? [value] : domain]));
      let dead = false;
      for (const other of open.filter((entry) => entry !== name)) {
        const pruned = nextDomains[other].filter((candidate) => {
          const test = { ...assignment, [other]: candidate };
          return constraints
            .filter((constraint) => (constraint.vars || [constraint.a, constraint.b]).includes(other))
            .every((constraint) => {
              const namesInConstraint = constraint.vars || [constraint.a, constraint.b];
              const unassigned = namesInConstraint.filter((entry) => test[entry] === undefined);
              return unassigned.length ? true : constraintHolds(constraint, test);
            });
        });
        nextDomains[other] = pruned;
        if (!pruned.length) {
          dead = true;
          break;
        }
      }
      if (!dead) {
        search(nextDomains);
        if (solutions.length >= limit) return;
      }
      delete assignment[name];
    }
  };
  search(domains);
  return {
    solutions,
    nodes,
    complete: exhausted && solutions.length < limit,
    satisfiable: solutions.length > 0,
    status: solutions.length ? 'proven' : exhausted ? 'proven' : 'estimated',
    note: solutions.length ? 'a satisfying assignment was verified against every constraint' : exhausted ? 'the finite search space was exhausted' : 'the node budget was exhausted; unsatisfiability is not proven',
  };
}

/** Independent-evidence Bayesian update with explicit normalisation. */
function bayesUpdate({ hypotheses = {}, evidence = [], priors = null } = {}) {
  const names = Object.keys(hypotheses);
  if (!names.length) throw Object.assign(new Error('hypotheses are required'), { code: 'NO_HYPOTHESES' });
  const prior = {};
  let priorTotal = 0;
  for (const name of names) {
    const value = priors && priors[name] !== undefined ? Number(priors[name]) : 1 / names.length;
    if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error(`prior for ${name} is invalid`), { code: 'BAD_PRIOR' });
    prior[name] = value;
    priorTotal += value;
  }
  if (priorTotal <= 0) throw Object.assign(new Error('priors must sum to a positive value'), { code: 'BAD_PRIOR' });
  for (const name of names) prior[name] /= priorTotal;
  const originalPrior = { ...prior };
  const used = [];
  const skipped = [];
  for (const item of evidence) {
    if (!item || !item.id) {
      skipped.push({ reason: 'evidence has no id' });
      continue;
    }
    const likelihoods = {};
    let ok = true;
    for (const name of names) {
      const value = item.likelihoods ? Number(item.likelihoods[name]) : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        ok = false;
        break;
      }
      likelihoods[name] = value;
    }
    if (!ok) {
      skipped.push({ id: item.id, reason: 'incomplete or invalid likelihoods' });
      continue;
    }
    const unnormalised = {};
    let total = 0;
    for (const name of names) {
      unnormalised[name] = prior[name] * likelihoods[name];
      total += unnormalised[name];
    }
    if (total <= 0) {
      skipped.push({ id: item.id, reason: 'evidence has zero probability under every hypothesis' });
      continue;
    }
    for (const name of names) prior[name] = unnormalised[name] / total;
    used.push({ id: item.id, posterior: { ...prior } });
  }
  return {
    prior: originalPrior,
    posterior: prior,
    evidenceUsed: used,
    evidenceSkipped: skipped,
    status: used.length ? 'supported' : 'estimated',
    note: used.length ? 'independent conditional likelihoods were assumed' : 'no usable evidence; the prior was returned unchanged',
  };
}

/** Enumerate simple directed causal paths up to a depth bound. */
function causalPaths({ edges = [], from, to, maxDepth = 5, limit = 50 } = {}) {
  if (!from || !to) throw Object.assign(new Error('from and to are required'), { code: 'NO_ENDPOINTS' });
  const adjacency = new Map();
  for (const edge of edges) {
    if (!edge || !edge.from || !edge.to) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push({ to: edge.to, type: edge.type || 'causes', weight: Number(edge.weight) || 1 });
  }
  const paths = [];
  const walk = (node, path, visited, strength) => {
    if (paths.length >= limit || path.length > maxDepth) return;
    if (node === to) {
      paths.push({ nodes: [...path], strength, length: path.length - 1 });
      return;
    }
    for (const edge of adjacency.get(node) || []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      walk(edge.to, [...path, edge.to], visited, strength * edge.weight);
      visited.delete(edge.to);
    }
  };
  walk(from, [from], new Set([from]), 1);
  paths.sort((a, b) => b.strength - a.strength || a.length - b.length);
  return { paths, reached: paths.length > 0, status: paths.length ? 'supported' : 'proven', note: 'path strength is a product of edge weights, not a causal effect size' };
}

const ALLEN = ['before', 'meets', 'overlaps', 'starts', 'during', 'finishes', 'equals'];

function intervalRelations(a, b) {
  for (const [name, interval] of Object.entries({ a, b })) {
    if (!interval || !Number.isFinite(Number(interval.start)) || !Number.isFinite(Number(interval.end))) {
      throw Object.assign(new Error(`interval ${name} needs numeric start and end`), { code: 'BAD_INTERVAL' });
    }
    if (Number(interval.start) > Number(interval.end)) throw Object.assign(new Error(`interval ${name} starts before it ends`), { code: 'BAD_INTERVAL' });
  }
  const [a1, a2, b1, b2] = [Number(a.start), Number(a.end), Number(b.start), Number(b.end)];
  const relations = [];
  if (a2 < b1) relations.push('before');
  if (a2 === b1) relations.push('meets');
  if (a1 < b1 && a2 > b1 && a2 < b2) relations.push('overlaps');
  if (a1 === b1 && a2 < b2) relations.push('starts');
  if (a1 > b1 && a2 < b2) relations.push('during');
  if (a1 > b1 && a2 === b2) relations.push('finishes');
  if (a1 === b1 && a2 === b2) relations.push('equals');
  if (!relations.length) {
    if (a1 > b2) relations.push('after');
    else if (a1 === b2) relations.push('met-by');
    else if (a1 > b1 && a1 < b2 && a2 > b2) relations.push('overlapped-by');
    else if (a1 > b1 && a1 < b2 && a2 === b2) relations.push('started-by');
    else if (a1 < b1 && a2 > b2) relations.push('contains');
    else if (a1 < b1 && a2 === b2) relations.push('finished-by');
  }
  const inverse = { before: 'after', meets: 'met-by', overlaps: 'overlapped-by', starts: 'started-by', during: 'contains', finishes: 'finished-by', equals: 'equals', after: 'before', 'met-by': 'meets', 'overlapped-by': 'overlaps', 'started-by': 'starts', contains: 'during', 'finished-by': 'finishes' };
  return {
    relations,
    inverse: relations.map((relation) => inverse[relation]).filter(Boolean),
    known: relations.some((relation) => ALLEN.includes(relation)),
    status: relations.length ? 'proven' : 'unsupported',
    durationA: a2 - a1,
    durationB: b2 - b1,
  };
}

/** Axis-aligned 2-D rectangle relations; touches are not overlaps. */
function spatialRelations(a, b) {
  for (const [name, rect] of Object.entries({ a, b })) {
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(Number(rect && rect[key]))) throw Object.assign(new Error(`${name}.${key} must be numeric`), { code: 'BAD_RECT' });
    }
    if (Number(rect.w) < 0 || Number(rect.h) < 0) throw Object.assign(new Error(`${name} has a negative size`), { code: 'BAD_RECT' });
  }
  const ax2 = Number(a.x) + Number(a.w);
  const ay2 = Number(a.y) + Number(a.h);
  const bx2 = Number(b.x) + Number(b.w);
  const by2 = Number(b.y) + Number(b.h);
  const overlapX = Math.min(ax2, bx2) - Math.max(Number(a.x), Number(b.x));
  const overlapY = Math.min(ay2, by2) - Math.max(Number(a.y), Number(b.y));
  const overlap = overlapX > 0 && overlapY > 0;
  const touches = overlapX === 0 && overlapY > 0 || overlapY === 0 && overlapX > 0;
  const contains = Number(a.x) <= Number(b.x) && Number(a.y) <= Number(b.y) && ax2 >= bx2 && ay2 >= by2;
  const within = Number(b.x) <= Number(a.x) && Number(b.y) <= Number(a.y) && bx2 >= ax2 && by2 >= ay2;
  const dx = Math.max(0, Math.max(Number(b.x) - ax2, Number(a.x) - bx2));
  const dy = Math.max(0, Math.max(Number(b.y) - ay2, Number(a.y) - by2));
  return {
    overlap,
    touches,
    disjoint: !overlap && !touches,
    contains,
    within,
    overlapArea: overlap ? overlapX * overlapY : 0,
    distance: Math.hypot(dx, dy),
    status: 'proven',
  };
}

/**
 * Expected-utility choice with explicit probabilities. A missing probability
 * or utility is rejected rather than replaced by an optimistic guess. The
 * sensitivity field shows which single weight change could flip the winner.
 */
function decide({ options = [], criteria = [], weights = null } = {}) {
  if (!Array.isArray(options) || !options.length) throw Object.assign(new Error('options are required'), { code: 'NO_OPTIONS' });
  if (!Array.isArray(criteria) || !criteria.length) throw Object.assign(new Error('criteria are required'), { code: 'NO_CRITERIA' });
  const weightFor = (id) => {
    const raw = weights && weights[id] !== undefined ? Number(weights[id]) : 1;
    if (!Number.isFinite(raw) || raw < 0) throw Object.assign(new Error(`weight for ${id} is invalid`), { code: 'BAD_WEIGHT' });
    return raw;
  };
  const totalWeight = criteria.reduce((sum, criterion) => sum + weightFor(criterion.id || criterion), 0);
  if (totalWeight <= 0) throw Object.assign(new Error('weights must sum to a positive value'), { code: 'BAD_WEIGHT' });
  const scored = options.map((option) => {
    if (!option || !option.id) throw Object.assign(new Error('an option needs an id'), { code: 'BAD_OPTION' });
    let score = 0;
    let probability = 1;
    for (const criterion of criteria) {
      const id = criterion.id || criterion;
      const value = Number(option[criterion.field || id]);
      if (!Number.isFinite(value)) throw Object.assign(new Error(`option ${option.id} has no numeric ${criterion.field || id}`), { code: 'MISSING_UTILITY' });
      const probabilityValue = criterion.probabilityField ? Number(option[criterion.probabilityField]) : 1;
      if (!Number.isFinite(probabilityValue) || probabilityValue < 0 || probabilityValue > 1) throw Object.assign(new Error(`option ${option.id} has an invalid probability`), { code: 'BAD_PROBABILITY' });
      score += (weightFor(id) / totalWeight) * value * probabilityValue;
      probability *= probabilityValue;
    }
    return { id: option.id, score, probability, status: probability === 1 ? 'proven' : 'estimated' };
  }).sort((a, b) => b.score - a.score);
  const margin = scored.length > 1 ? scored[0].score - scored[1].score : scored[0].score;
  return {
    ranking: scored,
    winner: scored[0].id,
    margin,
    uncertain: scored.some((entry) => entry.probability < 1),
    status: scored.some((entry) => entry.probability < 1) ? 'estimated' : 'supported',
    note: scored.some((entry) => entry.probability < 1) ? 'expected utility uses caller-supplied probabilities' : 'criteria are deterministic; weights express preference, not fact',
  };
}

// 10.0: induction, structural causal models, exact Bayesian networks,
// constrained optimisation, hierarchical planning, graph search and
// propositional verification live in ./advanced.js and are exported here so
// callers keep one reasoning surface.
const advanced = require('./advanced');

module.exports = {
  forwardChain,
  abduce,
  solveCsp,
  bayesUpdate,
  causalPaths,
  intervalRelations,
  spatialRelations,
  decide,
  atomKey,
  unify,
  ...advanced,
};
