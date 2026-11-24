'use strict';

/**
 * The agent roster.
 *
 * Thirty specialists share one model and one tool registry. Two kinds exist, and
 * the difference matters:
 *
 *   • tool agents have a handler. They answer from real data through the tool
 *     engine — a math question goes to the parser, an ESP32 question to the
 *     link — and work with no model installed at all.
 *   • llm agents reason. They get a specialist system prompt plus only the tools
 *     relevant to their job, and run a short, bounded tool loop.
 *
 * The dispatcher picks the smallest set that can answer. It is not a fan-out:
 * one primary agent, at most one helper, and no agent at all for a plain
 * question the conversation agent can handle.
 */

const { baseSystemPrompt, toToolSchema, fromToolName } = require('./prompt');

const MAX_TOOL_CALLS = 6;

/* ── small extractors used by deterministic agents ─────────────────────── */

function findExpression(text) {
  const source = String(text).replace(/[,]/g, ' ').replace(/[=?]/g, ' ');
  const number = String.raw`(?:\d+(?:\.\d+)?|\([^()]*\))`;
  const pattern = new RegExp(`[-+]?${number}(?:\\s*[-+*/%^]\\s*${number})+`, 'g');
  const matches = source.match(pattern) || [];
  const withFunctions = source.match(/(?:sqrt|log|ln|sin|cos|tan|abs|min|max|round|floor|ceil)\([^()]*\)(?:\s*[-+*/%^]\s*\d+(?:\.\d+)?)*/g) || [];
  const candidates = [...matches, ...withFunctions].filter((candidate) => /\d/.test(candidate) && /[-+*/%^]|sqrt|log|sin|cos|min|max/.test(candidate));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.length - a.length)[0].trim();
}

