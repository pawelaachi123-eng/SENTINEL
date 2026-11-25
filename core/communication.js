'use strict';

/**
 * Provider-independent communications manager.
 *
 * What is real:
 *   • consent tokens bound to one channel, one E.164 destination and an expiry;
 *   • use-once consumption, cost accounting and retry limits;
 *   • a mock adapter used by tests and by default (never a real call);
 *   • a Twilio adapter that performs the documented REST request only when
 *     credentials are explicitly configured — it is never exercised by CI;
 *   • HMAC signature verification and replay protection for status webhooks.
 *
 * What is not claimed: no call is made without a configured account, no
 * provider availability is asserted, and no adapter pretends to have delivered
 * a message when it has not. Unconfigured channels return NOT_CONFIGURED.
 */

const crypto = require('node:crypto');

const EMERGENCY = new Set(['112', '911', '999', '998', '997', '996', '985', '984', '116000', '116111', '116123']);
const E164 = /^\+[1-9]\d{7,14}$/;
const CHANNELS = ['call', 'sms', 'notification', 'email'];

function nowIso(now) {
  return new Date(now()).toISOString();
}

function bearer(sid, token) {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

function normaliseDestination(value) {
  const raw = String(value || '').replace(/[\s()-]/g, '');
  if (!E164.test(raw)) return { ok: false, code: 'BAD_DESTINATION', message: 'destination must be E.164, for example +48123123123' };
  const digits = raw.replace('+', '');
  if (EMERGENCY.has(digits) || EMERGENCY.has(`+${digits}`)) return { ok: false, code: 'EMERGENCY_BLOCKED', message: 'emergency and public-service numbers are never called' };
  if (raw.startsWith('+70') || raw.startsWith('+90') || raw.startsWith('+1900')) return { ok: false, code: 'PREMIUM_BLOCKED', message: 'premium-rate destinations are blocked' };
  return { ok: true, value: raw };
}

class MockAdapter {
  constructor({ now = () => Date.now() } = {}) {
    this.name = 'mock';
    this.now = now;
    this.calls = [];
    this.configured = true;
  }

  status() {
    return { name: 'mock', configured: true, liveCalls: false, note: 'simulation only; no audio, SMS or email leaves the process' };
  }

  async startCall({ to, message, language, id }) {
    const record = { providerId: `mock-call-${id}`, to, status: 'simulated-accepted', language, messageLength: String(message).length, at: nowIso(this.now), delivered: false };
    this.calls.push(record);
    return { ok: true, providerId: record.providerId, status: record.status, simulated: true };
  }

  async sendSms({ to, text, id }) {
    const record = { providerId: `mock-sms-${id}`, to, status: 'simulated-queued', textLength: String(text).length, at: nowIso(this.now), delivered: false };
    this.calls.push(record);
    return { ok: true, providerId: record.providerId, status: record.status, simulated: true };
  }

  async cancel(providerId) {
    return { ok: true, providerId, status: 'simulated-cancelled' };
  }
}

class TwilioAdapter {
  constructor({ accountSid = '', authToken = '', from = '', publicBaseUrl = '', fetchImpl = null, now = () => Date.now() } = {}) {
    this.name = 'twilio';
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.from = from;
    this.publicBaseUrl = publicBaseUrl;
    this.fetch = fetchImpl || globalThis.fetch;
    this.now = now;
  }

  get configured() {
    return Boolean(this.accountSid && this.authToken && this.from && E164.test(this.from) && typeof this.fetch === 'function');
  }

  status() {
    return { name: 'twilio', configured: this.configured, liveCalls: this.configured, note: this.configured ? 'live REST adapter; calls cost money and require account consent' : 'credentials incomplete; NOT_CONFIGURED' };
  }

  async startCall({ to, message, language, id }) {
    if (!this.configured) return { ok: false, code: 'NOT_CONFIGURED', message: 'Twilio credentials are not configured' };
    if (!this.publicBaseUrl) return { ok: false, code: 'NOT_CONFIGURED', message: 'publicBaseUrl is required for signed status callbacks' };
    const twiml = `<Response><Say language="${language === 'pl' ? 'pl-PL' : 'en-US'}">${String(message).replace(/[<>&]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]))}</Say></Response>`;
    const body = new URLSearchParams({ To: to, From: this.from, Twiml: twiml, MachineDetection: 'Enable' });
    const suffix = `/api/communication/twilio?call=${encodeURIComponent(id)}`;
    body.set('StatusCallback', `${this.publicBaseUrl.replace(/\/$/, '')}${suffix}`);
    const response = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Calls.json`, {
      method: 'POST',
      headers: { authorization: bearer(this.accountSid, this.authToken), 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR', message: payload.message || `Twilio HTTP ${response.status}`, retryable: response.status >= 500 || response.status === 429 };
    return { ok: true, providerId: payload.sid || null, status: payload.status || 'queued', simulated: false };
  }

  async sendSms({ to, text, id }) {
    if (!this.configured) return { ok: false, code: 'NOT_CONFIGURED', message: 'Twilio credentials are not configured' };
    const body = new URLSearchParams({ To: to, From: this.from, Body: String(text), StatusCallback: `${this.publicBaseUrl.replace(/\/$/, '')}/api/communication/twilio?sms=${encodeURIComponent(id)}` });
    const response = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: bearer(this.accountSid, this.authToken), 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR', message: payload.message || `Twilio HTTP ${response.status}`, retryable: response.status >= 500 || response.status === 429 };
    return { ok: true, providerId: payload.sid || null, status: payload.status || 'queued', simulated: false };
  }

  async cancel(providerId) {
    if (!this.configured) return { ok: false, code: 'NOT_CONFIGURED', message: 'Twilio credentials are not configured' };
    const response = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(providerId)}.json`, {
      method: 'POST',
      headers: { authorization: bearer(this.accountSid, this.authToken), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Status: 'canceled' }),
    });
    if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR', message: `Twilio HTTP ${response.status}` };
    return { ok: true, providerId, status: 'cancel-requested' };
  }

  /** Twilio signature: base64(HMAC-SHA1(authToken, url + sorted(form fields))). */
  verifyWebhook({ url, params = {}, signature = '' } = {}) {
    if (!this.authToken) return { ok: false, code: 'NOT_CONFIGURED', message: 'no auth token' };
    if (!signature || !url) return { ok: false, code: 'BAD_SIGNATURE', message: 'missing signature or url' };
    const data = Object.keys(params).sort().reduce((accumulator, key) => `${accumulator}${key}${params[key]}`, url);
    const expected = crypto.createHmac('sha1', this.authToken).update(data).digest('base64');
    const left = Buffer.from(expected);
    const right = Buffer.from(String(signature));
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return { ok: false, code: 'BAD_SIGNATURE', message: 'signature mismatch' };
    return { ok: true };
  }
}

