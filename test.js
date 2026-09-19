// Smoke test for CORS, admin auth, CMS writes, reviews, plans and Razorpay signature checks — `npm test`
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.SKM_DEGRADED) {   // child run: unreachable DB, assert 200 + fallback instead of 500
  process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/none?sslmode=require';
  const app = require('./server');
  const s = app.listen(0, async () => {
    const b = `http://127.0.0.1:${s.address().port}`;
    const { token } = await (await fetch(b + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) })).json();
    for (const p of ['/api/cms', '/api/cms/plans']) assert.equal((await fetch(b + p)).status, 200, `${p} must not 500`);
    const r = await fetch(b + '/api/cms/faqs', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '[]' });
    console.log(r.status, (await r.json()).storage);
    s.close();
  });
  return;
}

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skm-')), 'db.json');
const { DEFAULTS: D } = require('./content.js');
const appPlans = D.plans.flatMap(g => g.cards.filter(c => c.planId).map(c => ({
  id: c.planId, courseId: g.courseId, title: c.name || c.duration, price: c.planId === 14 ? 61 : c.price, currency: 'INR',
  durationDays: c.durationDays, durationLabel: null, features: [], entitlements: ['mock'], isActive: true, displayOrder: 0,
})));
appPlans.push({ id: 6, courseId: 19, title: 'offer plan', price: 1000, currency: 'USD', durationDays: 60, durationLabel: null, features: [], entitlements: [], isActive: true, displayOrder: 0 });
fs.writeFileSync(file, JSON.stringify({ cms: {}, enrollments: { order_T1: { id: 'order_T1', name: 'A', status: 'Pending' } }, appPlans }));
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_FILE: file, DATABASE_URL: '', PLANS_API_URL: '',
  FALLBACK_FILE: path.join(path.dirname(file), 'fallback.json'),   // never the real server's fallback store
  ADMIN_EMAIL: 'admin@test.co', ADMIN_PASSWORD: 'pw', ADMIN_SESSION_SECRET: 's',
  RAZORPAY_KEY_ID: 'rzp_test', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'whsec',
  CLIENT_URL: 'https://skms.example', ADMIN_URL: 'https://admin.skms.example/',
  // a developer's .env must never reach the test: set-but-empty beats the file, so no real OTP emails, no Google
  RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
});