function findPath(text) {
  const quoted = String(text).match(/["'`]([^"'`]{2,200})["'`]/);
  if (quoted) return quoted[1];
  const windows = String(text).match(/[A-Za-z]:\\[^\s,;]+/);
  if (windows) return windows[0];
  const unix = String(text).match(/(?:^|\s)([~.][\w./-]{0,180})/);
  return unix ? unix[1] : null;
}

function findQuery(text, prefixes) {
  const lower = String(text).toLowerCase();
  for (const prefix of prefixes) {
    const index = lower.indexOf(prefix);
    if (index >= 0) return String(text).slice(index + prefix.length).replace(/^[\s:,-]+/, '').trim();
  }
  return String(text).trim();
}

const isMathQuestion = (text) => /^(ile|oblicz|policz|calculate|compute|what is|ile to)/i.test(text.trim()) || /\d\s*[+\-*/^%]\s*\d/.test(text);

/* ── specs ─────────────────────────────────────────────────────────────── */

const SPECS = [
  {
    name: 'dispatcher',
    title: 'Dispatcher',
    role: 'orchestrator',
    description: 'Routes a request to the smallest set of specialists and owns the run.',
    triggers: [],
    modelClass: 'fast',
    categories: [],
  },
  {
    name: 'supervisor',
    title: 'Supervisor',
    role: 'orchestrator',
    description: 'Watches a multi-step task: ordering, dependencies, timeouts and whether the result is usable.',
    triggers: ['nadzoruj', 'supervise', 'koordynuj', 'coordinate', 'zarządzaj zadaniem'],
    modelClass: 'balanced',
    categories: ['memory', 'dev'],
    instructions: `You supervise multi-step work. You never invent progress: if a step failed, say so and explain the next attempt. Keep plans short enough to finish.`,
  },
  {
    name: 'planning',
    title: 'Planning',
    role: 'llm',
    description: 'Breaks a goal into ordered, verifiable steps with dependencies.',
    triggers: ['zaplanuj', 'plan', 'kroki', 'steps', 'harmonogram', 'roadmap', 'jak to zrobić'],
    modelClass: 'balanced',
    categories: ['memory', 'dev'],
    instructions: `You produce plans. Output strictly JSON: {"steps":[{"id":"s1","title":"...","agent":"<agent name>","dependsOn":[]}]}.
Rules: 2-6 steps; each step must be checkable; no step may be "ask the user" unless information is genuinely missing;
prefer concrete agents (windows, hardware, file, network, esp32, math, coding, testing).`,
  },
  {
    name: 'reasoning',
    title: 'Reasoning',
    role: 'llm',
    description: 'Logical, causal and comparative questions; shows its assumptions.',
    triggers: ['dlaczego', 'why', 'porównaj', 'compare', 'wyjaśnij', 'explain', 'czy lepiej', 'which is better', 'wnioskuj'],
    modelClass: 'balanced',
    categories: ['math', 'knowledge', 'memory', 'documents'],
    instructions: `You reason carefully and briefly. State the assumptions you rely on, separate facts (from context) from inference,
and if the question is underdetermined say what is missing instead of guessing. For arithmetic use math.eval.`,
  },
  {
    name: 'coding',
    title: 'Coding',
    role: 'llm',
    description: 'Writes and modifies code in the workspace, with syntax checks.',
    triggers: ['napisz', 'kod', 'kodu', 'funkcj', 'skrypt', 'implement', 'refactor', 'komponent', 'write code', 'code', 'program', 'stwórz plik', 'popraw'],
    modelClass: 'code',
    categories: ['files', 'code', 'dev'],
    instructions: `You write code that fits the existing project. Read before you write: inspect the file (fs.read / code.file.summary)
and match its style, naming and error handling. After writing JavaScript run dev.lint.syntax or dev.command "node --check <file>".
Never leave a TODO where an implementation is expected. Explain the change in two or three sentences, not a lecture.`,
  },
  {
    name: 'debugging',
    title: 'Debugging',
    role: 'llm',
    description: 'Finds the cause of a failure from logs, code and recent changes.',
    triggers: ['błąd', 'error', 'nie działa', 'broken', 'crash', 'exception', 'stack trace', 'wyjątek', 'debug'],
    modelClass: 'code',
    categories: ['code', 'files', 'dev', 'documents'],
    instructions: `You debug systematically. First gather evidence (log tail, error text, git diff, relevant source), then state the most likely
cause with the evidence that supports it, then the smallest fix. If evidence is missing, name the one command or file that would settle it.`,
  },
  {
    name: 'testing',
    title: 'Testing',
    role: 'llm',
    description: 'Runs and interprets the project test suite; reports what actually passed.',
    triggers: ['test', 'testy', 'sprawdź czy działa', 'run tests', 'uruchom testy'],
    modelClass: 'balanced',
    categories: ['dev', 'code', 'files'],
    instructions: `You run tests and report only what the output proves. Read the script list first (dev.scripts), then run the narrowest useful
command (dev.command "npm test"). Never describe a test as passing unless you saw exit code 0. Quote the failing assertion.`,
  },
  {
    name: 'research',
    title: 'Research',
    role: 'llm',
    description: 'Synthesises what is in the knowledge base and memory, with citations.',
    triggers: ['znajdź', 'search', 'w dokumentach', 'co wiesz o', 'find in my files', 'przeczytaj', 'podsumuj dokument'],
    modelClass: 'balanced',
    categories: ['knowledge', 'documents', 'memory'],
    instructions: `You answer from the user's own documents. Search first (kb.search), quote the relevant line, cite it as [K#].
If the knowledge base has nothing, say so plainly and suggest indexing the file — do not fill the gap with general knowledge without labelling it as such.`,
  },
  {
    name: 'windows',
    title: 'Windows',
    role: 'tool',
    description: 'Machine state, processes, services, startup entries and power actions.',
    triggers: ['windows', 'proces', 'procesy', 'usługa', 'service', 'uruchomiony', 'co jest włączone', 'zużycie', 'power'],
    modelClass: 'fast',
    categories: ['system', 'desktop'],
    handler: async (runtime, args) => {
      const text = runtime.request.text.toLowerCase();
      if (/proces|process|zużycie|cpu|ram|pamięć/.test(text)) {
        const [list, top] = await Promise.all([runtime.tool('process.list', { limit: 12, sort: /ram|pamięć|memory/.test(text) ? 'mem' : 'cpu' }), runtime.tool('process.top', {})]);
        return {
          text: `Najcięższe procesy:\n${top.data.byCpu.map((proc) => `  ${proc.name} (pid ${proc.pid}) — CPU ${proc.cpuSec ?? proc.cpuPercent}s, ${proc.memMB} MB`).join('\n')}`,
          data: { processes: list.data.processes, top: top.data },
          toolsUsed: ['process.list', 'process.top'],
        };
      }
      if (/usług|service/.test(text)) {
        const services = await runtime.tool('service.list', { runningOnly: true, limit: 25 });
        return { text: `${services.data.services.length} running services (first 25).`, data: services.data, toolsUsed: ['service.list'] };
      }
      if (/startup|autostart/.test(text)) {
        const startup = await runtime.tool('startup.list', {});
        return { text: `${startup.data.entries.length} startup entries.`, data: startup.data, toolsUsed: ['startup.list'] };
      }
      const snapshot = await runtime.tool('system.snapshot', {});
      return {
        text: `PC: CPU ${snapshot.data.cpuPercent}%, RAM ${snapshot.data.memory ? `${snapshot.data.memory.percent}%` : '?'}, uptime ${snapshot.data.uptime}. ESP32: ${snapshot.data.esp && snapshot.data.esp.connected ? 'connected' : 'offline'}.`,
        data: snapshot.data,
        toolsUsed: ['system.snapshot'],
      };
    },
  },
  {
    name: 'hardware',
    title: 'Hardware',
    role: 'tool',
    description: 'CPU, GPU, VRAM, disks, memory, temperatures and battery.',
    triggers: ['gpu', 'karta graficzna', 'vram', 'cpu', 'dysk', 'dyski', 'ram', 'temperatura', 'bateria', 'sprzęt', 'hardware'],
    modelClass: 'fast',
    categories: ['system'],
    handler: async (runtime) => {
      const [cpu, gpu, memory, disks, temps] = await Promise.all([
        runtime.tool('cpu.info', {}),
        runtime.tool('gpu.info', {}),
        runtime.tool('memory.status', {}),
        runtime.tool('disk.volumes', {}),
        runtime.tool('sensors.temps', {}),
      ]);
      const gpuLine = gpu.data.nvidia && gpu.data.nvidia.length
        ? gpu.data.nvidia.map((card) => `${card.name}: ${card.vramUsedMB}/${card.vramTotalMB} MB VRAM, ${card.utilisationPercent}%, ${card.tempC}°C`).join('; ')
        : (gpu.data.cards || []).map((card) => card.name).join(', ') || 'nie wykryto GPU';
      const lines = [
        `CPU: ${cpu.data.model} (${cpu.data.cores} wątków, obciążenie ${cpu.data.loadPercent}%)`,
        `GPU: ${gpuLine}`,
        `RAM: ${memory.data.used ? `${Math.round(memory.data.used / 1024 ** 3)} GB` : '?'} z ${Math.round(memory.data.total / 1024 ** 3)} GB (${memory.data.percent}%)`,
        `Dyski: ${disks.data.volumes.map((disk) => `${disk.drive || disk.mounted} ${disk.freeGB} GB wolne`).join(', ')}`,
        temps.data.temps && temps.data.temps.length ? `Temperatury: ${temps.data.temps.map((temp) => `${temp.source} ${temp.celsius}°C`).join(', ')}` : 'Temperatury: brak czujników',
      ];
      return { text: lines.join('\n'), data: { cpu: cpu.data, gpu: gpu.data, memory: memory.data, disks: disks.data, temps: temps.data }, toolsUsed: ['cpu.info', 'gpu.info', 'memory.status', 'disk.volumes', 'sensors.temps'] };
    },
  },
  {
    name: 'gaming',
    title: 'Gaming',
    role: 'tool',
    description: 'Gaming mode: frees GPU/VRAM and silences the agent while you play.',
    triggers: ['gaming', 'gra', 'gram w', 'fps', 'gaming mode', 'tryb gry'],
    modelClass: 'fast',
    categories: ['system', 'perf'],
    handler: async (runtime) => {
      const text = runtime.request.text.toLowerCase();
      const enable = !/(wyłącz|off|disable|stop)/.test(text);
      const result = await runtime.tool('perf.gaming', { enabled: enable });
      return {
        text: enable
          ? 'Tryb gaming włączony: model trzyma się w VRAM tylko na czas odpowiedzi, animacje UI zwolnione, agenci w tle wstrzymani.'
          : 'Tryb gaming wyłączony: normalne działanie przywrócone.',
        data: result.data,
        toolsUsed: ['perf.gaming'],
      };
    },
  },
  {
    name: 'network',
    title: 'Network',
    role: 'tool',
    description: 'Interfaces, LAN devices, ports, Wi-Fi and the encrypted tunnel.',
    triggers: ['sieć', 'network', 'ip', 'ping', 'wifi', 'port', 'tunel', 'tunnel', 'połączenie', 'router', 'lan'],
    modelClass: 'fast',
    categories: ['network', 'esp32'],
    handler: async (runtime) => {
      const text = runtime.request.text.toLowerCase();
      const host = (String(runtime.request.text).match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/) || [])[1];
      if (host) {
        const ping = await runtime.tool('net.ping', { host, count: 3 });
        return {
          text: ping.data.reachable
            ? `${host} odpowiada (średnio ${ping.data.avgMs ?? '?'} ms, utrata ${ping.data.packetLossPercent}%).`
            : `${host} nie odpowiada na ping.`,
          data: ping.data,
          toolsUsed: ['net.ping'],
        };
      }
      if (/tunel|tunnel|telefon|phone/.test(text)) {
        const tunnel = await runtime.tool('tunnel.status', {});
        return { text: `Tunel: ${tunnel.data.running ? `${tunnel.data.sessions.length} aktywnych sesji, szyfrowanie ST1 (AES-256-GCM)` : 'nie działa'}.`, data: tunnel.data, toolsUsed: ['tunnel.status'] };
      }
      if (/port/.test(text)) {
        const ports = await runtime.tool('net.ports', { limit: 25 });
        return { text: `Nasłuchujące porty:\n${ports.data.ports.map((port) => `  ${port.port ?? port.address} ${port.process || ''}`.trim()).join('\n')}`, data: ports.data, toolsUsed: ['net.ports'] };
      }
      const interfaces = await runtime.tool('net.interfaces', {});
      const wifi = await runtime.tool('net.wifi', {});
      return {
        text: `Interfejsy: ${interfaces.data.interfaces.map((iface) => `${iface.name} ${iface.address}`).join(', ')}${wifi.data.ssid ? `\nWi-Fi: ${wifi.data.ssid} (${wifi.data.signal || '?'})` : ''}`,
        data: { interfaces: interfaces.data, wifi: wifi.data },
        toolsUsed: ['net.interfaces', 'net.wifi'],
      };
    },
  },
  {
    name: 'file',
    title: 'Files',
    role: 'llm',
    description: 'Finds, reads, writes and organises files inside the workspace.',
    triggers: ['plik', 'folder', 'katalog', 'file', 'zapisz', 'odczytaj', 'usuń plik', 'znajdź plik', 'directory'],
    modelClass: 'balanced',
    categories: ['files', 'documents'],
    instructions: `You work with files inside the sandbox. Resolve ambiguity by listing first (fs.list / fs.tree) instead of guessing a path.
Read before overwriting. Use fs.delete only with a reason; it moves to trash, which you should mention. Report the absolute path you used.`,
  },
  {
    name: 'document',
    title: 'Documents',
    role: 'llm',
    description: 'PDFs, Word, Excel, CSV, logs: reads and summarises with real extraction.',
    triggers: ['pdf', 'dokument', 'word', 'docx', 'excel', 'xlsx', 'csv', 'umowa', 'faktura', 'podsumuj plik'],
    modelClass: 'balanced',
    categories: ['documents', 'knowledge', 'files'],
    instructions: `You read documents with doc.read / doc.xlsx.rows / doc.csv.stats. Quote exact values (numbers, dates, names) and say which file
and page/sheet they came from. If extraction failed, say why (scanned PDF, unsupported .doc) rather than inventing content.`,
  },
  {
    name: 'memory',
    title: 'Memory',
    role: 'tool',
    description: 'Recalls and stores facts, preferences and lessons.',
    triggers: ['pamiętasz', 'remember', 'zapamiętaj', 'przypomnij', 'kiedy mówiłem', 'memory'],
    modelClass: 'fast',
    categories: ['memory'],
    handler: async (runtime) => {
      const text = runtime.request.text;
      if (/zapamiętaj|zapamietaj|remember/i.test(text)) {
        const fact = findQuery(text, ['zapamiętaj', 'zapamietaj', 'remember']);
        const stored = await runtime.tool('memory.remember', { text: fact, kind: /błąd|blad|error|napraw/i.test(fact) ? 'errors' : 'long_term', importance: 0.7 });
        return {
          text: stored.data.stored ? `Zapamiętane: ${fact}` : `Nie zapisałem tego — ${stored.data.reason}`,
          data: stored.data,
          toolsUsed: ['memory.remember'],
        };
      }
      const query = findQuery(text, ['pamiętasz', 'pamietasz', 'przypomnij', 'remember', 'kiedy mówiłem', 'co wiesz o']);
      const hits = await runtime.tool('memory.recall', { query, limit: 6 });
      return {
        text: hits.data.count ? hits.data.citations.join('\n') : `Nie mam nic zapisanego o "${query}".`,
        data: hits.data,
        toolsUsed: ['memory.recall'],
        citations: hits.data.citations,
      };
    },
  },
  {
    name: 'vision',
    title: 'Vision',
    role: 'llm',
    description: 'Screenshots, photos, charts and error dialogs: reads images with the vision model.',
    triggers: ['zrzut ekranu', 'screenshot', 'zdjęcie', 'image', 'obraz', 'wykres', 'co jest na ekranie', 'ocr'],
    modelClass: 'vision',
    categories: ['system', 'documents', 'files'],
    instructions: `You describe and read images precisely. If the user asks what is on screen, take a screenshot first (screenshot.capture) and then analyse it.
Transcribe visible text exactly, including error codes. Never guess a value you cannot read; say "nieczytelne" instead.`,
  },
  {
    name: 'voice',
    title: 'Voice',
    role: 'llm',
    description: 'Speaks answers, transcribes audio, chooses a voice and handles push-to-talk.',
    triggers: ['powiedz', 'przeczytaj na głos', 'voice', 'głos', 'mikrofon', 'transkrypcja', 'speak'],
    modelClass: 'balanced',
    categories: ['voice'],
    instructions: `You handle speech. For "read this aloud" call voice.speak with the exact text; keep spoken answers short and free of markdown.
For audio files use voice.transcribe. Say clearly when no STT/TTS engine is installed instead of pretending.`,
  },
  {
    name: 'security',
    title: 'Security',
    role: 'llm',
    description: 'Policy, permissions, suspicious content and the audit trail.',
    triggers: ['bezpieczeństwo', 'security', 'uprawnienia', 'permission', 'polityka', 'policy', 'audyt', 'audit', 'podejrzane'],
    modelClass: 'balanced',
    categories: ['security', 'system'],
    instructions: `You explain and apply security policy. Never weaken a control without explicit consent; never print secrets.
When asked what the agent may do, answer from security.status and project.roots, not from memory.`,
  },
  {
    name: 'verification',
    title: 'Verification',
    role: 'llm',
    description: 'Checks the answer against evidence: contradictions, missing data, unsupported claims.',
    triggers: ['sprawdź odpowiedź', 'verify', 'czy to prawda', 'weryfikacja'],
    modelClass: 'balanced',
    categories: ['memory', 'knowledge'],
    instructions: `You audit an answer against the evidence it was given. Report ONLY problems that would change what the user does:
a claim with no supporting tool result, a number that contradicts a tool result, a failure that was glossed over.
Output JSON: {"ok":true|false,"issues":["..."],"confidence":0..1}. Be hard to satisfy but do not invent issues.`,
  },
  {
    name: 'optimization',
    title: 'Optimisation',
    role: 'llm',
    description: 'Speed, memory, VRAM and startup improvements with measured before/after.',
    triggers: ['optymalizacja', 'optimize', 'szybciej', 'wolno działa', 'za dużo ram', 'performance', 'wydajność'],
    modelClass: 'balanced',
    categories: ['system', 'perf', 'dev'],
    instructions: `You optimise with numbers. Measure first (perf.metrics, process.top, memory.status), name the bottleneck, propose one change,
then re-measure if asked. Never claim an improvement you did not measure.`,
  },
  {
    name: 'repair',
    title: 'Repair',
    role: 'llm',
    description: 'Diagnoses a broken component and prepares a fix with rollback.',
    triggers: ['napraw', 'repair', 'fix', 'przywróć', 'uszkodzone', 'nie uruchamia się'],
    modelClass: 'balanced',
    categories: ['healing', 'system', 'files'],
    instructions: `You repair carefully. Diagnose (healing.diagnose), propose the smallest fix (healing.propose), and only apply with approval (healing.apply).
Always state how to roll back, and refuse to touch security settings or the agent's own policy.`,
  },
  {
    name: 'esp32',
    title: 'ESP32',
    role: 'tool',
    description: 'Link status, relay control, sensors and firmware diagnostics.',
    triggers: ['esp32', 'esp', 'przekaźnik', 'relay', 'pin', 'firmware', 'reset pc', 'włącz pc'],
    modelClass: 'fast',
    categories: ['esp32', 'network'],
    handler: async (runtime) => {
      const text = runtime.request.text.toLowerCase();
      if (/włącz|wlacz|power on|uruchom pc/.test(text) && !/wyłącz|off/.test(text)) {
        const result = await runtime.tool('esp.power', { action: 'on', holdMs: 600 });
        return { text: 'Wysłałem impuls POWER (0,6 s) — PC powinien się uruchomić. Status: ' + (result.data.ok === false ? 'nieudane' : 'wysłane'), data: result.data, toolsUsed: ['esp.power'] };
      }
      if (/restart pc|zrestartuj pc|reset pc/.test(text)) {
        const result = await runtime.tool('esp.power', { action: 'cycle', holdMs: 600 });
        return { text: 'Wysłano POWER (0,6 s) — jeśli PC był włączony, to go wyłącza; drugi impuls uruchomi go ponownie.', data: result.data, toolsUsed: ['esp.power'] };
      }
      const [status, diagnostics] = await Promise.all([runtime.tool('esp.status', {}), runtime.tool('esp.diagnostics', {})]);
      if (!status.ok) return { text: `ESP32 nie odpowiada: ${status.message}`, toolsUsed: ['esp.status'] };
      const { data } = status;
      return {
        text: `ESP32: ${data.connected ? 'połączony' : 'offline'}${data.pc ? `, PC ${data.pc}` : ''}${data.tempC != null ? `, ${data.tempC}°C` : ''}${data.fw ? `, firmware ${data.fw}` : ''}.`,
        data: { status: data, diagnostics: diagnostics.data },
        toolsUsed: ['esp.status', 'esp.diagnostics'],
      };
    },
  },
  {
    name: 'mobile',
    title: 'Mobile',
    role: 'tool',
    description: 'Paired phones, tunnel sessions and notifications.',
    triggers: ['telefon', 'phone', 'android', 'aplikacja mobilna', 'powiadom', 'notify'],
    modelClass: 'fast',
    categories: ['mobile', 'network'],
    handler: async (runtime) => {
      const text = runtime.request.text;
      if (/powiadom|notify/i.test(text)) {
        const title = findQuery(text, ['powiadom', 'notify']) || 'SENTINEL';
        const result = await runtime.tool('mobile.notify', { title, body: '', level: 'info' });
        return { text: result.ok ? `Powiadomienie wysłane na ${result.data.delivered} urządzeń.` : `Nie wysłano: ${result.message}`, data: result.data, toolsUsed: ['mobile.notify'] };
      }
      const sessions = await runtime.tool('mobile.sessions', {});
      const pairing = await runtime.tool('mobile.pairing', {});
      return {
        text: sessions.data.count
          ? `Połączone telefony: ${sessions.data.count} (${sessions.data.sessions.map((session) => session.ip).join(', ')}).`
          : `Brak połączonego telefonu. Serwer nasłuchuje na porcie ${pairing.data.port}; adresy: ${pairing.data.addresses.join(', ')}.`,
        data: { sessions: sessions.data, pairing: pairing.data },
        toolsUsed: ['mobile.sessions', 'mobile.pairing'],
      };
    },
  },
  {
    name: 'automation',
    title: 'Automation',
    role: 'llm',
    description: 'Schedules recurring work and runs saved automations.',
    triggers: ['automatyzacja', 'automation', 'codziennie', 'co godzinę', 'harmonogram', 'schedule', 'zawsze gdy'],
    modelClass: 'balanced',
    categories: ['automation', 'tasks'],
    instructions: `You create automations with a trigger (interval or daily time) and a single action command. Confirm the schedule in plain language,
warn if an automation could change machine state unattended, and never create one that disables a protection.`,
  },
  {
    name: 'conversation',
    title: 'Conversation',
    role: 'llm',
    description: 'Ordinary questions, small talk and clarification.',
    triggers: [],
    modelClass: 'balanced',
    categories: ['memory', 'knowledge'],
    instructions: `You are SENTINEL, a local assistant on the user's own PC. Be direct and warm, in the user's language (Polish or English).
Use what you remember only when it is relevant. If a request needs the machine, tools or files, say you will check rather than guessing.`,
  },
  {
    name: 'knowledge',
    title: 'Knowledge',
    role: 'tool',
    description: 'Searches and manages the indexed knowledge base.',
    triggers: ['baza wiedzy', 'knowledge base', 'zaindeksuj', 'indeks', 'index', 'dokumenty w bazie'],
    modelClass: 'fast',
    categories: ['knowledge', 'documents'],
    handler: async (runtime) => {
      const text = runtime.request.text;
      if (/zaindeksuj|indeks|index/i.test(text)) {
        const path = findPath(text);
        if (!path) {
          const stats = await runtime.tool('kb.stats', {});
          return { text: `Podaj ścieżkę do zaindeksowania. W bazie jest ${stats.data.documents} dokumentów w ${stats.data.chunks} fragmentach.`, data: stats.data, toolsUsed: ['kb.stats'] };
        }
        const result = await runtime.tool('kb.index', { path, recursive: true, maxFiles: 300 });
        return { text: result.ok ? `Zaindeksowano ${result.data.indexed} plików (${result.data.documents.reduce((sum, doc) => sum + doc.chunks, 0)} fragmentów).` : `Indeksowanie nie powiodło się: ${result.message}`, data: result.data, toolsUsed: ['kb.index'] };
      }
      const query = findQuery(text, ['szukaj', 'znajdź w bazie', 'search', 'w bazie wiedzy']);
      const hits = await runtime.tool('kb.search', { query, limit: 6 });
      return { text: hits.data.count ? hits.data.citations.join('\n') : 'Nic nie znalazłem w bazie wiedzy.', data: hits.data, toolsUsed: ['kb.search'], citations: hits.data.citations };
    },
  },
  {
    name: 'mathematics',
    title: 'Mathematics',
    role: 'tool',
    description: 'Arithmetic, statistics, conversions and number theory through a real parser.',
    triggers: ['oblicz', 'policz', 'ile', 'calculate', 'procent', 'statystyka', 'średnia', 'median', 'przelicz', 'equation'],
    modelClass: 'fast',
    categories: ['math'],
    handler: async (runtime) => {
      const text = runtime.request.text;
      const root = text.match(/pierwiastek\s+(?:z|ze)\s+(\d+(?:[.,]\d+)?)/i);
      if (root) {
        const expression = `sqrt(${root[1].replace(',', '.')})`;
        const result = await runtime.tool('math.eval', { expression });
        if (result.ok) return { text: `${expression} = ${result.data.formatted}`, data: result.data, toolsUsed: ['math.eval'] };
      }
      const percentOf = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:ze|z|of)\s*(\d+(?:[.,]\d+)?)/i);
      if (percentOf) {
        const percent = await runtime.tool('math.percent', { mode: /zmian|change/i.test(text) ? 'change' : 'of', a: Number(percentOf[1].replace(',', '.')), b: Number(percentOf[2].replace(',', '.')) });
        if (percent.ok) return { text: `${percent.data.explanation} = ${percent.data.result}`, data: percent.data, toolsUsed: ['math.percent'] };
      }
      const expression = findExpression(text);
      if (expression) {
        const result = await runtime.tool('math.eval', { expression });
        if (result.ok) {
          return { text: `${expression} = ${result.data.formatted}`, data: result.data, toolsUsed: ['math.eval'] };
        }
      }
      const numbers = (text.match(/-?\d+(?:[.,]\d+)?/g) || []).map((value) => Number(value.replace(',', '.')));
      if (numbers.length >= 3 && /średnia|mean|median|stat|odchylenie|percentyl/i.test(text)) {
        const stats = await runtime.tool('math.stats', { values: numbers });
        return { text: `n=${stats.data.count}, średnia ${stats.data.mean}, mediana ${stats.data.median}, odchylenie ${stats.data.stdDev}, min ${stats.data.min}, max ${stats.data.max}`, data: stats.data, toolsUsed: ['math.stats'] };
      }
      if (/procent|percent/i.test(text) && numbers.length >= 2) {
        const percent = await runtime.tool('math.percent', { mode: /zmian|change/i.test(text) ? 'change' : 'of', a: numbers[0], b: numbers[1] });
        return { text: `${percent.data.explanation} = ${percent.data.result}${percent.data.mode === 'change' ? '%' : ''}`, data: percent.data, toolsUsed: ['math.percent'] };
      }
      return {
        text: 'Podaj działanie do obliczenia (np. "2+3*4" albo "średnia z 4, 8, 15").',
        data: { expression: null },
        toolsUsed: [],
      };
    },
  },
  {
    name: 'configuration',
    title: 'Configuration',
    role: 'llm',
    description: 'Settings, models, ports and preferences — with consent for risky changes.',
    triggers: ['ustawienia', 'settings', 'konfiguracja', 'config', 'zmień model', 'port', 'preferencje'],
    modelClass: 'balanced',
    categories: ['config', 'security', 'ai'],
    instructions: `You change settings through config.set (never by editing the config file directly). Explain the effect of the change,
ask before anything that weakens security, and confirm the new value by reading it back.`,
  },
  {
    name: 'loganalysis',
    title: 'Log analysis',
    role: 'tool',
    description: 'Finds errors, patterns and the first cause in log files and Windows events.',
    triggers: ['log', 'logi', 'dziennik', 'event log', 'zdarzenia', 'błędy w logach'],
    modelClass: 'fast',
    categories: ['documents', 'system'],
    handler: async (runtime) => {
      const path = findPath(runtime.request.text);
      if (path) {
        const analysis = await runtime.tool('doc.log.analyze', { path });
        return { text: analysis.ok ? analysis.data && `${analysis.data.lines} linii, poziomy: ${Object.entries(analysis.data.levels || {}).map(([level, count]) => `${level}=${count}`).join(' ')}\n${(analysis.data.topErrors || []).slice(0, 5).map((entry) => `×${entry.count} ${entry.message}`).join('\n')}` : analysis.message, data: analysis.data, toolsUsed: ['doc.log.analyze'] };
      }
      const events = await runtime.tool('eventlog.read', { limit: 10, level: 'error' });
      return {
        text: events.ok
          ? `Ostatnie błędy systemowe:\n${events.data.entries.slice(0, 8).map((entry) => `${entry.time || ''} ${entry.source || entry.line} ${entry.id || ''} ${String(entry.message || '').slice(0, 90)}`).join('\n')}`
          : `Nie udało się odczytać dziennika: ${events.message}`,
        data: events.data,
        toolsUsed: ['eventlog.read'],
      };
    },
  },
  {
    name: 'update',
    title: 'Update',
    role: 'llm',
    description: 'Checks versions, prepares an update and keeps a rollback point.',
    triggers: ['aktualizacja', 'update', 'nowa wersja', 'upgrade', 'rollback', 'przywróć wersję'],
    modelClass: 'balanced',
    categories: ['dev', 'healing', 'system'],
    instructions: `You handle updates. Check the installed version and available assets, explain what will change, and never update without consent.
Always create a backup first (healing.backup) and state how to roll back.`,
  },
  {
    name: 'verification_planner',
    title: 'Self-check',
    role: 'llm',
    description: 'Decides whether another attempt is worth it, and what to change.',
    triggers: [],
    modelClass: 'fast',
    categories: ['memory'],
    instructions: `You decide whether a failed attempt should be retried. Output JSON {"retry":true|false,"reason":"...","change":"..."}.
Retry only if a specific different approach is available; never retry the same call twice.`,
  },
];

