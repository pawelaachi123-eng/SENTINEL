'use strict';

/**
 * Deterministic daily briefing.
 *
 * It composes what the agent already knows — due reminders, tasks, goals,
 * contradictions and pending approvals — into a short, cited list. It does not
 * call a model, does not invent an appointment and does not read hidden data.
 * Every line carries the id it came from so the user can inspect or correct it.
 */

const DAY = 86400000;

function iso(value) {
  return new Date(value).toISOString();
}

function parseTime(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

class DailyBriefing {
  constructor({ memory = null, tasks = null, hypercore = null, approvals = null, now = () => Date.now() } = {}) {
    this.memory = memory;
    this.tasks = tasks;
    this.hypercore = hypercore;
    this.approvals = approvals;
    this.now = now;
  }

  generate({ horizonHours = 24, limit = 12 } = {}) {
    const now = this.now();
    const horizon = now + Math.max(1, Math.min(30 * 24, Number(horizonHours) || 24)) * 3600000;
    const sections = { overdue: [], upcoming: [], tasks: [], goals: [], conflicts: [], approvals: [], notes: [] };

    if (this.memory && typeof this.memory.due === 'function') {
      for (const entry of this.memory.due({ before: now, limit: 50 })) {
        sections.overdue.push({ id: entry.record.id, text: entry.record.text, dueAt: iso(entry.record.dueAt), kind: 'reminder', source: 'memory.due' });
      }
      const records = typeof this.memory.list === 'function' ? this.memory.list({ limit: 200 }) : [];
      for (const record of records) {
        if (record.kind !== 'prospective' || !record.dueAt || record.supersededBy) continue;
        if (record.dueAt > now && record.dueAt <= horizon) sections.upcoming.push({ id: record.id, text: record.text, dueAt: iso(record.dueAt), kind: 'reminder', source: 'memory.due' });
      }
    }

    if (this.tasks && typeof this.tasks.list === 'function') {
      for (const task of this.tasks.list({ limit: 50 })) {
        if (!['running', 'planning', 'queued', 'interrupted', 'waiting_approval'].includes(task.status)) continue;
        sections.tasks.push({ id: task.id, text: task.title, status: task.status, progress: task.progress, source: 'tasks.list' });
      }
    }

    if (this.hypercore) {
      for (const goal of this.hypercore.inspect('goal').items || []) {
        if (!['active', 'pending', 'blocked'].includes(goal.status)) continue;
        const deadline = goal.deadline ? parseTime(goal.deadline) : null;
        sections.goals.push({ id: goal.id, text: goal.description, status: goal.status, priority: goal.priority, deadline: goal.deadline, overdue: deadline !== null && deadline < now, source: 'hypercore.goal' });
      }
      for (const conflict of this.hypercore.inspect('conflict').items || []) {
        if (conflict.status === 'open') sections.conflicts.push({ id: conflict.id, text: `sprzeczność: ${conflict.key}`, values: [conflict.left.value, conflict.right.value], source: 'hypercore.conflict' });
      }
    }

    if (this.approvals && typeof this.approvals.list === 'function') {
      for (const approval of this.approvals.list()) {
        if (approval.consumedAt || approval.expiresAt < now) continue;
        sections.approvals.push({ id: approval.id, text: `${approval.tool} (${approval.permission})`, expiresAt: iso(approval.expiresAt), source: 'approvals.list' });
      }
    }

    const ordered = [
      ...sections.overdue.map((item) => ({ ...item, section: 'overdue', urgency: 1 })),
      ...sections.conflicts.map((item) => ({ ...item, section: 'conflicts', urgency: 0.9 })),
      ...sections.approvals.map((item) => ({ ...item, section: 'approvals', urgency: 0.8 })),
      ...sections.tasks.map((item) => ({ ...item, section: 'tasks', urgency: 0.7 })),
      ...sections.goals.map((item) => ({ ...item, section: 'goals', urgency: item.overdue ? 0.95 : 0.6 })),
      ...sections.upcoming.map((item) => ({ ...item, section: 'upcoming', urgency: 0.5 })),
    ].sort((a, b) => b.urgency - a.urgency || String(a.id).localeCompare(String(b.id))).slice(0, Math.max(1, Math.min(50, Number(limit) || 12)));

    const lines = ordered.map((item, index) => {
      if (item.section === 'overdue') return `${index + 1}. PO TERMINIE: ${item.text} (${item.dueAt}) [${item.id}]`;
      if (item.section === 'upcoming') return `${index + 1}. Wkrótce: ${item.text} (${item.dueAt}) [${item.id}]`;
      if (item.section === 'tasks') return `${index + 1}. Zadanie ${item.status} (${item.progress || 0}%): ${item.text} [${item.id}]`;
      if (item.section === 'goals') return `${index + 1}. Cel ${item.status} (p${item.priority}${item.deadline ? `, do ${item.deadline}` : ''}): ${item.text} [${item.id}]`;
      if (item.section === 'conflicts') return `${index + 1}. Sprzeczność do rozstrzygnięcia: ${item.values.map((value) => JSON.stringify(value)).join(' vs ')} [${item.id}]`;
      return `${index + 1}. Zgoda do decyzji: ${item.text} [${item.id}]`;
    });

    const counts = Object.fromEntries(Object.entries(sections).map(([name, list]) => [name, list.length]));
    return {
      generatedAt: iso(now),
      horizonHours,
      counts,
      items: ordered,
      text: lines.length ? `Briefing SENTINEL — ${iso(now).slice(0, 10)}\n${lines.join('\n')}\n\nŹródła: pamięć, zadania, hypercore, kolejka zgód. Bez modelu i bez wymyślonych terminów.` : 'Brak pilnych pozycji w pamięci, zadaniach, celach i zgodach.',
      source: 'deterministic composition of existing state',
    };
  }
}

module.exports = { DailyBriefing };
