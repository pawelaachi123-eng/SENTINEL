'use strict';

/**
 * Voice, vision and repair tools.
 *
 * They live together in one file because they are the three capabilities that
 * talk to hardware or to the outside of the process: microphone, camera/screen
 * and the installation itself.
 */

module.exports = [
  {
    name: 'voice.status',
    title: 'Speech engines',
    description: 'Whether offline STT (whisper.cpp) and TTS are installed, and which models exist.',
    category: 'voice',
    permission: 'read',
    tags: ['voice', 'stt', 'tts'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.voice) return { stt: { available: false }, tts: { available: false }, note: 'the voice engine is not running' };
      return ctx.voice.status();
    },
  },
  {
    name: 'voice.transcribe',
    title: 'Transcribe audio',
    description: 'Speech-to-text with whisper.cpp, fully offline. Supports Polish and English.',
    category: 'voice',
    permission: 'read',
    tags: ['stt', 'transcribe', 'whisper'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'audio file (wav/mp3/ogg)' },
        language: { type: 'string', enum: ['auto', 'pl', 'en'], default: 'auto' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    timeoutMs: 180000,
    async run(args, ctx) {
      if (!ctx.voice) throw Object.assign(new Error('the voice engine is not running'), { code: 'NO_VOICE' });
      return ctx.voice.transcribe(args.path, { language: args.language });
    },
    format: (data) => data.text || '(no speech detected)',
  },
  {
    name: 'voice.speak',
    title: 'Speak text',
    description: 'Renders text to a WAV file with the system voice (Polish or English).',
    category: 'voice',
    permission: 'write',
    tags: ['tts', 'speak', 'voice'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        voice: { type: 'string', maxLength: 120 },
        rate: { type: 'integer', default: 0, minimum: -10, maximum: 10 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args, ctx) {
      if (!ctx.voice) throw Object.assign(new Error('the voice engine is not running'), { code: 'NO_VOICE' });
      return ctx.voice.speak(args.text, { voice: args.voice, rate: args.rate });
    },
  },
  {
    name: 'voice.voices',
    title: 'Installed voices',
    description: 'System voices available for speech synthesis.',
    category: 'voice',
    permission: 'read',
    tags: ['tts', 'voices'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      if (!ctx.voice) return { voices: [] };
      return { voices: await ctx.voice.listVoices() };
    },
  },
  {
    name: 'vision.analyze',
    title: 'Analyse an image',
    description: 'Reads a screenshot, photo, chart or error dialog with the local vision model. Nothing is uploaded.',
    category: 'vision',
    permission: 'read',
    tags: ['vision', 'image', 'screenshot'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'image file path, or "screen" to capture the screen first' },
        question: { type: 'string', maxLength: 500 },
        language: { type: 'string', enum: ['auto', 'pl', 'en'], default: 'auto' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    timeoutMs: 180000,
    async run(args, ctx) {
      if (!ctx.vision) throw Object.assign(new Error('the vision engine is not running'), { code: 'NO_VISION' });
      let target = args.path;
      if (/^screen$/i.test(target) || /^screenshot$/i.test(target)) {
        const shot = await ctx.commander.execute('screen.screenshot', { confirm: true }, { source: 'ai' });
        const dir = ctx.paths.dataDir();
        const fs = require('node:fs');
        const file = require('node:path').join(dir, `shot-${Date.now()}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data.data, 'base64'));
        target = file;
      }
      return ctx.vision.analyse(target, { question: args.question, language: args.language });
    },
    format: (data) => data.text,
  },
  {
    name: 'vision.ocr',
    title: 'OCR an image',
    description: 'Exact text extraction with tesseract (when installed) — better than a model for error messages and tables.',
    category: 'vision',
    permission: 'read',
    tags: ['ocr', 'text', 'tesseract'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        language: { type: 'string', default: 'pol+eng', maxLength: 40 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    pathParams: [{ name: 'path', mode: 'read' }],
    timeoutMs: 120000,
    async run(args, ctx) {
      if (!ctx.vision) throw Object.assign(new Error('the vision engine is not running'), { code: 'NO_VISION' });
      return ctx.vision.ocr(args.path, { language: args.language });
    },
    format: (data) => data.text,
  },
  {
    name: 'vision.status',
    title: 'Vision capabilities',
    description: 'Vision model, OCR availability and how many images have been analysed.',
    category: 'vision',
    permission: 'read',
    tags: ['vision', 'ocr', 'status'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return ctx.vision ? ctx.vision.status() : { ocr: { available: false } };
    },
  },
  {
    name: 'healing.diagnose',
    title: 'Diagnose the installation',
    description: 'Runs the doctor checks: config, database, ports, model server, ESP32, disk space.',
    category: 'healing',
    permission: 'read',
    tags: ['doctor', 'diagnostics', 'repair'],
    parameters: {
      type: 'object',
      properties: { quick: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args, ctx) {
      if (!ctx.healing) throw Object.assign(new Error('self-healing is not wired up'), { code: 'NO_HEALING' });
      return ctx.healing.diagnose({ quick: args.quick });
    },
    format: (data) => `${data.ok ? '✓' : '✗'} ${data.summary}\n${data.checks.map((check) => `${check.ok ? '  ✓' : '  ✗'} ${check.id}: ${check.detail}${check.fix ? ` → ${check.fix}` : ''}`).join('\n')}`,
  },
  {
    name: 'healing.propose',
    title: 'Propose a repair',
    description: 'Prepares a specific fix with its rollback. Nothing is executed until it is approved.',
    category: 'healing',
    permission: 'read',
    tags: ['repair', 'proposal'],
    parameters: {
      type: 'object',
      properties: {
        problem: { type: 'string', minLength: 3, maxLength: 500 },
        fix: { type: 'string', maxLength: 500 },
      },
      required: ['problem'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args, ctx) {
      if (!ctx.healing) throw Object.assign(new Error('self-healing is not wired up'), { code: 'NO_HEALING' });
      return ctx.healing.propose({ problem: args.problem, fix: args.fix });
    },
  },
  {
    name: 'healing.apply',
    title: 'Apply a repair',
    description: 'Applies an approved repair after taking a backup. Needs approval; policy and safety files are never touched.',
    category: 'healing',
    permission: 'system',
    tags: ['repair', 'apply'],
    parameters: {
      type: 'object',
      properties: { proposalId: { type: 'string', minLength: 3, maxLength: 60 } },
      required: ['proposalId'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args, ctx) {
      if (!ctx.healing) throw Object.assign(new Error('self-healing is not wired up'), { code: 'NO_HEALING' });
      return ctx.healing.apply(args.proposalId, { approvedBy: 'user' });
    },
  },
  {
    name: 'healing.backup',
    title: 'Create a backup',
    description: 'Copies the config and database into the backups folder with a manifest.',
    category: 'healing',
    permission: 'write',
    tags: ['backup', 'safety'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60000,
    async run(args, ctx) {
      if (!ctx.healing) throw Object.assign(new Error('self-healing is not wired up'), { code: 'NO_HEALING' });
      return ctx.healing.backup();
    },
  },
  {
    name: 'healing.backups',
    title: 'List backups',
    description: 'Available backups with their dates and file counts.',
    category: 'healing',
    permission: 'read',
    tags: ['backup', 'restore'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return { backups: ctx.healing ? ctx.healing.listBackups() : [] };
    },
  },
  {
    name: 'healing.rollback',
    title: 'Roll back',
    description: 'Restores config and data from the newest backup, keeping the current files as .before-restore copies. Needs approval.',
    category: 'healing',
    permission: 'system',
    tags: ['rollback', 'restore'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 120000,
    async run(args, ctx) {
      if (!ctx.healing) throw Object.assign(new Error('self-healing is not wired up'), { code: 'NO_HEALING' });
      return ctx.healing.rollback();
    },
  },
];
