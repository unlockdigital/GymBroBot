'use strict';
// Authored adapter/validation contract. Extracted code lives in extracted/.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const ts = require('typescript');
const manifest = require('./source-manifest.json');
function load(mode, env, Clock) {
  assert(['baseline', 'candidate'].includes(mode));
  const modules = {};
  for (const entry of manifest) {
    const file = mode === 'baseline' ? path.join(root, entry.source) : path.join(__dirname, entry.destination);
    assert(!fs.lstatSync(file).isSymbolicLink());
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), entry.sha256, 'source drift');
    const exports = {};
    const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}});
    vm.runInNewContext(compiled.outputText, {exports, Buffer, Date: Clock, process: Object.freeze({env: Object.freeze({NODE_ENV: 'production'})}), require(name) {
      if (name === 'node:crypto') return {createHmac: crypto.createHmac, timingSafeEqual: crypto.timingSafeEqual};
      if (name === '@/lib/root-env') return {getMergedEnvValue: (key, fallback = '') => env[key] ?? fallback};
      throw new Error('Import denied: ' + name);
    }}, {timeout: 1000});
    modules[path.basename(file, '.ts')] = exports;
  }
  return modules;
}
const validOwner = owner => owner && typeof owner.identitySource === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(owner.identitySource) && typeof owner.externalUserId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(owner.externalUserId);
const sameOwner = (a, b) => a.identitySource === b.identitySource && a.externalUserId === b.externalUserId;
function createBoundary({mode = 'candidate', origin, sessionSecret, gatewayToken, owner, isKnownUser, Clock}) {
  assert(Clock && typeof Clock.now === 'function', 'explicit clock');
  assert(typeof isKnownUser === 'function', 'explicit owner registry');
  const url = new URL(origin);
  assert(url.protocol === 'https:' && url.origin === origin, 'canonical HTTPS origin required');
  assert(validOwner(owner), 'explicit owner');
  const configuredOwner = Object.freeze({...owner});
  assert(typeof sessionSecret === 'string' && sessionSecret.length >= 32, 'session key required');
  assert(typeof gatewayToken === 'string' && gatewayToken.length >= 32 && gatewayToken !== sessionSecret, 'independent gateway key required');
  const modules = load(mode, {GYMBRO_APP_SESSION_SECRET: sessionSecret}, Clock);
  const sessions = modules['app-session'];
  const policy = modules['miniapp-auth-policy'];
  const denied = () => ({ok: false, status: 403});
  function known() { try { return isKnownUser(configuredOwner) === true; } catch { return false; } }
  function requestAllowed(request) {
    try {
      return new URL(request.url).origin === origin && request.headers.get('origin') === origin && ['same-origin', null].includes(request.headers.get('sec-fetch-site'));
    } catch { return false; }
  }
  function inspect(request) {
    if (!requestAllowed(request)) return null;
    const raw = request.headers.get('cookie') || '';
    const matches = raw.split(';').map(s => s.trim()).filter(s => s.split('=')[0] === sessions.APP_SESSION_COOKIE);
    if (matches.length !== 1) return null;
    const token = matches[0].slice(sessions.APP_SESSION_COOKIE.length + 1);
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    try {
      const encoded = token.split('.')[0];
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      const now = Math.floor(Clock.now() / 1000);
      if (!Number.isSafeInteger(now) || !validOwner(payload) || !sameOwner(payload, configuredOwner) || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || payload.issuedAt > now || payload.issuedAt < 0 || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > 3600) return null;
      const verified = sessions.verifyAppSession(request);
      if (!verified || !sameOwner(verified, configuredOwner)) return null;
      return policy.resolveMiniappOwner({authMethod: 'pwa', userId: null, owner: verified}, {env: () => '', isKnownUser: known});
    } catch { return null; }
  }
  return Object.freeze({
    issue(request) {
      if (request.method !== 'POST' || !requestAllowed(request) || !known()) return denied();
      const provided = request.headers.get('x-gymbro-gateway-token') || '';
      const left = Buffer.from(provided), right = Buffer.from(gatewayToken);
      if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return denied();
      const token = sessions.issueAppSession(configuredOwner, 3600);
      return {ok: true, status: 200, cookie: `${sessions.APP_SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`, headers: {'Cache-Control': 'no-store'}};
    },
    authenticate(request) {
      if (request.headers.get('authorization') !== 'PWA') return denied();
      const resolved = inspect(request);
      return resolved ? {ok: true, owner: {...resolved}} : denied();
    },
    verify: request => Boolean(inspect(request)),
    createOwner: denied,
    claimOwner: denied,
    resetOwner: denied,
  });
}
module.exports = {createBoundary, load};
