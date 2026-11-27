'use strict';

/**
 * Advanced deterministic reasoning.
 *
 * These solvers extend the engines in ./engines.js with the pieces that were
 * missing in 9.0: rule induction, structural causal models with interventions,
 * exact discrete Bayesian networks, finite-domain constrained optimisation,
 * hierarchical task planning, bounded graph search and propositional proof by
 * truth table.
 *
 * Every result says how strong its claim is:
 *
 *   proven     — exhaustive construction (truth table, finite search, exact
 *                enumeration under the supplied model) or a deterministically
 *                simulated plan whose goal is checked.
 *   estimated  — statistical induction or a model-implied causal effect.
 *
 * A structural causal model is a *model*. Its output is not evidence that a
 * cause was demonstrated in the world, and the result carries that limitation
 * explicitly.
 */

const MAX_ENUM_ASSIGNMENTS = 200000;

function bad(code, message) {
  return Object.assign(new Error(message), { code });
}

function numeric(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw bad('BAD_NUMBER', `${label} must be a finite number`);
  return number;
}

function sameValue(a, b) {
  return String(a) === String(b);
}

/* ── rule induction ─────────────────────────────────────────────────────── */

/**
 * Learn at most two-condition classification rules from labelled examples.
 *
 * This is a deterministic separate-and-conquer learner, not a statistical
 * model. Support and confidence are reported so a caller can reject fragile
 * rules, and the result is always `estimated`: induction generalises beyond
 * the rows it saw.
 */
function induce({ examples = [], target = 'class', attributes = null, minSupport = 2, minConfidence = 0.6, maxRules = 20 } = {}) {
  if (!Array.isArray(examples) || examples.length < 2) throw bad('NO_EXAMPLES', 'at least two labelled examples are required');
  if (typeof target !== 'string' || !target.trim()) throw bad('BAD_TARGET', 'target must name the label field');
  if (!Number.isFinite(minSupport) || minSupport < 1) throw bad('BAD_SUPPORT', 'minSupport must be at least 1');
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw bad('BAD_CONFIDENCE', 'minConfidence must be within 0..1');
  const rows = examples.map((example, index) => {
    if (!example || typeof example !== 'object' || Array.isArray(example)) throw bad('BAD_EXAMPLE', `example ${index} must be an object`);
    if (example[target] === undefined || example[target] === null) throw bad('BAD_EXAMPLE', `example ${index} has no ${target}`);
    return { ...example };
  });
  const names = Array.isArray(attributes) && attributes.length
    ? attributes.map(String)
    : Object.keys(rows[0]).filter((name) => name !== target).sort();
  if (!names.length) throw bad('NO_ATTRIBUTES', 'there are no attribute fields to learn from');
  for (const row of rows) {
    for (const name of names) {
      if (row[name] === undefined || row[name] === null) throw bad('BAD_EXAMPLE', `an example is missing ${name}`);
    }
  }
  const valuesFor = (name) => [...new Set(rows.map((row) => String(row[name])))];
  const candidates = [];
  const conditions = names.flatMap((name) => valuesFor(name).map((value) => ({ field: name, value })));
  if (conditions.length > 200) throw bad('TOO_MANY_CANDIDATES', 'the attribute-value space is too large for deterministic induction');
  for (let i = 0; i < conditions.length; i += 1) {
    candidates.push([conditions[i]]);
    for (let j = i + 1; j < conditions.length; j += 1) {
      if (conditions[i].field === conditions[j].field) continue;
      candidates.push([conditions[i], conditions[j]]);
    }
  }
  const matches = (row, set) => set.every((condition) => sameValue(row[condition.field], condition.value));
  const classes = [...new Set(rows.map((row) => String(row[target])))].sort();
  const rules = [];
  const uncovered = {};
  for (const label of classes) {
    const positives = rows.filter((row) => sameValue(row[target], label));
    const covered = new Set();
    const scored = candidates.map((set) => {
      const hits = rows.filter((row) => matches(row, set));
      const correct = hits.filter((row) => sameValue(row[target], label)).length;
      return {
        conditions: set,
        support: hits.length,
        correct,
        confidence: hits.length ? correct / hits.length : 0,
        positiveCoverage: positives.length ? correct / positives.length : 0,
      };
    }).filter((candidate) => candidate.support >= minSupport && candidate.confidence >= minConfidence)
      // Specific rules first when confidence ties; deterministic ordering last.
      .sort((a, b) => b.confidence - a.confidence
        || b.positiveCoverage - a.positiveCoverage
        || b.conditions.length - a.conditions.length
        || JSON.stringify(a.conditions).localeCompare(JSON.stringify(b.conditions)));

    for (const candidate of scored) {
      if (rules.length >= maxRules) break;
      const newlyCovered = rows.filter((row) => matches(row, candidate.conditions)
        && sameValue(row[target], label)
        && !covered.has(row)).length;
      if (!newlyCovered) continue;
      for (const row of rows) if (matches(row, candidate.conditions) && sameValue(row[target], label)) covered.add(row);
      rules.push({
        condition: candidate.conditions.map((entry) => `${entry.field}=${entry.value}`).join(' AND '),
        conditions: candidate.conditions,
        conclusion: `${target}=${label}`,
        label,
        support: candidate.support,
        correct: candidate.correct,
        confidence: Number(candidate.confidence.toFixed(6)),
        positiveCoverage: Number(candidate.positiveCoverage.toFixed(6)),
      });
    }
    uncovered[label] = positives.filter((row) => !covered.has(row)).length;
  }
  return {
    rules,
    classes,
    attributes: names,
    uncovered,
    examples: rows.length,
    status: 'estimated',
    note: 'rules are induced from the supplied rows; support and confidence do not establish causation or guarantee performance on unseen data',
  };
}