class CommunicationManager {
  constructor({ config = null, store = null, log = null, now = () => Date.now(), adapter = null } = {}) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.now = now;
    this.channels = new Set(CHANNELS);
    this.historyLimit = 500;
    this.consents = new Map();
    this.history = [];
    this.spend = { currency: 'USD', totalEstimated: 0 };
    this.replay = new Map();
    const settings = (key, fallback) => config && typeof config.get === 'function' ? config.get(key, fallback) : fallback;
    this.settings = {
      provider: settings('communication.provider', 'mock'),
      enabled: settings('communication.enabled', false),
      maxCallsPerDay: settings('communication.maxCallsPerDay', 5),
      maxSmsPerDay: settings('communication.maxSmsPerDay', 20),
      maxEstimatedCostPerDay: settings('communication.maxEstimatedCostPerDay', 3),
      callCostEstimate: settings('communication.callCostEstimate', 0.05),
      smsCostEstimate: settings('communication.smsCostEstimate', 0.02),
      quietHours: settings('communication.quietHours', null),
      publicBaseUrl: settings('communication.publicBaseUrl', ''),
    };
    this.adapter = adapter || (this.settings.provider === 'twilio'
      ? new TwilioAdapter({
          accountSid: settings('communication.twilio.accountSid', ''),
          authToken: settings('communication.twilio.authToken', ''),
          from: settings('communication.twilio.from', ''),
          publicBaseUrl: this.settings.publicBaseUrl,
          now,
        })
      : new MockAdapter({ now }));
    if (!this.load()) this.persist();
  }

  persist() {
    if (!this.store) return;
    try {
      this.store.put('communication_state', 'history', { history: this.history.slice(-this.historyLimit), spend: this.spend, consents: [...this.consents.values()].slice(-100) });
    } catch (err) {
      if (this.log) this.log.warn('communication', `history save failed: ${err.message}`);
    }
  }

  load() {
    if (!this.store) return false;
    const state = this.store.get('communication_state', 'history');
    if (!state) return false;
    this.history = Array.isArray(state.history) ? state.history.slice(-this.historyLimit) : [];
    this.spend = state.spend || { currency: 'USD', totalEstimated: 0 };
    this.consents = new Map((state.consents || []).map((consent) => [consent.token, consent]));
    return true;
  }

  status() {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const todayHistory = this.history.filter((entry) => entry.at.slice(0, 10) === today);
    return {
      provider: this.adapter.status(),
      enabled: this.settings.enabled,
      channels: [...this.channels],
      limits: { maxCallsPerDay: this.settings.maxCallsPerDay, maxSmsPerDay: this.settings.maxSmsPerDay, maxEstimatedCostPerDay: this.settings.maxEstimatedCostPerDay },
      today: { calls: todayHistory.filter((entry) => entry.channel === 'call').length, messages: todayHistory.filter((entry) => entry.channel !== 'call').length, estimatedCost: Number(todayHistory.reduce((sum, entry) => sum + (entry.estimatedCost || 0), 0).toFixed(3)) },
      history: this.history.length,
      pendingConsents: [...this.consents.values()].filter((consent) => !consent.usedAt && consent.expiresAt > this.now()).length,
      liveCalls: this.adapter.status().liveCalls === true,
      honest: 'mock provider by default; live calls require configured credentials, consent and are disabled in CI',
    };
  }

  /** Creates a one-use consent request; it is not consent until a human grants it. */
  requestConsent({ channel = 'call', destination, reason = '', expiresInMs = 15 * 60 * 1000 } = {}) {
    if (!this.channels.has(channel)) return { ok: false, code: 'BAD_CHANNEL', message: `channel must be one of ${[...this.channels].join(', ')}` };
    const normalised = normaliseDestination(destination);
    if (!normalised.ok) return normalised;
    const token = `consent_${crypto.randomBytes(16).toString('hex')}`;
    const consent = {
      token,
      channel,
      destination: normalised.value,
      reason: String(reason || '').slice(0, 500),
      createdAt: this.now(),
      expiresAt: this.now() + Math.max(60000, Math.min(24 * 3600000, Number(expiresInMs) || 900000)),
      approvedBy: null,
      usedAt: null,
    };
    this.consents.set(token, consent);
    this.persist();
    return { ok: true, consent: { ...consent, token } };
  }

  grantConsent(token, { approvedBy = null } = {}) {
    const consent = this.consents.get(token);
    if (!consent) return { ok: false, code: 'NOT_FOUND', message: 'unknown consent request' };
    if (!approvedBy) return { ok: false, code: 'APPROVAL_REQUIRED', message: 'consent must be granted by an identified person' };
    if (consent.expiresAt <= this.now()) return { ok: false, code: 'EXPIRED', message: 'consent request expired' };
    if (consent.usedAt) return { ok: false, code: 'ALREADY_USED', message: 'consent token already used' };
    consent.approvedBy = String(approvedBy).slice(0, 100);
    consent.approvedAt = this.now();
    this.persist();
    return { ok: true, consent: { ...consent } };
  }

  consume(token, { channel, destination }) {
    const consent = this.consents.get(token);
    if (!consent) return { ok: false, code: 'CONSENT_REQUIRED', message: 'no consent token' };
    if (!consent.approvedBy) return { ok: false, code: 'CONSENT_NOT_GRANTED', message: 'consent was requested but never granted' };
    if (consent.usedAt) return { ok: false, code: 'CONSENT_USED', message: 'consent token was already used' };
    if (consent.expiresAt <= this.now()) return { ok: false, code: 'EXPIRED', message: 'consent expired' };
    if (consent.channel !== channel) return { ok: false, code: 'CONSENT_CHANNEL_MISMATCH', message: `consent is for ${consent.channel}` };
    if (consent.destination !== destination) return { ok: false, code: 'CONSENT_DESTINATION_MISMATCH', message: 'consent is bound to a different destination' };
    consent.usedAt = this.now();
    this.persist();
    return { ok: true, consent };
  }

  dailyLimits(channel) {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const entries = this.history.filter((entry) => entry.at.slice(0, 10) === today);
    if (channel === 'call') return { used: entries.filter((entry) => entry.channel === 'call').length, max: this.settings.maxCallsPerDay, cost: entries.reduce((sum, entry) => sum + (entry.estimatedCost || 0), 0) };
    return { used: entries.filter((entry) => entry.channel !== 'call').length, max: this.settings.maxSmsPerDay, cost: entries.reduce((sum, entry) => sum + (entry.estimatedCost || 0), 0) };
  }

  quietNow() {
    const hours = this.settings.quietHours;
    if (!hours || !Array.isArray(hours) || hours.length !== 2) return false;
    const hour = new Date(this.now()).getHours();
    const [start, end] = hours;
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  async call({ to, message, language = 'pl', consentToken = null, taskId = null, priority = 'normal' } = {}) {
    return this._dispatch({ channel: 'call', to, text: message, language, consentToken, taskId, priority });
  }

  async sendSms({ to, text, consentToken = null, taskId = null } = {}) {
    return this._dispatch({ channel: 'sms', to, text, consentToken, taskId });
  }

  async _dispatch({ channel, to, text: body, language = 'pl', consentToken = null, taskId = null, priority = 'normal' }) {
    if (!this.settings.enabled) return { ok: false, code: 'NOT_CONFIGURED', message: 'communications are disabled in settings' };
    const destination = normaliseDestination(to);
    if (!destination.ok) return destination;
    const message = String(body || '').trim();
    if (!message) return { ok: false, code: 'EMPTY_MESSAGE', message: 'message text is required' };
    if (message.length > (channel === 'call' ? 1200 : 1600)) return { ok: false, code: 'MESSAGE_TOO_LONG', message: 'message exceeds the provider-safe limit' };
    if (this.quietNow()) return { ok: false, code: 'QUIET_HOURS', message: 'quiet hours are active' };
    const limits = this.dailyLimits(channel);
    if (limits.used >= limits.max) return { ok: false, code: 'DAILY_LIMIT', message: `${channel} daily limit reached` };
    const estimate = channel === 'call' ? this.settings.callCostEstimate : this.settings.smsCostEstimate;
    if (limits.cost + estimate > this.settings.maxEstimatedCostPerDay) return { ok: false, code: 'COST_LIMIT', message: 'estimated daily cost limit would be exceeded' };
    const consent = this.consume(consentToken, { channel, destination: destination.value });
    if (!consent.ok) return consent;
    const id = `comm_${crypto.randomBytes(6).toString('hex')}`;
    const disclosure = channel === 'call' && !/jestem ai|jestem sztuczn|this is an ai|ai assistant/i.test(message) ? ' Jestem asystentem AI SENTINEL. ' : '';
    const payload = channel === 'call' ? `${disclosure}${message}`.trim() : message;
    const entry = {
      id, channel, to: destination.value, language, taskId: taskId ? String(taskId).slice(0, 100) : null, priority: String(priority).slice(0, 20),
      status: 'requested', consentToken: consent.consent.token.slice(0, 18) + '…', approvedBy: consent.consent.approvedBy,
      at: nowIso(this.now), updatedAt: nowIso(this.now), estimatedCost: estimate, attempts: 0, providerId: null, error: null, simulated: false,
    };
    this.history.push(entry);
    if (this.history.length > this.historyLimit) this.history.shift();
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      entry.attempts = attempt;
      try {
        const result = channel === 'call'
          ? await this.adapter.startCall({ to: destination.value, message: payload, language, id })
          : await this.adapter.sendSms({ to: destination.value, text: payload, id });
        if (result.ok) {
          entry.status = result.status || 'accepted';
          entry.providerId = result.providerId || null;
          entry.simulated = result.simulated === true;
          entry.updatedAt = nowIso(this.now);
          this.spend.totalEstimated += estimate;
          this.persist();
          return { ok: true, communication: { ...entry }, consent: { token: consent.consent.token, approvedBy: consent.consent.approvedBy }, provider: this.adapter.name, disclosure: channel === 'call' ? payload.startsWith(disclosure.trim()) || disclosure.trim() === '' : null };
        }
        entry.error = { code: result.code, message: result.message };
        if (!result.retryable || attempt === maxAttempts) {
          entry.status = 'failed';
          entry.updatedAt = nowIso(this.now);
          this.persist();
          return { ok: false, code: result.code || 'PROVIDER_ERROR', message: result.message, communication: { ...entry } };
        }
      } catch (err) {
        entry.error = { code: 'PROVIDER_EXCEPTION', message: err.message };
        if (attempt === maxAttempts) {
          entry.status = 'failed';
          entry.updatedAt = nowIso(this.now);
          this.persist();
          return { ok: false, code: 'PROVIDER_EXCEPTION', message: err.message, communication: { ...entry } };
        }
      }
    }
    return { ok: false, code: 'PROVIDER_ERROR', message: 'provider did not accept the request', communication: { ...entry } };
  }

  async cancel(id) {
    const entry = this.history.find((row) => row.id === id);
    if (!entry) return { ok: false, code: 'NOT_FOUND', message: 'no such communication' };
    if (['completed', 'failed', 'cancelled'].includes(entry.status)) return { ok: false, code: 'ALREADY_FINISHED', message: `status is ${entry.status}` };
    const result = await this.adapter.cancel(entry.providerId);
    if (!result.ok) return result;
    entry.status = 'cancelled';
    entry.updatedAt = nowIso(this.now);
    this.persist();
    return { ok: true, communication: { ...entry } };
  }

  /** One-use status webhook processing with provider signature and replay protection. */
  handleWebhook({ headers = {}, params = {}, url = '', signature = '', provider = null } = {}) {
    if (provider && provider !== this.adapter.name) return { ok: false, code: 'PROVIDER_MISMATCH', message: 'webhook provider does not match the configured adapter' };
    if (this.adapter.name === 'twilio') {
      const verified = this.adapter.verifyWebhook({ url, params, signature });
      if (!verified.ok) return verified;
    } else if (this.adapter.name !== 'mock') {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'webhook verification is unavailable' };
    }
    const key = crypto.createHash('sha256').update(JSON.stringify({ url, params })).digest('hex');
    const previous = this.replay.get(key);
    if (previous && this.now() - previous < 10 * 60 * 1000) return { ok: false, code: 'REPLAY', message: 'duplicate webhook' };
    this.replay.set(key, this.now());
    const providerId = params.CallSid || params.MessageSid || params.SmsSid || null;
    const status = params.CallStatus || params.MessageStatus || params.SmsStatus || null;
    if (!providerId || !status) return { ok: false, code: 'BAD_WEBHOOK', message: 'provider id and status are required' };
    const entry = this.history.find((row) => row.providerId === providerId);
    if (!entry) return { ok: false, code: 'NOT_FOUND', message: 'no communication with that provider id' };
    const allowed = ['queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'failed', 'no-answer', 'canceled', 'sent', 'delivered', 'undelivered', 'read'];
    if (!allowed.includes(status)) return { ok: false, code: 'BAD_STATUS', message: `unsupported provider status ${status}` };
    entry.status = status;
    entry.updatedAt = nowIso(this.now);
    entry.delivered = ['completed', 'delivered', 'read'].includes(status);
    this.persist();
    return { ok: true, communication: { ...entry }, verified: this.adapter.name === 'twilio' ? true : 'mock-no-signature' };
  }

  completeMock(id, { status = 'completed' } = {}) {
    if (this.adapter.name !== 'mock') return { ok: false, code: 'MOCK_ONLY', message: 'only the mock adapter can be completed manually' };
    const entry = this.history.find((row) => row.id === id || row.providerId === id);
    if (!entry) return { ok: false, code: 'NOT_FOUND', message: 'no such communication' };
    entry.status = status;
    entry.delivered = status === 'completed' || status === 'delivered';
    entry.updatedAt = nowIso(this.now);
    this.persist();
    return { ok: true, communication: { ...entry }, simulated: true };
  }
}

module.exports = { CommunicationManager, MockAdapter, TwilioAdapter, normaliseDestination, CHANNELS };
