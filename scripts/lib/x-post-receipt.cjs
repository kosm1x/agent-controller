// Durable receipt for a published X post: one JSON line per post. The ritual's
// V8.4 gate greps it for the task's id, since stdout from the publisher is not kept.
const fs = require('node:fs');
const path = require('node:path');

function appendReceipt(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');
}

// The toast is the only evidence the publisher sees that X accepted the post. Only an
// explicit "sent" / "se envió" confirms it; anything else (no toast, a daily-limit
// warning that mentions "posts") is unconfirmed.
function classifyToast(toastText) {
  const raw = toastText || '';
  return { confirmed: /\bsent\b|se envi[oó]/i.test(raw), toast: raw.trim() };
}

// Duplicate guard. An "attempt" is written right BEFORE the Post click, so a run that is
// killed (timeout) or unconfirmed still counts: X may have published it. A retry of the
// same text inside the window is blocked instead of posting twice.
const crypto = require('node:crypto');

function textHash(text) {
  const norm = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function findRecentAttempt(file, hash, windowMs, now = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]);
      if (r.hash === hash && now - Date.parse(r.ts) <= windowMs) return r;
    } catch (_) {
      /* skip malformed line */
    }
  }
  return null;
}

// The duplicate-guard override (X_POST_FORCE=1) is operator-shell-only. Inside
// mission-control.service (a task) operatorContextReason returns a reason; a missing or
// malformed gate (no dist/), an unreadable cgroup or any throw also means no override.
function overrideRequested(env) {
  return env.X_POST_FORCE === '1';
}

function overrideAllowed(env, loadGate, readCgroup) {
  if (!overrideRequested(env)) return false;
  try {
    const gate = loadGate();
    if (!gate || typeof gate.operatorContextReason !== 'function') return false;
    return gate.operatorContextReason(readCgroup(), false, { tty: false }) === null;
  } catch (_) {
    return false;
  }
}

module.exports = { appendReceipt, classifyToast, textHash, findRecentAttempt, overrideRequested, overrideAllowed };