/* ── structural causal models ───────────────────────────────────────────── */

function validateScm(variables, observed, interventions) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw bad('NO_MODEL', 'variables must be an object');
  const names = Object.keys(variables);
  if (!names.length) throw bad('NO_MODEL', 'the model has no variables');
  for (const name of names) {
    const node = variables[name];
    if (!node || typeof node !== 'object') throw bad('BAD_MODEL', `${name} is not a variable definition`);
    const parents = node.parents === undefined ? [] : node.parents;
    if (!Array.isArray(parents)) throw bad('BAD_MODEL', `${name}.parents must be an array`);
    for (const parent of parents) {
      if (!Object.prototype.hasOwnProperty.call(variables, parent)) throw bad('BAD_MODEL', `${name} depends on unknown ${parent}`);
    }
    const weights = node.weights === undefined ? {} : node.weights;
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw bad('BAD_MODEL', `${name}.weights must be an object`);
    for (const parent of Object.keys(weights)) {
      if (!parents.includes(parent)) throw bad('BAD_MODEL', `${name} has a weight for ${parent} but does not list it as a parent`);
      numeric(weights[parent], `${name}.weights.${parent}`);
    }
    if (node.bias !== undefined) numeric(node.bias, `${name}.bias`);
    if (node.noise !== undefined) numeric(node.noise, `${name}.noise`);
  }
  for (const [label, values] of [['observed', observed], ['interventions', interventions]]) {
    if (values === undefined || values === null) continue;
    if (typeof values !== 'object' || Array.isArray(values)) throw bad('BAD_MODEL', `${label} must be an object`);
    for (const [name, value] of Object.entries(values)) {
      if (!Object.prototype.hasOwnProperty.call(variables, name)) throw bad('BAD_MODEL', `${label} names unknown variable ${name}`);
      numeric(value, `${label}.${name}`);
    }
  }
}

function evaluateScm(variables, { observed = {}, interventions = {} } = {}) {
  const resolved = {};
  const visiting = new Set();
  const resolve = (name) => {
    if (Object.prototype.hasOwnProperty.call(resolved, name)) return resolved[name];
    if (visiting.has(name)) throw bad('CYCLIC_MODEL', `the structural model contains a cycle through ${name}`);
    visiting.add(name);
    let value;
    if (Object.prototype.hasOwnProperty.call(interventions, name)) {
      value = numeric(interventions[name], `intervention ${name}`);
    } else if (Object.prototype.hasOwnProperty.call(observed, name)) {
      value = numeric(observed[name], `observed ${name}`);
    } else {
      const node = variables[name];
      value = node.bias === undefined ? 0 : Number(node.bias);
      for (const parent of node.parents || []) {
        const weight = node.weights && node.weights[parent] !== undefined ? Number(node.weights[parent]) : 0;
        value += weight * resolve(parent);
      }
      if (node.noise !== undefined) value += Number(node.noise);
    }
    visiting.delete(name);
    resolved[name] = value;
    return value;
  };
  for (const name of Object.keys(variables)) resolve(name);
  return resolved;
}

