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

module.exports = { appendReceipt, classifyToast };
