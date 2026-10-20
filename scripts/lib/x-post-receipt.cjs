// Durable receipt for a published X post: one JSON line per post. The ritual's
// V8.4 gate reads the file's mtime, since stdout from the publisher is not kept.
const fs = require('node:fs');
const path = require('node:path');

function appendReceipt(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');
}

module.exports = { appendReceipt };