/**
 * Compare the model's factual prediction with a counterfactual under do().
 * Only the linear structural form is supported; the assumption is returned
 * rather than hidden. Unobserved confounding is not modelled, so the result
 * cannot establish that a cause was demonstrated in reality.
 */
function counterfactual({ variables = {}, observed = {}, interventions = {}, outcome = null, treatment = null } = {}) {
  validateScm(variables, observed, interventions);
  const names = Object.keys(variables);
  const resultName = outcome || names[names.length - 1];
  if (!Object.prototype.hasOwnProperty.call(variables, resultName)) throw bad('BAD_OUTCOME', `unknown outcome ${resultName}`);
  if (!Object.keys(interventions).length) throw bad('NO_INTERVENTION', 'at least one intervention is required');
  if (treatment && !Object.prototype.hasOwnProperty.call(interventions, treatment)) throw bad('BAD_TREATMENT', `the treatment ${treatment} is not intervened`);
  const factual = evaluateScm(variables, { observed, interventions: {} });
  const counterfactualValues = evaluateScm(variables, { observed, interventions });
  const delta = counterfactualValues[resultName] - factual[resultName];
  const node = variables[resultName];
  const decomposition = (node.parents || []).map((parent) => {
    const weight = node.weights && node.weights[parent] !== undefined ? Number(node.weights[parent]) : 0;
    const parentDelta = counterfactualValues[parent] - factual[parent];
    return { variable: parent, weight, delta: parentDelta, contribution: weight * parentDelta };
  }).filter((entry) => entry.contribution !== 0 || entry.delta !== 0);
  return {
    outcome: resultName,
    treatment: treatment || Object.keys(interventions)[0],
    interventions: { ...interventions },
    factual,
    counterfactual: counterfactualValues,
    factualOutcome: factual[resultName],
    counterfactualOutcome: counterfactualValues[resultName],
    delta,
    decomposition,
    assumptions: [
      'linear structural equations with additive noise',
      'the supplied graph is acyclic',
      'no unobserved confounding; interventions cut incoming edges',
      observed && Object.keys(observed).length ? 'observed values are treated as clamped variables' : 'unclamped root variables use their structural value (bias + noise)',
    ],
    identification: 'model-implied',
    status: 'estimated',
    note: 'this is the effect implied by the supplied causal model, not an effect demonstrated by observed data',
  };
}

/* ── discrete Bayesian networks ─────────────────────────────────────────── */

function topoOrder(nodes) {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const order = [];
  const state = new Map();
  const visit = (name) => {
    const mark = state.get(name);
    if (mark === 'done') return;
    if (mark === 'visiting') throw bad('CYCLIC_NETWORK', `the Bayesian network contains a cycle through ${name}`);
    state.set(name, 'visiting');
    const node = byName.get(name);
    for (const parent of node.parents || []) visit(parent);
    state.set(name, 'done');
    order.push(name);
  };
  for (const node of nodes) visit(node.name);
  return order;
}

function parentKey(parents, assignment) {
  return parents.map((parent) => `${parent}=${String(assignment[parent])}`).join('|');
}

/**
 * Exact inference by enumeration for a finite discrete Bayesian network.
 * Inference is proven *relative to the supplied CPTs*: if the model is wrong,
 * the posterior is wrong, and the result says so.
 */
