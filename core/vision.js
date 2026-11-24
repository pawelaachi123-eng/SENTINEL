'use strict';

/**
 * Vision: local image understanding and OCR.
 *
 * Two independent paths, both offline:
 *   • a vision language model (qwen3.5-vl or any installed multimodal model)
 *     through the same provider stack as chat — asked to read, not to guess;
 *   • tesseract, when it is installed, for exact text extraction where the
 *     model would paraphrase.
 *
 * Screenshots never leave the machine. There is no camera capture and no
 * background screen reading: an image is analysed only when it is handed here.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { run, which, IS_WINDOWS } = require('./tools/helpers');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

class VisionEngine {
  constructor({ config, log, llm, paths, now = () => Date.now() }) {
    this.config = config;
    this.log = log;
    this.llm = llm;
    this.paths = paths;
    this.now = now;
    this.counters = { analysed: 0, ocr: 0, failures: 0 };
  }

  async ocrAvailable() {
    return which('tesseract');
  }

  /**
   * @returns {Promise<{text: string, engine: string, ms: number}>}
   */
  async ocr(file, { language = 'pol+eng' } = {}) {
    if (!(await this.ocrAvailable())) {
      throw Object.assign(new Error('tesseract is not installed. Install it (choco install tesseract / apt install tesseract-ocr) to read text from images exactly.'), { code: 'OCR_NOT_INSTALLED' });
    }
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw Object.assign(new Error(`cannot read ${file}`), { code: 'NOT_A_FILE' });
    const started = this.now();
    const result = await run('tesseract', [file, 'stdout', '-l', language, '--psm', '6'], { timeout: 120000 });
    if (result.code !== 0) {
      this.counters.failures += 1;
      throw Object.assign(new Error(`tesseract failed: ${result.stderr.slice(0, 400)}`), { code: 'OCR_FAILED' });
    }
    this.counters.ocr += 1;
    return { text: result.stdout.trim(), engine: 'tesseract', language, ms: this.now() - started };
  }

  /** Sends the image to the configured vision model with a strict instruction. */
  async analyse(file, { question = 'What is in this image? Transcribe any visible text exactly.', language = 'auto' } = {}) {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw Object.assign(new Error(`cannot read ${file}`), { code: 'NOT_A_FILE' });
    if (stat.size > 12 * 1024 * 1024) throw Object.assign(new Error('images are limited to 12 MB'), { code: 'TOO_LARGE' });
    if (!this.llm) throw Object.assign(new Error('the AI engine is not running'), { code: 'AI_DISABLED' });
    const buffer = await fsp.readFile(file);
    const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
    const started = this.now();
    const instruction = [
      'You are looking at an image on the user\'s own computer.',
      'Describe only what is visible. Transcribe text, numbers, error messages and chart labels exactly as written.',
      'If something is unreadable, say "unreadable" instead of guessing.',
      language !== 'auto' ? `Answer in ${language === 'pl' ? 'Polish' : 'English'}.` : '',
      `Question: ${question}`,
    ]
      .filter(Boolean)
      .join('\n');
    const result = await this.llm.chat({
      messages: [
        { role: 'system', content: 'You read images. Never invent content that is not visible.' },
        { role: 'user', content: instruction },
      ],
      modelClass: 'vision',
      images: [{ mime, data: buffer.toString('base64'), name: path.basename(file) }],
      maxTokens: 700,
      temperature: 0.1,
    });
    this.counters.analysed += 1;
    return { text: result.text, model: result.model, provider: result.provider, ms: this.now() - started, bytes: stat.size };
  }

  async status() {
    return {
      visionModel: this.config.get('ai.models.vision'),
      ocr: { available: await this.ocrAvailable(), engine: (await this.ocrAvailable()) ? 'tesseract' : null },
      modes: ['screenshot', 'image file', 'chart', 'error dialog'],
      counters: { ...this.counters },
      note: 'images are analysed locally; nothing is uploaded',
    };
  }
}

module.exports = { VisionEngine, MIME };