const server = require('./server').listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { body, headers } = {}, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
    return [r.status, await r.json()];
  };
  const json = JSON.stringify;
  try {
    // CORS: the two front ends (a trailing slash in the env is ignored) and the Vite dev servers; nobody else
    const cors = async origin => (await fetch(base + '/api/reviews', { method: 'OPTIONS', headers: { Origin: origin } })).headers.get('access-control-allow-origin');
    assert.equal(await cors('https://skms.example'), 'https://skms.example');
    assert.equal(await cors('https://admin.skms.example'), 'https://admin.skms.example');
    assert.equal(await cors('http://localhost:5173'), 'http://localhost:5173');
    assert.equal(await cors('https://evil.example'), null);

    // auth
    assert.equal((await call('/api/cms/faqs', { body: '[]' }, 'PUT'))[0], 401);
    assert.equal((await call('/api/admin/login', { body: json({ email: 'admin@test.co', password: 'nope' }) }))[0], 401);
    const [, { token, user: admin }] = await call('/api/admin/login', { body: json({ email: ' ADMIN@test.co ', password: 'pw ' }) });
    assert.deepEqual(admin, { email: 'admin@test.co', role: 'admin' }, 'email in any case, edge spaces ignored');
    assert.equal((await call('/api/admin/login', { body: json({ email: 'admin@test.co', password: 'PW' }) }))[0], 401, 'password stays case-sensitive');
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await call('/api/cms/faqs', { body: '[]', headers: { Authorization: `Bearer ${token}x` } }, 'PUT'))[0], 401);

    // cms
    assert.equal((await call('/api/cms/faqs', { body: json([{ q: 'Q', a: 'A' }]), headers: auth }, 'PUT'))[0], 200);
    assert.equal((await call('/api/cms/faqs', { body: json([{ q: 'Q', a: 'A' }]), headers: auth }))[0], 200);   // POST = PUT
    assert.equal((await call('/api/cms/announcement', { body: json({ enabled: true, text: 'Hi' }), headers: auth }))[0], 200);
    assert.deepEqual((await call('/api/cms'))[1].faqs, [{ q: 'Q', a: 'A' }]);
    assert.equal((await call('/api/cms/hero', { body: '[]', headers: auth }, 'PUT'))[0], 400);
    assert.equal((await call('/api/cms/nope', { body: '[]', headers: auth }, 'PUT'))[0], 404);
    assert.equal((await call('/api/cms/faqs', { headers: auth }, 'DELETE'))[0], 200);
    assert.equal((await call('/api/cms/faqs'))[1].length, 6);   // back to defaults
    assert.equal((await call('/api/cms/cases', { body: json({ headline: 'X' }), headers: auth }, 'PUT'))[0], 200);
    assert.equal((await call('/api/cms/cases', { body: '[]', headers: auth }, 'PUT'))[0], 400);
    const program = id => json([{ id, label: 'New', cards: [{ price: 9, duration: '1 day' }] }]);
    assert.equal((await call('/api/cms/plans', { body: program('new-program'), headers: auth }, 'PUT'))[0], 200);
    assert.equal((await call('/api/cms/plans', { body: program('bad id"'), headers: auth }, 'PUT'))[0], 400);
    await call('/api/cms/plans', { headers: auth }, 'DELETE');

    // student reviews: one admin-managed list — public read, admin CRUD, every write validated
    const rev = { name: 'Dr A', role: 'GP - India', rating: 5, body: 'Great course overall' };
    // an unseeded database still publishes the built-in reviews, so the home section is never empty
    assert.deepEqual((await call('/api/reviews'))[1], require('./content.js').DEFAULTS.reviews);
    assert.equal((await call('/api/admin/reviews'))[0], 401);
    assert.equal((await call('/api/admin/reviews', { body: json([rev]) }, 'PUT'))[0], 401);
    assert.equal((await call('/api/admin/reviews', { body: json([{ ...rev, rating: 9 }]), headers: auth }, 'PUT'))[0], 400);
    assert.equal((await call('/api/admin/reviews', { body: json([{ ...rev, body: ' ' }]), headers: auth }, 'PUT'))[0], 400);
    assert.equal((await call('/api/admin/reviews', { body: json([rev]), headers: auth }, 'PUT'))[0], 200);
    assert.equal((await call('/api/admin/reviews', { body: json({ ...rev, name: 'Dr B', role: '' }), headers: auth }))[0], 200);   // POST adds one
    assert.deepEqual((await call('/api/reviews'))[1].map(r => r.name), ['Dr A', 'Dr B']);
    assert.equal((await call('/api/admin/reviews/7', { headers: auth }, 'DELETE'))[0], 404);
    assert.equal((await call('/api/admin/reviews/0', { headers: auth }, 'DELETE'))[0], 200);
    assert.deepEqual((await call('/api/admin/reviews', { headers: auth }))[1], [{ ...rev, name: 'Dr B', role: '' }]);
    // the admin panel's Save goes through the CMS route — same list, same validation
    assert.deepEqual((await call('/api/cms/reviews'))[1].map(r => r.name), ['Dr B']);
    assert.equal((await call('/api/cms/reviews', { body: json([{ name: 'x' }]), headers: auth }, 'PUT'))[0], 400);
    // "Write A Review" submissions are still accepted, but never published
    assert.equal((await call('/api/reviews', { body: json({ name: 'A', rating: 0, body: 'Great course overall' }) }))[0], 400);
    assert.equal((await call('/api/reviews', { body: json({ name: 'Dr C', rating: 5, body: 'Great course overall' }) }))[0], 201);
    assert.deepEqual((await call('/api/reviews'))[1].map(r => r.name), ['Dr B']);
    // …they land in the admin's read-only inbox instead
    assert.equal((await call('/api/admin/review-inbox'))[0], 401);
    const [, inbox] = await call('/api/admin/review-inbox', { headers: auth });
    assert.deepEqual(inbox.map(r => [r.name, r.rating, r.status]), [['Dr C', 5, 'pending']]);
    // approve publishes it (with the admin's edits) and marks it approved; delete removes it
    const approve = (id, body = {}, headers = auth) => call(`/api/admin/review-inbox/${id}/approve`, { body: json(body), headers });
    assert.equal((await approve(inbox[0].id, {}, {}))[0], 401);
    assert.equal((await approve('nope'))[0], 404);
    assert.equal((await approve(inbox[0].id, { rating: 9 }))[0], 400);
    assert.equal((await approve(inbox[0].id, { role: 'GP - Oman' }))[0], 200);
    assert.deepEqual((await call('/api/reviews'))[1].map(r => [r.name, r.role]), [['Dr B', ''], ['Dr C', 'GP - Oman']]);
    assert.equal((await call('/api/admin/review-inbox', { headers: auth }))[1][0].status, 'approved');
    assert.equal((await call(`/api/admin/review-inbox/${inbox[0].id}`, { headers: auth }, 'DELETE'))[0], 200);
    assert.deepEqual((await call('/api/admin/review-inbox', { headers: auth }))[1], []);
    assert.equal((await call(`/api/admin/review-inbox/${inbox[0].id}`, { headers: auth }, 'DELETE'))[0], 404);

    // student OTP login (no mail key outside production → the code comes back as devOtp)
    assert.equal((await call('/api/auth/otp', { body: json({ email: 'bad' }) }))[0], 400);
    const [, otp] = await call('/api/auth/otp', { body: json({ email: 'Doc@Test.co' }) });
    const wrong = String((Number(otp.devOtp) + 1) % 1e6).padStart(6, '0');
    assert.equal((await call('/api/auth/verify', { body: json({ challenge: otp.challenge, otp: wrong }) }))[0], 401);
    const [, login] = await call('/api/auth/verify', { body: json({ challenge: otp.challenge, otp: otp.devOtp }) });
    assert.equal(login.user.email, 'doc@test.co');
    const student = { Authorization: `Bearer ${login.token}` };
    assert.equal((await call('/api/enrollments', { headers: student }))[0], 401);   // a student token is not an admin token
    const order = body => json({ planId: 'gp', index: 0, name: 'A', phone: '9876543210', ...body });
    assert.equal((await call('/api/payments/order', { body: order(), headers: auth }))[0], 401);   // nor the reverse

    // order validation (rejected before Razorpay is called); email comes from the token, not the body
    assert.equal((await call('/api/payments/order', { body: order({ email: 'a@b.co' }) }))[0], 401);
    assert.equal((await call('/api/payments/order', { body: order({ phone: '123' }), headers: student }))[0], 400);
    assert.equal((await call('/api/payments/order', { body: order({ planId: 'zz' }), headers: student }))[0], 404);

    // payment signature
    const verify = sig => call('/api/payments/verify', { body: json({ razorpay_order_id: 'order_T1', razorpay_payment_id: 'pay_1', razorpay_signature: sig }) });
    assert.equal((await verify('bad'))[0], 400);
    const [status, { enrollment }] = await verify(crypto.createHmac('sha256', 'secret').update('order_T1|pay_1').digest('hex'));
    assert.equal(status, 200);
    assert.equal(enrollment.status, 'Success');

    // webhook: bad signature rejected; a late payment.failed never downgrades a success
    const event = json({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_T1' } } } });
    assert.equal((await call('/api/payments/webhook', { body: event, headers: { 'X-Razorpay-Signature': 'bad' } }))[0], 400);
    const sig = crypto.createHmac('sha256', 'whsec').update(event).digest('hex');
    assert.equal((await call('/api/payments/webhook', { body: event, headers: { 'X-Razorpay-Signature': sig } }))[0], 200);
    assert.equal((await call('/api/enrollments', { headers: auth }))[1][0].status, 'Success');

    const { DEFAULTS, withAppPlans } = require('./content.js');
    const gpOf = plans => plans.find(g => g.id === 'gp').cards;

    // /api/plans/live: database values over the presentation; app-only plans (#6) are never shown
    const [planStatus, live] = await call('/api/plans/live');
    assert.equal(planStatus, 200);
    assert.equal(live.source, 'db');
    assert.deepEqual(gpOf(live.plans).map(c => [c.planId, c.price]), [[14, 61], [15, 85], [16, 150]], 'GP prices come from the database rows');
    assert.ok(!live.plans.some(g => g.cards.some(c => c.planId === 6)), 'the app-only Specialist offer plan stays off the website');

    // withAppPlans: legacy copy, switched-off rows, unnamed cards, database down
    const rows = gpOf(DEFAULTS.plans).map(c => ({ id: c.planId, courseId: 22, title: c.name, price: c.price + 1, durationDays: c.durationDays, durationLabel: null, features: [], entitlements: ['mcq', 'mock'], isActive: c.planId !== 16 }));
    const merged = withAppPlans(DEFAULTS.plans, rows);
    assert.deepEqual(gpOf(merged).map(c => [c.name, c.price, c.duration]), [['Plan A', 61, '30 days access'], ['Plan B', 86, '45 days access']], 'switched-off row 16 is dropped');
    assert.deepEqual(gpOf(merged)[0].features, ['MCQ Bank', 'Mock Test'], 'entitlement keys read as feature labels');
    assert.deepEqual(withAppPlans(DEFAULTS.plans, null), DEFAULTS.plans.map(g => ({ ...g })), 'database never reached: the saved cards stand in');
    const legacy = DEFAULTS.plans.map(g => g.id === 'gp' ? { ...g, cards: [{ name: 'Plans A', price: 75 }, { name: 'Plans D', price: 280 }] } : g);
    assert.deepEqual(gpOf(withAppPlans(legacy, null)).map(c => c.price), [60, 85, 150], 'a legacy CMS copy (no planIds) never sells — the defaults stand in');

    // bulk-sync: admin only, validated up front, all-or-nothing, instant on the site, entitlements untouched
    const sync = (groups, headers = auth, q = '') => call('/api/admin/plans/bulk-sync' + q, { body: json(groups), headers }, 'PUT');
    const edit = fn => { const g = structuredClone(live.plans); fn(g); return g; };
    assert.equal((await sync(live.plans, {}))[0], 401);
    assert.equal((await sync(edit(g => { gpOf(g)[1].price = 0; })))[0], 400, 'a zero price is refused');
    assert.equal((await sync(edit(g => { gpOf(g)[1].durationDays = 4.5; })))[0], 400, 'days must be whole');
    assert.equal((await sync(edit(g => { gpOf(g)[0].planId = 6; })))[0], 400, 'an app-only plan cannot be claimed');
    // a plan moved to the wrong course fails inside the transaction: the valid price change before it must not stick
    const [st409] = await sync(edit(g => { gpOf(g)[0].price = 999; g.find(x => x.id === 'specialist').courseId = 21; }));
    assert.equal(st409, 409);
    assert.deepEqual(gpOf((await call('/api/plans/live'))[1].plans).map(c => c.price), [61, 85, 150], 'rolled back: nothing changed');
    // dry run: reports, changes nothing
    const [, dry] = await sync(edit(g => { gpOf(g)[1].price = 95; }), auth, '?dryRun=1');
    assert.equal(dry.dryRun, true);
    assert.equal(gpOf((await call('/api/plans/live'))[1].plans)[1].price, 85, 'dry run left the database alone');
    // the real save: new price, Plan C removed, a new plan added
    const [okStatus, saved] = await sync(edit(g => {
      gpOf(g)[1].price = 95;
      gpOf(g).splice(2, 1);
      gpOf(g).push({ name: 'Plan D', price: 250, durationDays: 90, duration: '3 months access', tone: 'grey', features: ['Everything'] });
    }));
    assert.equal(okStatus, 200);
    assert.deepEqual(saved.retired, [16], 'Plan C is switched off, not deleted');
    const after = gpOf((await call('/api/plans/live'))[1].plans);   // no wait: the cache was dropped on save
    assert.deepEqual(after.map(c => [c.name, c.price]), [['Plan A', 61], ['Plan B', 95], ['Plan D', 250]]);
    assert.ok(after[2].planId > 16, 'the new plan got a database id');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(store.appPlans.find(p => p.id === 16).isActive, false);
    assert.deepEqual(store.appPlans.find(p => p.id === 14).entitlements, ['mock'], 'entitlements are never written');
    assert.equal(store.appPlans.find(p => p.id === 6).isActive, true, 'app-only plans are never switched off');
    assert.ok(store.cms.plans.find(g => g.id === 'gp').cards.every(c => c.planId), 'the presentation is saved with every plan id');

    // checkout charges the database price, in INR, and refuses a plan the page no longer matches
    const realFetch = globalThis.fetch;
    let rzpOrder = null;
    globalThis.fetch = (url, opts) => String(url).startsWith('https://api.razorpay.com/') ? (rzpOrder = JSON.parse(opts.body),
      Promise.resolve(new Response(json({ id: 'order_DB1', amount: rzpOrder.amount, currency: rzpOrder.currency }), { status: 200 }))) : realFetch(url, opts);
    try {
      const buy = body => call('/api/payments/order', { body: json({ planId: 'gp', name: 'A', phone: '9876543210', ...body }), headers: student });
      assert.equal((await buy({ index: 1, planRef: 15 }))[0], 200);
      assert.equal((await call('/api/checkout/razorpay', { body: json({ planId: 'gp', index: 1, planRef: 15, name: 'A' }), headers: student }))[0], 200, 'the checkout alias creates the same order');
      assert.deepEqual([rzpOrder.amount, rzpOrder.currency], [9500, 'INR'], 'charged ₹95 (the saved database price) in paise, in INR');
      assert.equal((await buy({ index: 1, planRef: 14 }))[0], 409, 'the page showed a different plan: refuse, never charge the wrong one');
    } finally {
      globalThis.fetch = realFetch;
    }

    // every built-in card knows its app course (and, once in the database, its plan id and subscription length)
    for (const g of DEFAULTS.plans) {
      assert.ok(Number.isInteger(g.courseId), `${g.id} has no app course`);
      for (const c of g.cards) assert.ok(Number.isInteger(c.durationDays) && c.durationDays > 0, `${g.id} card without durationDays`);
    }

    // a dead database degrades to the fallback store — it must never 500 the admin UI
    const degraded = require('node:child_process').execFileSync(process.execPath, [__filename], {
      env: { ...process.env, SKM_DEGRADED: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.match(degraded, /^200 fallback$/m, `degraded run returned: ${degraded}`);

    console.log('ok — all checks passed');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