function bayesNetwork({ nodes = [], query = [], evidence = {}, maxAssignments = MAX_ENUM_ASSIGNMENTS } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw bad('NO_NODES', 'at least one network node is required');
  if (!Number.isFinite(maxAssignments) || maxAssignments < 1) throw bad('BAD_LIMIT', 'maxAssignments must be positive');
  const byName = new Map();
  for (const node of nodes) {
    if (!node || typeof node.name !== 'string' || !node.name.trim()) throw bad('BAD_NODE', 'every node needs a name');
    if (byName.has(node.name)) throw bad('DUPLICATE_NODE', `duplicate node ${node.name}`);
    if (!Array.isArray(node.values) || !node.values.length) throw bad('BAD_NODE', `${node.name} needs a non-empty values array`);
    if (!node.cpt || typeof node.cpt !== 'object') throw bad('BAD_NODE', `${node.name} needs a cpt object`);
    if (node.parents !== undefined && !Array.isArray(node.parents)) throw bad('BAD_NODE', `${node.name}.parents must be an array`);
    byName.set(node.name, { ...node, parents: node.parents || [] });
  }
  const order = topoOrder([...byName.values()]);
  for (const name of order) {
    const node = byName.get(name);
    for (const parent of node.parents) {
      if (!byName.has(parent)) throw bad('BAD_NODE', `${name} depends on unknown ${parent}`);
      if (parent === name) throw bad('CYCLIC_NETWORK', `${name} depends on itself`);
    }
    const combinations = node.parents.length
      ? node.parents.reduce((rows, parent) => rows.flatMap((row) => byName.get(parent).values.map((value) => [...row, value])), [[]])
      : [[]];
    for (const combination of combinations) {
      const assignment = Object.fromEntries(node.parents.map((parent, index) => [parent, combination[index]]));
      const key = parentKey(node.parents, assignment);
      const row = node.cpt[key];
      if (!row) throw bad('MISSING_CPT', `${name} has no CPT row for ${key || '(root)'}`);
      let sum = 0;
      for (const value of node.values) {
        if (row[value] === undefined) throw bad('MISSING_CPT', `${name}(${key || 'root'}) has no probability for ${value}`);
        const probability = numeric(row[value], `${name}(${key || 'root'}).${value}`);
        if (probability < 0 || probability > 1) throw bad('BAD_PROBABILITY', `${name}(${key || 'root'}).${value} is outside 0..1`);
        sum += probability;
      }
      if (Math.abs(sum - 1) > 1e-9) throw bad('BAD_PROBABILITY', `${name}(${key || 'root'}) probabilities sum to ${sum}, not 1`);
    }
  }
  const names = order;
  const queryNames = (Array.isArray(query) ? query : [query]).filter(Boolean).map(String);
  if (!queryNames.length) throw bad('NO_QUERY', 'at least one query variable is required');
  for (const name of queryNames) if (!byName.has(name)) throw bad('BAD_QUERY', `unknown query variable ${name}`);
  for (const [name, value] of Object.entries(evidence || {})) {
    if (!byName.has(name)) throw bad('BAD_EVIDENCE', `unknown evidence variable ${name}`);
    if (!byName.get(name).values.some((candidate) => sameValue(candidate, value))) throw bad('BAD_EVIDENCE', `${value} is not a value of ${name}`);
  }
  const totals = new Map();
  let assignments = 0;
  let matching = 0;
  const walk = (index, assignment, probability) => {
    if (index === names.length) {
      assignments += 1;
      if (assignments > maxAssignments) throw bad('TOO_MANY_ASSIGNMENTS', `enumeration exceeded ${maxAssignments} complete assignments`);
      for (const [name, value] of Object.entries(evidence || {})) if (!sameValue(assignment[name], value)) return;
      matching += 1;
      const key = queryNames.map((name) => String(assignment[name])).join('|');
      totals.set(key, (totals.get(key) || 0) + probability);
      return;
    }
    const name = names[index];
    const node = byName.get(name);
    const key = parentKey(node.parents, assignment);
    const row = node.cpt[key];
    for (const value of node.values) {
      assignment[name] = value;
      walk(index + 1, assignment, probability * Number(row[value]));
    }
    delete assignment[name];
  };
  walk(0, {}, 1);
  if (!matching) throw bad('IMPOSSIBLE_EVIDENCE', 'the supplied evidence has zero probability under this network');
  const mass = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (!(mass > 0)) throw bad('IMPOSSIBLE_EVIDENCE', 'the supplied evidence has zero probability mass under this network');
  const distribution = [...totals.entries()].map(([key, probability]) => ({
    assignment: Object.fromEntries(queryNames.map((name, index) => [name, key.split('|')[index]])),
    probability: probability / mass,
  })).sort((a, b) => b.probability - a.probability);
  const marginals = {};
  for (const name of queryNames) {
    const values = byName.get(name).values;
    marginals[name] = values.map((value) => ({
      value,
      probability: distribution.filter((entry) => sameValue(entry.assignment[name], value)).reduce((sum, entry) => sum + entry.probability, 0),
    }));
  }
  return {
    distribution,
    marginals,
    mostLikely: distribution[0].assignment,
    probability: distribution[0].probability,
    assignments,
    matching,
    query: queryNames,
    evidence: { ...(evidence || {}) },
    status: 'proven',
    note: 'exact enumeration; the result is only as valid as the supplied graph and conditional probability tables',
  };
}