/* ── agent ─────────────────────────────────────────────────────────────── */

class Agent {
  constructor(spec) {
    this.spec = spec;
    this.name = spec.name;
    this.title = spec.title;
    this.role = spec.role;
    this.description = spec.description;
    this.triggers = spec.triggers || [];
    this.modelClass = spec.modelClass || 'balanced';
    this.categories = spec.categories || [];
  }

  toolsFor(registry) {
    if (!registry) return [];
    const categories = new Set(this.categories);
    return registry.list().filter((tool) => categories.has(tool.category));
  }

  /**
   * Keyword score with word boundaries for short triggers. Without them "ip"
   * matches "javascript" and the network agent answers every coding question.
   */
  score(text) {
    if (!this.triggers.length) return 0;
    const lower = ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}+#._-]+/gu, ' ')} `;
    let score = 0;
    for (const trigger of this.triggers) {
      const needle = trigger.toLowerCase();
      const weight = needle.length > 6 ? 3 : needle.length > 4 ? 2 : 1;
      if (needle.length <= 4) {
        if (new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(lower)) score += weight;
      } else if (lower.includes(needle)) {
        score += weight;
      }
    }
    return score;
  }

  systemPrompt(runtime, callableNames) {
    const parts = [baseSystemPrompt({ identity: 'SENTINEL', mode: runtime.mode, language: runtime.language })];
    if (this.spec.instructions) parts.push(this.spec.instructions);
    const tools = this.toolsFor(runtime.registry).filter((tool) => callableNames.includes(tool.name));
    if (tools.length) {
      parts.push(
        `Tools you may call (use them, do not describe them):\n${tools
          .map((tool) => `- ${tool.name}: ${tool.description}`)
          .join('\n')}\nWhen a tool returns an error, say what failed; do not invent data.`,
      );
    }
    return parts.join('\n\n');
  }

  async run(runtime) {
    if (this.spec.handler) {
      const result = await this.spec.handler(runtime, {});
      return { agent: this.name, title: this.title, ...result };
    }
    return this.runLlm(runtime);
  }

  /**
   * Bounded tool loop: model → tool calls → results → model. The cap is fixed
   * (ai.limits.maxToolCalls, hard ceiling MAX_TOOL_CALLS) so no agent can spin.
   */
  async runLlm(runtime) {
    const tools = this.toolsFor(runtime.registry);
    const callable = new Set(tools.map((tool) => tool.name));
    const budget = Math.min(MAX_TOOL_CALLS, Number(runtime.limits.maxToolCalls) || MAX_TOOL_CALLS);
    const messages = [{ role: 'system', content: this.systemPrompt(runtime, [...callable]) }];
    if (runtime.history && runtime.history.length) {
      messages.push(...runtime.history.slice(-6).map((turn) => ({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.text })));
    }
    const context = runtime.contextBlock ? `\n\n${runtime.contextBlock}` : '';
    messages.push({ role: 'user', content: `${runtime.request.text}${context}` });

    const toolsUsed = [];
    let calls = 0;
    let last = null;
    for (let round = 0; round <= 2; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await runtime.llm.chat({
        messages,
        tools: callable.size ? toToolSchema(tools) : null,
        modelClass: this.modelClass,
        temperature: this.modelClass === 'code' ? 0.15 : 0.35,
        signal: runtime.signal,
        onToken: round === 0 ? runtime.onToken : null,
        images: runtime.request.images || null,
      });
      const calls_ = Array.isArray(last.toolCalls) ? last.toolCalls : [];
      if (!calls_.length) break;
      messages.push({ role: 'assistant', content: last.text || '' });
      for (const call of calls_) {
        if (calls >= budget) break;
        const tool = fromToolName(call.name, tools);
        const name = tool ? tool.name : call.name;
        let args = call.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args || '{}');
          } catch {
            args = {};
          }
        }
        calls += 1;
        toolsUsed.push(name);
        // eslint-disable-next-line no-await-in-loop
        const result = await runtime.tool(name, args || {});
        const body = result.ok ? result.text : `ERROR ${result.code}: ${result.message}`;
        messages.push({
          role: 'user',
          content: `TOOL ${name} ${result.ok ? 'RESULT' : 'FAILED'}:\n${String(body).slice(0, 6000)}\n\nContinue. If this answered the question, answer now without more tools.`,
        });
      }
      if (calls >= budget) break;
    }

    const text = last ? last.text : '';
    return {
      agent: this.name,
      title: this.title,
      text,
      data: null,
      toolsUsed,
      model: last ? last.model : null,
      provider: last ? last.provider : null,
      usage: last ? last.usage : null,
      citations: (text.match(/\[[MK]\d+\]/g) || []).slice(0, 20),
    };
  }
}

class AgentRegistry {
  constructor() {
    this.agents = new Map();
    for (const spec of SPECS) {
      const agent = new Agent(spec);
      this.agents.set(agent.name, agent);
    }
  }

  get(name) {
    return this.agents.get(name) || null;
  }

  list() {
    return [...this.agents.values()].map((agent) => ({
      id: agent.name,
      name: agent.name,
      title: agent.title,
      role: agent.role,
      description: agent.description,
      categories: agent.categories,
      modelClass: agent.modelClass,
      tools: agent.categories,
      triggers: agent.triggers.length,
    }));
  }

  /** Agents worth asking about this text, best first. */
  candidates(text, limit = 3) {
    return [...this.agents.values()]
      .filter((agent) => agent.role !== 'orchestrator')
      .map((agent) => ({ agent, score: agent.score(text) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  stats() {
    const byRole = {};
    for (const agent of this.agents.values()) byRole[agent.role] = (byRole[agent.role] || 0) + 1;
    return { agents: this.agents.size, byRole, names: [...this.agents.keys()] };
  }
}

module.exports = { Agent, AgentRegistry, SPECS, findExpression, findPath, findQuery, isMathQuestion };
