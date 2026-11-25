'use strict';

/**
 * Deterministic planning, finance and personal-productivity tools.
 *
 * These tools compute; they do not decide for the user. Calendar tools work on
 * explicit ISO timestamps supplied by the caller, not on a hidden clock, and
 * finance results are estimates with stated assumptions.
 */

const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const finite = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error(`${name} must be finite`), { code: 'BAD_NUMBER' });
  return number;
};
const iso = (value, name) => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw Object.assign(new Error(`${name} must be an ISO date or timestamp`), { code: 'BAD_DATE' });
  return parsed;
};
const DAY = 86400000;

function workingDay(date, holidays = new Set()) {
  const day = new Date(date).getUTCDay();
  return day !== 0 && day !== 6 && !holidays.has(new Date(date).toISOString().slice(0, 10));
}

module.exports = [
  {
    name: 'planning.critical_path',
    title: 'Critical path through a task DAG',
    description: 'Computes earliest/latest start and finish, float and the critical path for tasks with durations and dependencies. Cycles, unknown dependencies and negative durations are refused.',
    category: 'productivity', permission: 'read', tags: ['planning', 'project', 'dag', 'critical-path'],
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array', minItems: 1, maxItems: 200,
          items: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1, maxLength: 100 }, duration: { type: 'number', minimum: 0, maximum: 100000 }, dependsOn: { type: 'array', maxItems: 50, items: { type: 'string' } } },
            required: ['id', 'duration'], additionalProperties: false,
          },
        },
      },
      required: ['tasks'], additionalProperties: false,
    },
    async run(args) {
      const tasks = args.tasks.map((task) => ({ id: String(task.id), duration: finite(task.duration, 'duration'), dependsOn: (task.dependsOn || []).map(String) }));
      const ids = new Set();
      for (const task of tasks) {
        if (ids.has(task.id)) return { ok: false, code: 'DUPLICATE_ID', message: `duplicate task ${task.id}` };
        ids.add(task.id);
        if (task.duration < 0) return { ok: false, code: 'NEGATIVE_DURATION', message: `negative duration for ${task.id}` };
      }
      for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) return { ok: false, code: 'UNKNOWN_DEPENDENCY', message: `${task.id} depends on unknown ${dependency}` };
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const state = new Map();
      const order = [];
      const visit = (id, stack) => {
        if (state.get(id) === 'done') return true;
        if (state.get(id) === 'visiting') return false;
        state.set(id, 'visiting');
        for (const dependency of byId.get(id).dependsOn) if (!visit(dependency, [...stack, id])) return false;
        state.set(id, 'done');
        order.push(id);
        return true;
      };
      for (const task of tasks) if (!visit(task.id, [])) return { ok: false, code: 'CYCLE', message: 'dependency graph contains a cycle' };
      const earliestStart = new Map();
      const earliestFinish = new Map();
      for (const id of order) {
        const task = byId.get(id);
        const start = task.dependsOn.length ? Math.max(...task.dependsOn.map((dependency) => earliestFinish.get(dependency))) : 0;
        earliestStart.set(id, start);
        earliestFinish.set(id, start + task.duration);
      }
      const projectEnd = Math.max(...[...earliestFinish.values()]);
      const latestFinish = new Map();
      const latestStart = new Map();
      for (const id of [...order].reverse()) {
        const task = byId.get(id);
        const successors = tasks.filter((candidate) => candidate.dependsOn.includes(id));
        const finish = successors.length ? Math.min(...successors.map((successor) => latestStart.get(successor.id))) : projectEnd;
        latestFinish.set(id, finish);
        latestStart.set(id, finish - task.duration);
      }
      const rows = tasks.map((task) => {
        const float = latestStart.get(task.id) - earliestStart.get(task.id);
        return { id: task.id, duration: task.duration, earliestStart: earliestStart.get(task.id), earliestFinish: earliestFinish.get(task.id), latestStart: latestStart.get(task.id), latestFinish: latestFinish.get(task.id), float, critical: float === 0 };
      });
      return { ok: true, projectDuration: projectEnd, tasks: rows.sort((a, b) => a.earliestStart - b.earliestStart), criticalPath: rows.filter((row) => row.critical).map((row) => row.id) };
    },
    format: (data) => `${data.projectDuration}, ${data.criticalPath.length} zadań krytycznych`,
  },
  {
    name: 'planning.pert', title: 'PERT estimate',
    description: 'Three-point PERT estimate: expected = (optimistic + 4×likely + pessimistic)/6 and standard deviation = (pessimistic − optimistic)/6.',
    category: 'productivity', permission: 'read', tags: ['planning', 'estimate', 'pert'],
    parameters: { type: 'object', properties: { optimistic: { type: 'number' }, likely: { type: 'number' }, pessimistic: { type: 'number' } }, required: ['optimistic', 'likely', 'pessimistic'], additionalProperties: false },
    async run(args) {
      const o = finite(args.optimistic, 'optimistic');
      const m = finite(args.likely, 'likely');
      const p = finite(args.pessimistic, 'pessimistic');
      if (!(o <= m && m <= p)) return { ok: false, code: 'BAD_ORDER', message: 'require optimistic <= likely <= pessimistic' };
      return { ok: true, expected: round((o + 4 * m + p) / 6, 4), standardDeviation: round((p - o) / 6, 4), variance: round(((p - o) / 6) ** 2, 4), assumption: 'beta approximation; estimate, not a guarantee' };
    },
    format: (data) => `${data.expected} ± ${data.standardDeviation}`,
  },
  {
    name: 'planning.working_days', title: 'Add or count working days',
    description: 'Adds N working days to an ISO date, skipping weekends and explicit holiday dates. It uses UTC and no regional holiday calendar is assumed.',
    category: 'productivity', permission: 'read', tags: ['calendar', 'working-days', 'deadline'],
    parameters: { type: 'object', properties: { date: { type: 'string' }, days: { type: 'number', minimum: -3650, maximum: 3650 }, holidays: { type: 'array', maxItems: 366, items: { type: 'string' } } }, required: ['date', 'days'], additionalProperties: false },
    async run(args) {
      let time = iso(args.date, 'date');
      const days = Math.trunc(finite(args.days, 'days'));
      const holidays = new Set((args.holidays || []).map((day) => new Date(iso(day, 'holiday')).toISOString().slice(0, 10)));
      const step = days >= 0 ? 1 : -1;
      let remaining = Math.abs(days);
      if (!workingDay(time, holidays) && days !== 0) {
        // Starting on a non-working day: move to the next working day first.
        while (!workingDay(time, holidays)) time += step * DAY;
      }
      while (remaining > 0) {
        time += step * DAY;
        if (workingDay(time, holidays)) remaining -= 1;
      }
      return { ok: true, date: new Date(time).toISOString().slice(0, 10), requestedWorkingDays: days, holidays: holidays.size };
    },
    format: (data) => data.date,
  },
  {
    name: 'planning.free_slots', title: 'Free calendar slots',
    description: 'Finds free intervals inside a UTC window given busy intervals. Overlapping busy intervals are merged; malformed or reversed intervals are refused.',
    category: 'productivity', permission: 'read', tags: ['calendar', 'scheduling', 'free-time'],
    parameters: {
      type: 'object',
      properties: { start: { type: 'string' }, end: { type: 'string' }, busy: { type: 'array', maxItems: 200, items: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'], additionalProperties: false } }, minimumMinutes: { type: 'number', minimum: 1, maximum: 1440 } },
      required: ['start', 'end'], additionalProperties: false,
    },
    async run(args) {
      const start = iso(args.start, 'start');
      const end = iso(args.end, 'end');
      if (end <= start) return { ok: false, code: 'BAD_WINDOW', message: 'end must be after start' };
      const busy = [];
      for (const interval of args.busy || []) {
        const left = iso(interval.start, 'busy.start');
        const right = iso(interval.end, 'busy.end');
        if (right <= left) return { ok: false, code: 'BAD_INTERVAL', message: 'busy interval ends before it starts' };
        busy.push([Math.max(left, start), Math.min(right, end)]);
      }
      busy.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const interval of busy) {
        if (interval[1] <= interval[0]) continue;
        const last = merged[merged.length - 1];
        if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
        else merged.push([...interval]);
      }
      const minimum = (args.minimumMinutes || 15) * 60000;
      const free = [];
      let cursor = start;
      for (const [left, right] of merged) {
        if (left - cursor >= minimum) free.push({ start: new Date(cursor).toISOString(), end: new Date(left).toISOString(), minutes: Math.round((left - cursor) / 60000) });
        cursor = Math.max(cursor, right);
      }
      if (end - cursor >= minimum) free.push({ start: new Date(cursor).toISOString(), end: new Date(end).toISOString(), minutes: Math.round((end - cursor) / 60000) });
      return { ok: true, free, busyMinutes: Math.round(merged.reduce((sum, [left, right]) => sum + right - left, 0) / 60000), timezone: 'UTC' };
    },
    format: (data) => `${data.free.length} wolnych okien`,
  },
  {
    name: 'planning.priority_matrix', title: 'Eisenhower priority matrix',
    description: 'Classifies tasks by explicit importance and urgency into do/schedule/delegate/eliminate. It does not guess importance from wording.',
    category: 'productivity', permission: 'read', tags: ['planning', 'priority', 'eisenhower'],
    parameters: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 300 }, important: { type: 'boolean' }, urgent: { type: 'boolean' } }, required: ['title', 'important', 'urgent'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false },
    async run(args) {
      const groups = { do: [], schedule: [], delegate: [], eliminate: [] };
      for (const task of args.tasks) {
        const key = task.important && task.urgent ? 'do' : task.important ? 'schedule' : task.urgent ? 'delegate' : 'eliminate';
        groups[key].push(String(task.title));
      }
      return { ok: true, ...groups, rule: 'importance and urgency are caller-provided, not inferred' };
    },
    format: (data) => `${data.do.length} do zrobienia teraz`,
  },
  {
    name: 'planning.progress', title: 'Weighted checklist progress',
    description: 'Computes completed/total and weighted progress from explicit weights; refuses negative weights and reports when all weights are zero.',
    category: 'productivity', permission: 'read', tags: ['tasks', 'progress', 'checklist'],
    parameters: { type: 'object', properties: { items: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', properties: { done: { type: 'boolean' }, weight: { type: 'number', minimum: 0, maximum: 1000 } }, required: ['done'], additionalProperties: false } } }, required: ['items'], additionalProperties: false },
    async run(args) {
      const total = args.items.length;
      const completed = args.items.filter((item) => item.done).length;
      const weightTotal = args.items.reduce((sum, item) => sum + (item.weight === undefined ? 1 : finite(item.weight, 'weight')), 0);
      const weightDone = args.items.reduce((sum, item) => sum + (item.done ? (item.weight === undefined ? 1 : finite(item.weight, 'weight')) : 0), 0);
      return { ok: true, completed, total, percent: round((completed / total) * 100, 2), weightedPercent: weightTotal ? round((weightDone / weightTotal) * 100, 2) : null };
    },
    format: (data) => `${data.completed}/${data.total} (${data.percent}%)`,
  },
  {
    name: 'planning.pomodoro', title: 'Pomodoro schedule',
    description: 'Splits available minutes into focus blocks, short breaks and long breaks after every fourth block. Estimates only.',
    category: 'productivity', permission: 'read', tags: ['planning', 'pomodoro', 'time'],
    parameters: { type: 'object', properties: { minutes: { type: 'number', minimum: 5, maximum: 1440 }, focus: { type: 'number', minimum: 5, maximum: 120 }, shortBreak: { type: 'number', minimum: 1, maximum: 60 }, longBreak: { type: 'number', minimum: 5, maximum: 120 } }, required: ['minutes'], additionalProperties: false },
    async run(args) {
      const available = finite(args.minutes, 'minutes');
      const focus = args.focus || 25;
      const shortBreak = args.shortBreak || 5;
      const longBreak = args.longBreak || 15;
      let remaining = available;
      const blocks = [];
      let count = 0;
      while (remaining >= focus) {
        blocks.push({ type: 'focus', minutes: focus });
        remaining -= focus;
        count += 1;
        const pause = count % 4 === 0 ? longBreak : shortBreak;
        if (remaining >= pause) {
          blocks.push({ type: count % 4 === 0 ? 'long-break' : 'short-break', minutes: pause });
          remaining -= pause;
        }
      }
      return { ok: true, blocks, focusBlocks: count, leftoverMinutes: round(remaining, 1), plannedMinutes: round(available - remaining, 1) };
    },
    format: (data) => `${data.focusBlocks} bloków`,
  },
  {
    name: 'finance.compound', title: 'Compound interest',
    description: 'Computes future value with periodic compounding and optional regular contributions. Nominal annual rate, estimate only, no tax or inflation.',
    category: 'finance', permission: 'read', tags: ['finance', 'interest', 'savings'],
    parameters: { type: 'object', properties: { principal: { type: 'number', minimum: 0 }, annualRate: { type: 'number' }, years: { type: 'number', minimum: 0, maximum: 100 }, compoundsPerYear: { type: 'number', minimum: 1, maximum: 365, default: 12 }, contribution: { type: 'number', minimum: 0, default: 0 } }, required: ['principal', 'annualRate', 'years'], additionalProperties: false },
    async run(args) {
      const principal = finite(args.principal, 'principal');
      const rate = finite(args.annualRate, 'annualRate');
      const years = finite(args.years, 'years');
      const periods = Math.max(1, Math.floor(args.compoundsPerYear || 12));
      const contribution = Math.max(0, finite(args.contribution || 0, 'contribution'));
      const periodicRate = rate / 100 / periods;
      const totalPeriods = Math.round(years * periods);
      let value = principal;
      for (let period = 0; period < totalPeriods; period += 1) value = value * (1 + periodicRate) + contribution;
      return { ok: true, futureValue: round(value, 2), contributed: round(principal + contribution * totalPeriods, 2), interest: round(value - principal - contribution * totalPeriods, 2), periods: totalPeriods, assumptions: 'nominal annual rate, contributions at period end, no tax/inflation' };
    },
    format: (data) => `${data.futureValue}`,
  },
  {
    name: 'finance.loan_payment', title: 'Loan amortisation payment',
    description: 'Computes the fixed monthly payment for an amortising loan, plus total interest. Fees, insurance and variable rates are excluded.',
    category: 'finance', permission: 'read', tags: ['finance', 'loan', 'mortgage'],
    parameters: { type: 'object', properties: { principal: { type: 'number', minimum: 1 }, annualRate: { type: 'number', minimum: 0 }, months: { type: 'number', minimum: 1, maximum: 1200 } }, required: ['principal', 'annualRate', 'months'], additionalProperties: false },
    async run(args) {
      const principal = finite(args.principal, 'principal');
      const months = Math.floor(finite(args.months, 'months'));
      const monthly = args.annualRate / 100 / 12;
      const payment = monthly === 0 ? principal / months : (principal * monthly * (1 + monthly) ** months) / ((1 + monthly) ** months - 1);
      return { ok: true, payment: round(payment, 2), totalPaid: round(payment * months, 2), totalInterest: round(payment * months - principal, 2), annualRate: args.annualRate, assumptions: 'fixed rate, fixed payment, no fees' };
    },
    format: (data) => `${data.payment}/mies.`,
  },
  {
    name: 'finance.break_even', title: 'Break-even point',
    description: 'Computes unit and revenue break-even from fixed costs, unit price and variable cost. Refuses a non-positive contribution margin.',
    category: 'finance', permission: 'read', tags: ['finance', 'break-even', 'business'],
    parameters: { type: 'object', properties: { fixedCosts: { type: 'number', minimum: 0 }, price: { type: 'number', minimum: 0 }, variableCost: { type: 'number', minimum: 0 } }, required: ['fixedCosts', 'price', 'variableCost'], additionalProperties: false },
    async run(args) {
      const fixed = finite(args.fixedCosts, 'fixedCosts');
      const price = finite(args.price, 'price');
      const variable = finite(args.variableCost, 'variableCost');
      const margin = price - variable;
      if (margin <= 0) return { ok: false, code: 'NO_MARGIN', message: 'price must exceed variable cost' };
      const units = fixed / margin;
      return { ok: true, units: Math.ceil(units), exactUnits: round(units, 4), revenue: round(Math.ceil(units) * price, 2), contributionMargin: round(margin, 2), marginRatio: round((margin / price) * 100, 2) };
    },
    format: (data) => `${data.units} szt.`,
  },
  {
    name: 'finance.budget_split', title: 'Budget split',
    description: 'Splits an amount by explicit weights and returns rounded shares whose sum equals the original amount, distributing the remainder deterministically.',
    category: 'finance', permission: 'read', tags: ['finance', 'budget', 'allocation'],
    parameters: { type: 'object', properties: { amount: { type: 'number' }, weights: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'number', minimum: 0 } }, currency: { type: 'string', maxLength: 8 } }, required: ['amount', 'weights'], additionalProperties: false },
    async run(args) {
      const amount = finite(args.amount, 'amount');
      const weights = args.weights.map((weight) => finite(weight, 'weight'));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      if (total <= 0) return { ok: false, code: 'ZERO_WEIGHT', message: 'weights must sum to a positive value' };
      const cents = Math.round(amount * 100);
      const raw = weights.map((weight) => (cents * weight) / total);
      const shares = raw.map((value) => Math.floor(value));
      let remainder = cents - shares.reduce((sum, value) => sum + value, 0);
      const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
      for (let index = 0; index < remainder; index += 1) shares[order[index % order.length].index] += 1;
      return { ok: true, currency: args.currency || null, shares: shares.map((value) => round(value / 100, 2)), total: round(shares.reduce((sum, value) => sum + value, 0) / 100, 2) };
    },
    format: (data) => `${data.shares.join(' + ')} = ${data.total}`,
  },
  {
    name: 'finance.roi', title: 'Return on investment',
    description: 'Computes ROI and annualised ROI from gain and cost. It does not account for risk, tax or cash-flow timing beyond the simple annualisation.',
    category: 'finance', permission: 'read', tags: ['finance', 'roi', 'investment'],
    parameters: { type: 'object', properties: { gain: { type: 'number' }, cost: { type: 'number', minimum: 0 }, years: { type: 'number', minimum: 0, maximum: 100 } }, required: ['gain', 'cost'], additionalProperties: false },
    async run(args) {
      const gain = finite(args.gain, 'gain');
      const cost = finite(args.cost, 'cost');
      if (cost <= 0) return { ok: false, code: 'ZERO_COST', message: 'cost must be positive' };
      const roi = (gain - cost) / cost;
      const annualised = args.years ? (1 + roi) ** (1 / args.years) - 1 : null;
      return { ok: true, roiPercent: round(roi * 100, 2), annualisedPercent: annualised === null ? null : round(annualised * 100, 2), note: 'simple ROI; no risk adjustment' };
    },
    format: (data) => `${data.roiPercent}%`,
  },
  {
    name: 'decision.matrix', title: 'Weighted decision matrix',
    description: 'Scores options against weighted criteria (0–10 scores) and ranks them. Weights and scores are caller-provided; the tool does not invent preferences.',
    category: 'productivity', permission: 'read', tags: ['decision', 'matrix', 'comparison'],
    parameters: {
      type: 'object',
      properties: {
        criteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { name: { type: 'string' }, weight: { type: 'number', minimum: 0 } }, required: ['name', 'weight'], additionalProperties: false } },
        options: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { name: { type: 'string' }, scores: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'number', minimum: 0, maximum: 10 } } }, required: ['name', 'scores'], additionalProperties: false } },
      },
      required: ['criteria', 'options'], additionalProperties: false,
    },
    async run(args) {
      if (args.criteria.length !== args.options[0].scores.length) return { ok: false, code: 'DIMENSION_MISMATCH', message: 'each option needs one score per criterion' };
      if (!args.options.every((option) => option.scores.length === args.criteria.length)) return { ok: false, code: 'DIMENSION_MISMATCH', message: 'option score counts differ' };
      const totalWeight = args.criteria.reduce((sum, criterion) => sum + finite(criterion.weight, 'weight'), 0);
      if (totalWeight <= 0) return { ok: false, code: 'ZERO_WEIGHT', message: 'criteria weights must be positive overall' };
      const ranked = args.options.map((option) => ({
        name: String(option.name),
        score: round(option.scores.reduce((sum, score, index) => sum + score * args.criteria[index].weight, 0) / totalWeight, 4),
      })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      return { ok: true, ranked, weightsNormalised: true, totalWeight: round(totalWeight, 4) };
    },
    format: (data) => `${data.ranked[0].name}: ${data.ranked[0].score}`,
  },
  {
    name: 'notes.outline', title: 'Markdown outline',
    description: 'Extracts headings and their levels from Markdown into a tree. It does not summarise or rewrite the content.',
    category: 'productivity', permission: 'read', tags: ['notes', 'markdown', 'outline'],
    parameters: { type: 'object', properties: { markdown: { type: 'string', minLength: 1, maxLength: 100000 } }, required: ['markdown'], additionalProperties: false },
    async run(args) {
      const lines = String(args.markdown).split(/\r?\n/);
      const headings = [];
      for (let index = 0; index < lines.length; index += 1) {
        const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
        if (match) headings.push({ level: match[1].length, title: match[2].trim(), line: index + 1 });
      }
      return { ok: true, headings, count: headings.length };
    },
    format: (data) => `${data.count} nagłówków`,
  },
  {
    name: 'notes.checklist', title: 'Checklist from Markdown',
    description: 'Extracts GitHub-style task list items with their completion state and line numbers, and reports progress.',
    category: 'productivity', permission: 'read', tags: ['notes', 'checklist', 'markdown'],
    parameters: { type: 'object', properties: { markdown: { type: 'string', minLength: 1, maxLength: 100000 } }, required: ['markdown'], additionalProperties: false },
    async run(args) {
      const items = [];
      String(args.markdown).split(/\r?\n/).forEach((line, index) => {
        const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
        if (match) items.push({ text: match[2].trim(), done: match[1].toLowerCase() === 'x', line: index + 1 });
      });
      const done = items.filter((item) => item.done).length;
      return { ok: true, items, done, total: items.length, percent: items.length ? round((done / items.length) * 100, 1) : 0 };
    },
    format: (data) => `${data.done}/${data.total}`,
  },
  {
    name: 'meeting.agenda', title: 'Timed meeting agenda',
    description: 'Builds an agenda with start times from item durations and an optional ISO start. It does not schedule the meeting or invite anyone.',
    category: 'productivity', permission: 'read', tags: ['meeting', 'agenda', 'time'],
    parameters: { type: 'object', properties: { start: { type: 'string' }, items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { title: { type: 'string', minLength: 1 }, minutes: { type: 'number', minimum: 1, maximum: 480 } }, required: ['title', 'minutes'], additionalProperties: false } } }, required: ['items'], additionalProperties: false },
    async run(args) {
      const total = args.items.reduce((sum, item) => sum + finite(item.minutes, 'minutes'), 0);
      let cursor = args.start ? iso(args.start, 'start') : null;
      const agenda = args.items.map((item) => {
        const entry = { title: String(item.title), minutes: item.minutes, start: cursor === null ? null : new Date(cursor).toISOString() };
        if (cursor !== null) cursor += item.minutes * 60000;
        return entry;
      });
      return { ok: true, agenda, totalMinutes: total, endsAt: cursor === null ? null : new Date(cursor).toISOString() };
    },
    format: (data) => `${data.agenda.length} punktów, ${data.totalMinutes} min`,
  },
  {
    name: 'calendar.week_number', title: 'ISO week number',
    description: 'Returns the ISO-8601 week and week-year for an ISO date, using the Thursday rule.',
    category: 'productivity', permission: 'read', tags: ['calendar', 'week', 'iso8601'],
    parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'], additionalProperties: false },
    async run(args) {
      const time = iso(args.date, 'date');
      const date = new Date(time);
      const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const day = utc.getUTCDay() || 7;
      utc.setUTCDate(utc.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((utc - yearStart) / DAY + 1) / 7);
      return { ok: true, week, year: utc.getUTCFullYear(), isoDate: new Date(time).toISOString().slice(0, 10) };
    },
    format: (data) => `${data.year}-W${String(data.week).padStart(2, '0')}`,
  },
  {
    name: 'calendar.countdown', title: 'Time until a deadline',
    description: 'Returns days, hours and minutes between two ISO timestamps and whether the deadline has passed. It uses the caller-supplied clock, not a hidden one.',
    category: 'productivity', permission: 'read', tags: ['calendar', 'deadline', 'countdown'],
    parameters: { type: 'object', properties: { now: { type: 'string' }, deadline: { type: 'string' } }, required: ['now', 'deadline'], additionalProperties: false },
    async run(args) {
      const now = iso(args.now, 'now');
      const deadline = iso(args.deadline, 'deadline');
      const delta = deadline - now;
      return { ok: true, overdue: delta < 0, days: Math.floor(Math.abs(delta) / DAY), hours: Math.floor((Math.abs(delta) % DAY) / 3600000), minutes: Math.floor((Math.abs(delta) % 3600000) / 60000), totalMinutes: Math.round(delta / 60000) };
    },
    format: (data) => `${data.overdue ? 'po terminie' : 'pozostało'} ${data.days}d ${data.hours}h`,
  },
  {
    name: 'docs.reading_time', title: 'Reading time',
    description: 'Estimates reading time from word count at an explicit words-per-minute rate. It is an estimate, not measured reading speed.',
    category: 'productivity', permission: 'read', tags: ['documents', 'reading', 'estimate'],
    parameters: { type: 'object', properties: { words: { type: 'number', minimum: 0 }, wordsPerMinute: { type: 'number', minimum: 50, maximum: 1000, default: 200 } }, required: ['words'], additionalProperties: false },
    async run(args) {
      const words = finite(args.words, 'words');
      const rate = args.wordsPerMinute || 200;
      return { ok: true, minutes: round(words / rate, 2), words, wordsPerMinute: rate, note: 'estimate; technical or visual material may take longer' };
    },
    format: (data) => `${data.minutes} min`,
  },
];