/* ── constrained optimisation ───────────────────────────────────────────── */

const OPS = {
  eq: (a, b) => sameValue(a, b) || Number(a) === Number(b),
  neq: (a, b) => !(sameValue(a, b) || Number(a) === Number(b)),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  allDifferent: (...values) => new Set(values.map(String)).size === values.length,
};

function constraintVars(constraint) {
  return constraint.vars || (constraint.a && constraint.b ? [constraint.a, constraint.b] : []);
}

function holds(constraint, assignment) {
  const names = constraintVars(constraint);
  if (!names.every((name) => assignment[name] !== undefined)) return true;
  const op = constraint.op || 'neq';
  if (!OPS[op]) throw bad('BAD_CONSTRAINT', `unknown constraint op ${op}`);
  return OPS[op](...names.map((name) => assignment[name]));
}

/**
 * Maximise a linear objective over a finite-domain CSP. The search is complete
 * unless the node budget is exhausted; only a complete search may call the
 * solution optimal.
 */
function optimizeCsp({ variables = {}, constraints = [], objective = {}, maxNodes = 200000 } = {}) {
  const names = Object.keys(variables);
  if (!names.length) throw bad('NO_VARIABLES', 'variables are required');
  for (const name of names) {
    if (!Array.isArray(variables[name]) || !variables[name].length) throw bad('BAD_DOMAIN', `domain for ${name} is empty`);
  }
  if (!Array.isArray(constraints)) throw bad('BAD_CONSTRAINT', 'constraints must be an array');
  for (const constraint of constraints) {
    if (!constraint || !constraintVars(constraint).length) throw bad('BAD_CONSTRAINT', 'a constraint needs vars or a/b');
    if (!OPS[constraint.op || 'neq']) throw bad('BAD_CONSTRAINT', `unknown constraint op ${constraint.op}`);
  }
  const weights = objective.weights || objective;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw bad('BAD_OBJECTIVE', 'objective.weights must be an object');
  for (const name of Object.keys(weights)) {
    if (!names.includes(name)) throw bad('BAD_OBJECTIVE', `objective names unknown variable ${name}`);
    numeric(weights[name], `weight.${name}`);
  }
  const weightOf = (name) => (weights[name] === undefined ? 0 : Number(weights[name]));
  const bias = objective.bias === undefined ? 0 : numeric(objective.bias, 'objective.bias');
  const assignment = {};
  let best = null;
  let bestScore = -Infinity;
  let nodes = 0;
  let exhausted = true;
  const upperBound = () => {
    let bound = bias;
    for (const name of names) {
      if (assignment[name] !== undefined) {
        bound += weightOf(name) * Number(assignment[name]);
      } else {
        const scores = variables[name].map((value) => weightOf(name) * numeric(value, `domain value ${name}`));
        bound += Math.max(...scores);
      }
    }
    return bound;
  };
  const consistent = (name, value) => constraints
    .filter((constraint) => constraintVars(constraint).includes(name))
    .every((constraint) => holds(constraint, { ...assignment, [name]: value }));
  const search = () => {
    if (nodes >= maxNodes) {
      exhausted = false;
      return;
    }
    nodes += 1;
    if (Object.keys(assignment).length === names.length) {
      const score = names.reduce((sum, name) => sum + weightOf(name) * Number(assignment[name]), bias);
      if (score > bestScore) {
        bestScore = score;
        best = { ...assignment };
      }
      return;
    }
    if (upperBound() <= bestScore) return;
    // Assign the variable with the fewest remaining consistent values.
    const open = names.filter((name) => assignment[name] === undefined);
    const options = open.map((name) => ({
      name,
      values: variables[name].filter((value) => consistent(name, value)),
    })).sort((a, b) => a.values.length - b.values.length || a.name.localeCompare(b.name));
    const chosen = options[0];
    for (const value of chosen.values) {
      assignment[chosen.name] = value;
      search();
      delete assignment[chosen.name];
      if (!exhausted) return;
    }
  };
  search();
  if (!best) {
    return { solution: null, score: null, nodes, complete: exhausted, satisfiable: false, status: exhausted ? 'proven' : 'estimated', note: exhausted ? 'no assignment satisfies every constraint' : 'the node budget was exhausted before a solution was found' };
  }
  return {
    solution: best,
    score: bestScore,
    nodes,
    complete: exhausted,
    satisfiable: true,
    optimal: exhausted,
    status: exhausted ? 'proven' : 'estimated',
    note: exhausted ? 'the search space was exhausted; this is the optimal assignment under the supplied objective' : 'the node budget was exhausted; a better assignment may exist',
  };
}

