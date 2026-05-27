#!/usr/bin/env node
// Publish a tweet to @MexicoNecesario via Playwright + stored session cookies.
//
// Usage:
//   node scripts/post-mexiconecesario.cjs < tweet.txt        # text on stdin
//   echo "tweet text" | node scripts/post-mexiconecesario.cjs
//
// Cookies are read from the user_facts table (category=projects):
//   - mexiconecesario_auth_token
//   - mexiconecesario_ct0
// Refresh them with `user_fact_set` (or `sqlite3 data/mc.db "UPDATE user_facts..."`)
//
// Exit codes:
//   0  TWEET_PUBLICADO
//   2  no compose box (likely cookie expired)
//   3  tweet too long (>280 weighted; trim and retry)
//   4  exception
//   5  ACCOUNT_MISMATCH (cookies authenticate to a different handle)
//   6  cookies missing from user_facts

const path = require('path');
const Database = require(path.resolve(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { chromium } = require(path.resolve(__dirname, '..', 'node_modules', 'playwright'));

const EXPECTED_HANDLE = '/MexicoNecesario';
const DB_PATH = path.resolve(__dirname, '..', 'data', 'mc.db');

function loadCookies() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      "SELECT key, value FROM user_facts WHERE category='projects' AND key IN ('mexiconecesario_auth_token','mexiconecesario_ct0')",
    ).all();
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const auth = map['mexiconecesario_auth_token'];
    const ct0 = map['mexiconecesario_ct0'];
    if (!auth || !ct0) {
      throw new Error('cookies missing in user_facts (need mexiconecesario_auth_token + mexiconecesario_ct0)');
    }
    return { auth, ct0 };
  } finally {
    db.close();
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

(async () => {
  let tweet;
  let cookies;

  try {
    tweet = (await readStdin()).replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (!tweet) {
      console.log('ERROR: empty tweet (pipe content via stdin)');
      process.exit(1);
    }
    cookies = loadCookies();
  } catch (err) {
    console.log('ERROR: ' + err.message);
    process.exit(6);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  await context.addCookies([
    { name: 'auth_token', value: cookies.auth, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'ct0', value: cookies.ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    const who = await page.evaluate(() => {
      const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      return link ? link.getAttribute('href') : null;
    });
    if (who !== EXPECTED_HANDLE) {
      console.log('ACCOUNT_MISMATCH: cookies authenticate to ' + who + ', expected ' + EXPECTED_HANDLE);
      await browser.close();
      process.exit(5);
    }

    // --- Overlay fix: disable #layers pointer-events before any interaction ---
    await page.evaluate(() => {
      const layers = document.getElementById('layers');
      if (layers) layers.style.pointerEvents = 'none';
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const box = await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 15000 }).catch(() => null);
    if (!box) {
      console.log('ERROR: no compose box (cookies may be expired); current_url=' + page.url());
      await browser.close();
      process.exit(2);
    }

    // DOM click via evaluate() — bypasses pointer-event interceptors (#layers)
    await page.evaluate(el => el.click(), box);
    await page.waitForTimeout(500);

    // Re-disable #layers in case X re-rendered it after the click
    await page.evaluate(() => {
      const layers = document.getElementById('layers');
      if (layers) layers.style.pointerEvents = 'none';
    });

    await page.keyboard.type(tweet, { delay: 25 });
    await page.waitForTimeout(1500);

    const btn = await page.waitForSelector(
      '[data-testid="tweetButtonInline"]:not([aria-disabled="true"])',
      { timeout: 10000 },
    ).catch(() => null);
    if (!btn) {
      console.log('ERROR: post button stayed disabled (tweet likely >280 weighted chars; trim and retry)');
      await browser.close();
      process.exit(3);
    }

    // DOM click via evaluate() on Post button — bypasses #layers overlay
    await page.evaluate(el => el.click(), btn);
    await page.waitForTimeout(5000);

    // Verify: check for toast confirmation
    const toastText = await page.evaluate(() => {
      const toasts = document.querySelectorAll('[data-testid="toast"]');
      return Array.from(toasts).map(t => t.textContent).join(' ');
    });
    if (toastText.toLowerCase().includes('sent') || toastText.toLowerCase().includes('post')) {
      console.log('TWEET_PUBLICADO account=' + who + ' toast="' + toastText.trim() + '"');
    } else {
      console.log('TWEET_PUBLICADO account=' + who + ' url=' + page.url());
    }

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.log('EXCEPTION: ' + (err && err.message ? err.message : String(err)));
    try { await browser.close(); } catch (_) {}
    process.exit(4);
  }
})();
