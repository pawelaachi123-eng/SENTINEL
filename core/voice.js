'use strict';

/**
 * Local speech: whisper.cpp for STT, the operating system for TTS.
 *
 * No cloud, no accounts. If whisper.cpp is not installed, `transcribe` says so
 * and tells you exactly what to download — it does not silently send audio
 * anywhere or pretend to have heard something.
 *
 * TTS uses what Windows and Linux already ship (SAPI / espeak-ng), which means
 * Polish works without shipping a 100 MB voice model alongside the agent.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { run, powershell, which, IS_WINDOWS } = require('./tools/helpers');

const WHISPER_BINARIES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];
const MODEL_PATTERNS = [/^ggml-.*\.bin$/i, /^whisper.*\.bin$/i];

class VoiceEngine {
  constructor({ config, log, paths, now = () => Date.now() }) {
    this.config = config;
    this.log = log;
    this.paths = paths;
    this.now = now;
    this.modelsDir = path.join(paths.dataDir(), 'models', 'whisper');
    this.audioDir = path.join(paths.dataDir(), 'audio');
    this.counters = { transcriptions: 0, spoken: 0, failures: 0 };
  }

  async engines() {
    const binaries = {};
    for (const name of WHISPER_BINARIES) {
      // eslint-disable-next-line no-await-in-loop
      binaries[name] = await which(name);
    }
    const whisper = Object.entries(binaries).find(([, found]) => found);
    let tts = null;
    if (IS_WINDOWS) tts = { name: 'windows-sapi', available: true };
    else if (await which('espeak-ng')) tts = { name: 'espeak-ng', available: true };
    else if (await which('espeak')) tts = { name: 'espeak', available: true };
    else if (await which('piper')) tts = { name: 'piper', available: true };
    return { whisper: whisper ? { binary: whisper[0], available: true } : { binary: null, available: false }, tts, binaries };
  }

  listModels() {
    const dirs = [this.modelsDir];
    const configured = this.config.get('ai.voice.modelPath');
    if (configured) dirs.push(path.dirname(configured));
    const models = [];
    for (const dir of dirs) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!MODEL_PATTERNS.some((pattern) => pattern.test(name))) continue;
          if (models.some((model) => model.name === name)) continue;
          models.push({ name, path: path.join(dir, name), bytes: fs.statSync(path.join(dir, name)).size, language: /(?:^|[-_.])(pl|en)[-_.]/i.test(name) ? name.match(/(?:^|[-_.])(pl|en)[-_.]/i)[1].toLowerCase() : 'multi' });
        }
      } catch {
        /* no models directory yet */
      }
    }
    return models;
  }

  pickModel(language = 'auto') {
    const configured = this.config.get('ai.voice.modelPath');
    if (configured && fs.existsSync(configured)) return configured;
    const models = this.listModels();
    if (!models.length) return null;
    const wanted = language === 'pl' ? /(?:^|[-_.])pl(?:[-_.]|$)/i : language === 'en' ? /(?:^|[-_.])en(?:[-_.]|$)/i : null;
    const preferred = (wanted && models.find((model) => wanted.test(model.name))) || models.find((model) => /base|small|medium/i.test(model.name)) || models[0];
    return preferred.path;
  }

  /**
   * Transcribes a WAV/MP3/OGG file with whisper.cpp.
   * @returns {Promise<{text: string, model: string, ms: number, language: string}>}
   */
  async transcribe(file, { language = 'auto', timeoutMs = 180000 } = {}) {
    const engines = await this.engines();
    if (!engines.whisper.available) {
      throw Object.assign(
        new Error('whisper.cpp is not installed. Download a build from github.com/ggml-org/whisper.cpp and put whisper-cli on PATH, then place ggml-base.bin in the models/whisper folder.'),
        { code: 'STT_NOT_INSTALLED' },
      );
    }
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw Object.assign(new Error(`cannot read ${file}`), { code: 'NOT_A_FILE' });
    const model = this.pickModel(language);
    if (!model) {
      throw Object.assign(new Error(`no whisper model found. Put ggml-base.bin in ${this.modelsDir} (or set ai.voice.modelPath).`), { code: 'STT_NO_MODEL' });
    }
    await fsp.mkdir(this.audioDir, { recursive: true });
    const stem = path.join(this.audioDir, `stt-${this.now().toString(36)}`);
    const started = this.now();
    const args = ['-m', model, '-f', file, '-otxt', '-of', stem, '--no-prints'];
    if (language && language !== 'auto') args.push('-l', language);
    const result = await run(engines.whisper.binary, args, { timeout: timeoutMs });
    if (result.code !== 0) {
      this.counters.failures += 1;
      throw Object.assign(new Error(`whisper failed: ${(result.stderr || result.stdout).slice(0, 400)}`), { code: 'STT_FAILED' });
    }
    let text = '';
    try {
      text = (await fsp.readFile(`${stem}.txt`, 'utf8')).trim();
    } catch {
      text = result.stdout.trim();
    }
    this.counters.transcriptions += 1;
    if (this.log) this.log.info('voice', `transcribed ${path.basename(file)} (${text.length} chars)`);
    return { text, model: path.basename(model), language, ms: this.now() - started };
  }

  /** Renders text to a WAV file using the OS voice. Returns the file path. */
  async speak(text, { outPath = null, voice = null, rate = 0 } = {}) {
    const clean = String(text || '').trim();
    if (!clean) throw Object.assign(new Error('nothing to say'), { code: 'BAD_ARGS' });
    if (clean.length > 4000) throw Object.assign(new Error('speech is limited to 4000 characters'), { code: 'TOO_LONG' });
    await fsp.mkdir(this.audioDir, { recursive: true });
    const target = outPath || path.join(this.audioDir, `tts-${this.now().toString(36)}.wav`);
    const started = this.now();
    if (IS_WINDOWS) {
      const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voice ? `$synth.SelectVoice(${JSON.stringify(String(voice))})` : ''}
$synth.Rate = ${Math.max(-10, Math.min(10, Number(rate) || 0))}
$synth.SetOutputToWaveFile(${JSON.stringify(target)})
$synth.Speak([Console]::In.ReadToEnd())
$synth.Dispose()
`;
      await powershell(script, { timeout: 120000, input: clean });
    } else if (await which('espeak-ng')) {
      await run('espeak-ng', ['-w', target, '-s', String(160 + Number(rate) * 10), '-v', voice || 'pl'], { timeout: 60000, input: clean });
    } else if (await which('espeak')) {
      await run('espeak', ['-w', target, '-v', voice || 'pl'], { timeout: 60000, input: clean });
    } else {
      throw Object.assign(new Error('no speech engine found. On Windows SAPI is built in; on Linux install espeak-ng.'), { code: 'TTS_NOT_INSTALLED' });
    }
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat || stat.size < 100) throw Object.assign(new Error('the speech engine produced no audio'), { code: 'TTS_FAILED' });
    this.counters.spoken += 1;
    return { path: target, bytes: stat.size, ms: this.now() - started, voice: voice || 'system default' };
  }

  async listVoices() {
    if (IS_WINDOWS) {
      try {
        const result = await powershell('Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }', { timeout: 20000 });
        return result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    }
    const result = await run('espeak-ng', ['--voices'], { timeout: 8000 }).catch(() => null);
    if (!result || result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length > 4)
      .map((parts) => `${parts[1]} (${parts[0]})`);
  }

  async status() {
    const engines = await this.engines();
    const models = this.listModels();
    return {
      stt: {
        available: engines.whisper.available,
        binary: engines.whisper.binary,
        models: models.map((model) => ({ name: model.name, language: model.language, mb: Math.round(model.bytes / 1024 / 1024) })),
        hint: engines.whisper.available ? null : 'install whisper.cpp + a ggml model for offline transcription',
      },
      tts: { available: Boolean(engines.tts && engines.tts.available), engine: engines.tts ? engines.tts.name : null },
      languages: ['pl', 'en'],
      counters: { ...this.counters },
      offline: true,
    };
  }
}

module.exports = { VoiceEngine };