/* ── hierarchical planning ──────────────────────────────────────────────── */

function requiresMet(state, requires = []) {
  return (requires || []).every((condition) => sameValue(state[condition.var], condition.equals));
}

function applyEffects(next, effects = {}) {
  for (const [key, value] of Object.entries(effects)) next[key] = value;
}

function goalMet(state, goal = {}) {
  return Object.entries(goal).every(([key, value]) => sameValue(state[key], value));
}

/**
 * Bounded hierarchical task-network planning.
 *
 * Tasks are decomposed by named methods into actions. Actions have
 * preconditions and effects. The returned plan is deterministic under the
 * supplied model and its goal is checked by simulation, so finding one is
 * `proven`; failure is only proof when the search space was exhausted.
 */
function hierarchicalPlan({ tasks = [], methods = [], actions = {}, state = {}, goal = {}, maxNodes = 5000, maxDepth = 32, maxQueue = 64 } = {}) {
  if (!Array.isArray(tasks) || !tasks.length) throw bad('NO_TASKS', 'at least one root task is required');
  if (!Number.isFinite(maxNodes) || maxNodes < 1) throw bad('BAD_LIMIT', 'maxNodes must be positive');
  if (!goal || typeof goal !== 'object' || Array.isArray(goal) || !Object.keys(goal).length) throw bad('NO_GOAL', 'a non-empty goal object is required');
  const methodList = Array.isArray(methods) ? methods : [];
  for (const method of methodList) {
    if (!method || !method.task || !method.name || !Array.isArray(method.subtasks) || !method.subtasks.length) throw bad('BAD_METHOD', 'a method needs task, name and non-empty subtasks');
  }
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) throw bad('BAD_ACTIONS', 'actions must be an object');
  const byTask = new Map();
  for (const method of methodList) {
    if (!byTask.has(method.task)) byTask.set(method.task, []);
    byTask.get(method.task).push(method);
  }
  for (const [name, action] of Object.entries(actions)) {
    if (!action || typeof action !== 'object') throw bad('BAD_ACTION', `action ${name} must be an object`);
    if (action.requires !== undefined && !Array.isArray(action.requires)) throw bad('BAD_ACTION', `${name}.requires must be an array`);
  }
  let nodes = 0;
  let exhausted = false;
  let deepest = 0;
  const trace = [];
  const seen = new Set();
  const search = (queue, currentState, depth, plan) => {
    nodes += 1;
    deepest = Math.max(deepest, depth);
    if (nodes > maxNodes) {
      exhausted = true;
      return null;
    }
    if (depth > maxDepth) return null;
    if (!queue.length) return goalMet(currentState, goal) ? { plan, state: currentState } : null;
    if (queue.length > maxQueue) return null;
    const key = `${queue.join('>')}|${JSON.stringify(currentState)}|${depth}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const [task, ...rest] = queue;
    const action = actions[task];
    if (action) {
      if (requiresMet(currentState, action.requires || [])) {
        const next = { ...currentState };
        applyEffects(next, action.effects || {});
        trace.push({ depth, kind: 'action', task });
        const found = search(rest, next, depth + 1, [...plan, { kind: 'action', task }]);
        if (found) return found;
      } else {
        trace.push({ depth, kind: 'blocked', task, reason: 'precondition not met' });
      }
    }
    for (const method of byTask.get(task) || []) {
      trace.push({ depth, kind: 'method', task, method: method.name });
      const found = search([...method.subtasks, ...rest], currentState, depth + 1, [...plan, { kind: 'method', task, method: method.name }]);
      if (found) return found;
    }
    return null;
  };
  const found = search([...tasks], { ...state }, 0, []);
  if (found) {
    return {
      plan: found.plan,
      actions: found.plan.filter((step) => step.kind === 'action').map((step) => step.task),
      finalState: found.state,
      achieved: true,
      nodes,
      depth: deepest,
      complete: true,
      status: 'proven',
      note: 'the plan was simulated under the supplied deterministic action model and its goal holds',
    };
  }
  return {
    plan: null,
    actions: [],
    finalState: null,
    achieved: false,
    nodes,
    depth: deepest,
    complete: !exhausted,
    status: exhausted ? 'estimated' : 'proven',
    trace: trace.slice(0, 80),
    note: exhausted ? 'the search budget was exhausted; no plan was found but none was disproven' : 'every reachable decomposition and action ordering was explored without reaching the goal',
  };
}

/* ── bounded graph search ───────────────────────────────────────────────── */

function normaliseEdges(edges) {
  if (!Array.isArray(edges)) throw bad('BAD_EDGES', 'edges must be an array');
  return edges.map((edge, index) => {
    const row = Array.isArray(edge)
      ? { from: edge[0], to: edge[1], cost: edge[2] === undefined ? 1 : edge[2] }
      : edge;
    if (!row || row.from === undefined || row.to === undefined) throw bad('BAD_EDGE', `edge ${index} needs from and to`);
    const cost = row.cost === undefined ? 1 : numeric(row.cost, `edge ${index} cost`);
    if (cost < 0) throw bad('BAD_EDGE', `edge ${index} has a negative cost`);
    return { from: String(row.from), to: String(row.to), cost };
  });
}

/**
 * Shortest path by breadth-first search, Dijkstra or A*. The heuristic is
 * caller-supplied; with a non-zero heuristic the optimality claim is softened
 * because admissibility cannot be checked from numbers alone.
 */
function graphSearch({ edges = [], start, goal, strategy = 'dijkstra', heuristic = {}, maxExpansions = 50000 } = {}) {
  if (start === undefined || start === null || goal === undefined || goal === null) throw bad('NO_ENDPOINTS', 'start and goal are required');
  if (!['bfs', 'dijkstra', 'astar'].includes(strategy)) throw bad('BAD_STRATEGY', `unknown strategy ${strategy}`);
  if (!Number.isFinite(maxExpansions) || maxExpansions < 1) throw bad('BAD_LIMIT', 'maxExpansions must be positive');
  const graph = normaliseEdges(edges);
  const source = String(start);
  const target = String(goal);
  const adjacency = new Map();
  for (const edge of graph) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
  }
  const h = (name) => {
    const value = heuristic && heuristic[name] !== undefined ? Number(heuristic[name]) : 0;
    if (!Number.isFinite(value) || value < 0) throw bad('BAD_HEURISTIC', `heuristic for ${name} must be a non-negative number`);
    return value;
  };
  const best = new Map([[source, 0]]);
  const previous = new Map();
  const visited = new Set();
  let frontier = [{ node: source, cost: 0, priority: 0 }];
  let expansions = 0;
  let exhausted = false;
  while (frontier.length) {
    frontier.sort((a, b) => a.priority - b.priority || a.cost - b.cost || a.node.localeCompare(b.node));
    const current = frontier.shift();
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    expansions += 1;
    if (expansions > maxExpansions) {
      exhausted = true;
      break;
    }
    if (current.node === target) break;
    for (const edge of adjacency.get(current.node) || []) {
      if (visited.has(edge.to)) continue;
      const nextCost = current.cost + (strategy === 'bfs' ? 1 : edge.cost);
      if (nextCost < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, nextCost);
        previous.set(edge.to, current.node);
        frontier.push({ node: edge.to, cost: nextCost, priority: nextCost + (strategy === 'astar' ? h(edge.to) : 0) });
      }
    }
  }
  const path = [];
  if (best.has(target)) {
    let node = target;
    while (node !== undefined && node !== null) {
      path.unshift(node);
      if (node === source) break;
      node = previous.get(node);
    }
  }
  const found = path.length > 0 && path[0] === source;
  const zeroHeuristic = Object.values(heuristic || {}).every((value) => Number(value) === 0);
  return {
    path: found ? path : [],
    cost: found ? best.get(target) : null,
    expansions,
    visited: visited.size,
    found,
    complete: !exhausted,
    status: found && (strategy !== 'astar' || zeroHeuristic) ? 'proven' : 'estimated',
    note: !found
      ? exhausted ? 'the expansion budget was exhausted before the goal was reached' : 'the reachable graph was exhausted; no path exists'
      : strategy === 'astar' && !zeroHeuristic
        ? 'the path is optimal only if the supplied heuristic is admissible'
        : 'the path is shortest under the supplied non-negative edge costs',
  };
}

/* ── propositional verification ─────────────────────────────────────────── */

function validateFormula(formula, depth = 0) {
  if (depth > 40) throw bad('BAD_FORMULA', 'formula nesting is too deep');
  if (!formula || typeof formula !== 'object' || Array.isArray(formula)) throw bad('BAD_FORMULA', 'a formula must be an object');
  const op = formula.op;
  if (op === 'var') {
    if (typeof formula.name !== 'string' || !formula.name.trim()) throw bad('BAD_FORMULA', 'a variable needs a name');
    return;
  }
  if (op === 'const') {
    if (typeof formula.value !== 'boolean') throw bad('BAD_FORMULA', 'a constant needs a boolean value');
    return;
  }
  const arity = { not: 1, and: null, or: null, imp: 2, iff: 2 }[op];
  if (arity === undefined) throw bad('BAD_FORMULA', `unknown operator ${op}`);
  if (!Array.isArray(formula.args) || (arity === null && formula.args.length < 2) || (arity !== null && formula.args.length !== arity)) {
    throw bad('BAD_FORMULA', `${op} has the wrong number of arguments`);
  }
  for (const arg of formula.args) validateFormula(arg, depth + 1);
}

function collectVariables(formula, set = new Set()) {
  if (formula.op === 'var') set.add(formula.name);
  for (const arg of formula.args || []) collectVariables(arg, set);
  return set;
}

function evaluateFormula(formula, assignment) {
  switch (formula.op) {
    case 'var': return Boolean(assignment[formula.name]);
    case 'const': return formula.value;
    case 'not': return !evaluateFormula(formula.args[0], assignment);
    case 'and': return formula.args.every((arg) => evaluateFormula(arg, assignment));
    case 'or': return formula.args.some((arg) => evaluateFormula(arg, assignment));
    case 'imp': return !evaluateFormula(formula.args[0], assignment) || evaluateFormula(formula.args[1], assignment);
    case 'iff': return evaluateFormula(formula.args[0], assignment) === evaluateFormula(formula.args[1], assignment);
    default: throw bad('BAD_FORMULA', `unknown operator ${formula.op}`);
  }
}

/**
 * Classify a propositional formula by exhaustive truth table. Tautology and
 * contradiction are proven for the supplied syntax; there is no sampling.
 */
function verifyPropositional({ formula, maxVariables = 16 } = {}) {
  validateFormula(formula);
  const names = [...collectVariables(formula)].sort();
  if (names.length > maxVariables) throw bad('TOO_MANY_VARIABLES', `the truth table would exceed ${maxVariables} variables`);
  const rows = [];
  const total = 2 ** names.length;
  let trueCount = 0;
  let counterexample = null;
  for (let mask = 0; mask < total; mask += 1) {
    const assignment = {};
    names.forEach((name, index) => { assignment[name] = Boolean(mask & (1 << index)); });
    const value = evaluateFormula(formula, assignment);
    if (value) trueCount += 1;
    else if (!counterexample) counterexample = assignment;
    if (rows.length < 32) rows.push({ assignment, value });
  }
  const kind = trueCount === total ? 'tautology' : trueCount === 0 ? 'contradiction' : 'contingent';
  return {
    kind,
    valid: kind === 'tautology',
    satisfiable: trueCount > 0,
    variables: names,
    assignments: total,
    trueCount,
    counterexample,
    rows,
    status: 'proven',
    note: 'exhaustive truth table over the supplied syntax; this proves the formula, not its real-world premises',
  };
}

module.exports = {
  induce,
  counterfactual,
  bayesNetwork,
  optimizeCsp,
  hierarchicalPlan,
  graphSearch,
  verifyPropositional,
  evaluateScm,
};
