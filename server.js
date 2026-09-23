/* Dr. SKM's Academy API — CMS, student reviews, plans, auth and Razorpay checkout.
   Serves only /api: skms-frontend (CLIENT_URL) and skms-academy-admin (ADMIN_URL) call it cross-origin. */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// this repo's own .env, wherever node is started from; optional — Render injects env vars directly.
// Variables already set (even empty) win over the file.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const { DEFAULTS, planLabel, cleanBuyer, cleanReview, withAppPlans } = require('./content.js');

const env = process.env;
const PROD = env.NODE_ENV === 'production';
const SECTIONS = Object.keys(DEFAULTS);   // hero, cases, plans, testimonials, reviews, faculty, announcement, faqs

// a JSON file on Render's disk is wiped on every deploy, so production must have its Neon database
if (PROD) for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET', 'DATABASE_URL']) {
  if (!env[k]) throw new Error(`Missing required env var ${k}`);
}
// local dev falls back to the demo login; production never gets here without real values (check above)
// trimmed: a stray space in the Render dashboard or .env must not lock the admin out
const ADMIN_EMAIL = (env.ADMIN_EMAIL?.trim() || 'admin@skmsacademy.com').toLowerCase();
const ADMIN_PASSWORD = env.ADMIN_PASSWORD?.trim() || 'AdminPass@2026';
if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set — using the demo admin login (development only).');
// stable across `npm run dev` restarts, so a local sign-in survives file edits
const SESSION_SECRET = env.ADMIN_SESSION_SECRET || crypto.createHash('sha256').update('skm-dev-session:' + ADMIN_PASSWORD).digest('hex');

/* Razorpay — plain REST over fetch, no SDK. Both keys must be present or checkout is simulated. */
const RZP_KEY_ID = env.RAZORPAY_KEY_ID || '';
const RZP_KEY_SECRET = env.RAZORPAY_KEY_SECRET || '';
const RZP_CURRENCY = 'INR';   // every price on the site is in rupees; a plan's number is charged as ₹ (× 100 paise)
const RZP_AUTH = 'Basic ' + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString('base64');
const MOCK_PAY = !RZP_KEY_ID || !RZP_KEY_SECRET;   // no keys -> simulated checkout (never in production)
console.log(MOCK_PAY
  ? '[pay] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — using the simulated checkout'
  : `[pay] Razorpay ready — ${RZP_KEY_ID} (${RZP_CURRENCY})`);

/* ---------------- storage: Postgres when DATABASE_URL is set, else a JSON file ---------------- */

const SERVERLESS = !!(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);

function pgStore(connectionString) {
  const { Pool } = require('pg');
  // pg 8 already treats sslmode=require as verify-full, but warns that pg 9 will weaken it to libpq's "encrypt, don't
  // verify". Ask for verify-full outright: same behaviour as today, no warning, whatever URL Neon's dashboard hands out.
  connectionString = connectionString.replace(/([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/, '$1verify-full');
  const pool = new Pool({
    connectionString,
    // an explicit sslmode in the URL wins (Neon's cert is valid, so sslmode=require verifies it);
    // a URL without one still gets TLS, which Neon demands, just without cert pinning
    ...(/[?&]sslmode=/.test(connectionString) ? {} : { ssl: { rejectUnauthorized: false } }),
    max: SERVERLESS ? 1 : 10,        // one client per invocation — Neon's -pooler host does the real pooling
    idleTimeoutMillis: 10_000,       // a frozen lambda must not sit on an open Neon connection
    allowExitOnIdle: true,
    connectionTimeoutMillis: 10_000, // a suspended Neon branch takes a few seconds to wake
  });
  pool.on('error', err => console.error('[db] idle client error:', err.message));

  // lazy + retryable: a failed CREATE TABLE (cold start racing a suspended branch) is retried on the
  // next request instead of poisoning every query on this instance with one rejected promise
  let ready = null;
  const init = () => ready ??= pool.query(`
    CREATE TABLE IF NOT EXISTS cms (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS enrollments (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    -- one-time upgrade of the old (email PK, data, created_at) table: moved aside, rebuilt in the users-table column order, copied back.
    -- This whole string is one implicit transaction; the lock makes a second instance starting up at the same moment wait, then skip.
    SELECT pg_advisory_xact_lock(hashtext('web_users migration'));
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'web_users' AND column_name = 'created_at') THEN
        ALTER TABLE web_users RENAME CONSTRAINT web_users_pkey TO web_users_old_pkey;
        ALTER TABLE web_users RENAME TO web_users_old;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS web_users (id serial PRIMARY KEY, email text UNIQUE NOT NULL, name text, phone text, data jsonb,
      "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP);
    DO $$ BEGIN
      IF to_regclass('web_users_old') IS NOT NULL THEN
        INSERT INTO web_users (email, name, phone, data, "createdAt")
          SELECT email, nullif(data->>'name', ''), nullif(data->>'phone', ''), data - 'email' - 'name' - 'phone', created_at AT TIME ZONE 'UTC'
          FROM web_users_old ORDER BY created_at;
        DROP TABLE web_users_old;
      END IF;
    END $$;
    ALTER TABLE web_users ADD COLUMN IF NOT EXISTS is_subscribed boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS web_reviews (id text PRIMARY KEY, data jsonb NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    -- Razorpay verification details on the app's own (Prisma-owned) subscriptions table. Additive only: IF EXISTS
    -- skips it on a database without the app tables, IF NOT EXISTS leaves any column the app already defines alone.
    ALTER TABLE IF EXISTS subscriptions
      ADD COLUMN IF NOT EXISTS razorpay_payment_id text,
      ADD COLUMN IF NOT EXISTS razorpay_order_id   text,
      ADD COLUMN IF NOT EXISTS razorpay_signature  text,
      ADD COLUMN IF NOT EXISTS status              text NOT NULL DEFAULT 'pending';`
  ).catch(err => { ready = null; throw err; });
  const q = async (sql, args) => { await init(); return (await pool.query(sql, args)).rows; };
  return {
    getCms: async () => Object.fromEntries((await q('SELECT key, value FROM cms')).map(r => [r.key, r.value])),
    setCms: (key, value) => q('INSERT INTO cms (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [key, JSON.stringify(value)]),
    delCms: key => q('DELETE FROM cms WHERE key = $1', [key]),
    getEnrollment: async id => (await q('SELECT data FROM enrollments WHERE id = $1', [id]))[0]?.data,
    putEnrollment: e => q('INSERT INTO enrollments (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [e.id, JSON.stringify(e)]),
    listEnrollments: async () => (await q('SELECT data FROM enrollments ORDER BY created_at DESC LIMIT 1000')).map(r => r.data),
    listUserEnrollments: async email => (await q('SELECT data FROM enrollments WHERE data->>\'email\' = $1 ORDER BY created_at DESC LIMIT 100', [email])).map(r => r.data),
    // web_users, not users: the mobile app backend owns a `users` table with its own columns in this database
    // email/name/phone are real columns (same shape as `users`); everything else (picture, googleId, …) rides in data
    getUser: async email => {
      const r = (await q('SELECT email, name, phone, data FROM web_users WHERE email = $1', [email]))[0];
      return r && { ...r.data, email: r.email, name: r.name ?? undefined, phone: r.phone ?? undefined };
    },
    putUser: ({ email, name, phone, ...data }) => q(`INSERT INTO web_users (email, name, phone, data) VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, data = EXCLUDED.data`,
      [email, name || null, phone || null, JSON.stringify(data)]),
    // paid at least once. The checkout writes the web_users row before the order, so the UPDATE always has a row to hit.
    markSubscribed: email => q('UPDATE web_users SET is_subscribed = true WHERE email = $1', [email]),
    /* The mobile app's Prisma tables (users, plans, subscriptions) live in this same Neon database,
       so a paid website plan becomes app access with two writes — no call to the app backend.
       Returns the ids, or null when the plan row is gone. */
    grantAppAccess: async ({ email, name, phone, courseId, planId, days, paymentId, orderId, signature }) => {
      await init();
      const c = await pool.connect(), one = async (sql, args) => (await c.query(sql, args)).rows;
      try {
        await c.query('BEGIN');
        // one grant per email at a time: two payments racing on a new email can't create two users (users.email has
        // no unique index), and the user + subscription writes land together or not at all
        await c.query('SELECT pg_advisory_xact_lock(hashtext(lower($1)))', [email]);
        const found = await one('SELECT id FROM users WHERE lower(email) = lower($1) ORDER BY id LIMIT 1', [email]);
        // status 'verified': checkout is only reachable behind a verified Google/OTP login, and every
        // existing app user is 'verified' — the column default 'unverified' would lock the student out
        const userId = found[0]?.id ?? (await one(
          `INSERT INTO users (email, name, phone, status, "updatedAt") VALUES ($1, $2, $3, 'verified', now()) RETURNING id`,
          [email, name || null, phone || null]))[0].id;
        if (found[0]) {   // fill in whatever the app row is still missing, never overwrite it
          await one('UPDATE users SET name = coalesce(name, $2), phone = coalesce(phone, $3), "updatedAt" = now() WHERE id = $1', [userId, name || null, phone || null]);
        }
        // the app's own plan row is the authority on length; `days` is the fallback
        const plan = (await one('SELECT "courseId", "durationDays" FROM plans WHERE id = $1', [planId]))[0];
        if (!plan) { await c.query('ROLLBACK'); return null; }
        // WHERE NOT EXISTS makes this idempotent: /verify and the webhook both fire for one payment
        const args = [userId, plan.courseId ?? courseId, planId, String(plan.durationDays ?? days), paymentId || null, orderId || null, signature || null];
        const sub = await one(`INSERT INTO subscriptions ("userId", "courseId", "planId", "startDate", "endDate", "isActive",
            razorpay_payment_id, razorpay_order_id, razorpay_signature, status)
          SELECT $1, $2, $3, now(), now() + ($4 || ' days')::interval, true, $5, $6, $7, 'success'
          WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE "userId" = $1 AND "planId" = $3 AND "isActive" AND "endDate" > now())
          RETURNING id`, args);
        // the row was already there (webhook first, then /verify): fill in whatever it still lacks — only /verify
        // carries razorpay_signature — without ever rewriting details already recorded for that subscription
        if (!sub[0]) await one(`UPDATE subscriptions SET razorpay_payment_id = coalesce(razorpay_payment_id, $3),
            razorpay_order_id = coalesce(razorpay_order_id, $4), razorpay_signature = coalesce(razorpay_signature, $5), status = 'success'
          WHERE "userId" = $1 AND "planId" = $2 AND "isActive" AND "endDate" > now()`,
          [userId, planId, paymentId || null, orderId || null, signature || null]);
        await c.query('COMMIT');
        return { userId, courseId: plan.courseId ?? courseId, planId, subscriptionId: sub[0]?.id ?? null, at: new Date().toISOString() };
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
    // the app's plan rows (published courses only); the website picks the ones it sells by id
    listAppPlans: () => q(`SELECT p.id, p."courseId", p.title, p.price, p.currency, p."durationDays", p."durationLabel",
        p.features, p.entitlements, p."isActive", p."displayOrder"
      FROM plans p JOIN courses c ON c.id = p."courseId" WHERE c.status = 'published' ORDER BY p."courseId", p."displayOrder", p.id`),
    /* Admin → Save Plans, all-or-nothing: update the website's plans, add new ones, switch removed ones off and store the
       presentation (cms(ids) builds it once new rows have ids) in ONE transaction. Entitlements and currency of
       existing rows are never written; dryRun rolls everything back. */
    syncAppPlans: async ({ upserts, retire, cms, dryRun }) => {
      await init();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const ids = [];
        for (const u of upserts) {
          const v = [u.title, u.price, u.durationDays, u.durationLabel, u.features, u.displayOrder];
          if (u.id) {
            const r = await c.query(`UPDATE plans SET title = $1, price = $2, "durationDays" = $3, "durationLabel" = $4, features = $5,
              "displayOrder" = $6, "isActive" = true, "updatedAt" = now() WHERE id = $7 AND "courseId" = $8 RETURNING id`, [...v, u.id, u.courseId]);
            if (!r.rowCount) throw Object.assign(new Error(`Plan #${u.id} is not in course #${u.courseId}`), { status: 409 });
            ids.push(u.id);
          } else {
            const r = await c.query(`INSERT INTO plans ("courseId", title, price, "durationDays", "durationLabel", features, "displayOrder", currency, "updatedAt")
              VALUES ($7, $1, $2, $3, $4, $5, $6, 'INR', now()) RETURNING id`, [...v, u.courseId]);
            ids.push(r.rows[0].id);
          }
        }
        if (retire.length) await c.query('UPDATE plans SET "isActive" = false, "updatedAt" = now() WHERE id = ANY($1)', [retire]);
        const value = cms(ids);
        await c.query('INSERT INTO cms (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', ['plans', JSON.stringify(value)]);
        await c.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        return { ids, value };
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
    // web_reviews for the same reason: keep clear of any `reviews` table the app backend may own
    delReview: id => q('DELETE FROM web_reviews WHERE id = $1', [id]),
    putReview: r => q('INSERT INTO web_reviews (id, data, status) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $2, status = $3', [r.id, JSON.stringify(r), r.status]),
    listSubmissions: async () => (await q('SELECT data FROM web_reviews ORDER BY created_at DESC LIMIT 500')).map(r => r.data),
  };
}

// ponytail: single-process JSON file; fine for local dev or one Render instance with a disk, use DATABASE_URL beyond that
function fileStore(file) {
  let data, queue = Promise.resolve();
  const load = async () => data ??= JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{"cms":{},"enrollments":{}}'));
  const write = mutate => {
    const p = queue.then(async () => {
      await load();
      mutate(data);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(data, null, 2));
      await fs.rename(file + '.tmp', file);   // atomic: a crash never leaves half a file
    });
    queue = p.catch(() => {});
    return p;
  };
  return {
    getCms: async () => (await load()).cms,
    setCms: (key, value) => write(d => { d.cms[key] = value; }),
    delCms: key => write(d => { delete d.cms[key]; }),
    getEnrollment: async id => (await load()).enrollments[id],
    putEnrollment: e => write(d => { d.enrollments[e.id] = e; }),
    listEnrollments: async () => Object.values((await load()).enrollments).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    listUserEnrollments: async email => Object.values((await load()).enrollments).filter(e => e.email === email).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 100),
    grantAppAccess: async () => null,   // no app tables in the JSON store — the sync is a no-op, and is retried later
    // no plan table in the JSON file (local dev without DATABASE_URL) = no app database: the saved cards stand in
    listAppPlans: async () => { const p = (await load()).appPlans; return p ? structuredClone(p) : null; },
    // same contract as the pg version: everything is computed on a copy and written once, so a failure changes nothing
    syncAppPlans: async ({ upserts, retire, cms, dryRun }) => {
      const plans = structuredClone((await load()).appPlans || []);
      let next = Math.max(0, ...plans.map(p => p.id)) + 1;
      const ids = upserts.map(u => {
        const f = { title: u.title, price: u.price, durationDays: u.durationDays, durationLabel: u.durationLabel, features: u.features, displayOrder: u.displayOrder, isActive: true };
        if (!u.id) return plans.push({ id: next, courseId: u.courseId, currency: 'INR', entitlements: [], ...f }), next++;
        const p = plans.find(x => x.id === u.id && x.courseId === u.courseId);
        if (!p) throw Object.assign(new Error(`Plan #${u.id} is not in course #${u.courseId}`), { status: 409 });
        return Object.assign(p, f).id;
      });
      plans.forEach(p => { if (retire.includes(p.id)) p.isActive = false; });
      const value = cms(ids);
      if (!dryRun) await write(d => { d.appPlans = plans; d.cms.plans = value; });
      return { ids, value };
    },
    getUser: async email => (await load()).users?.[email],
    putUser: u => write(d => { (d.users ??= {})[u.email] = u; }),
    markSubscribed: email => write(d => { if (d.users?.[email]) d.users[email].is_subscribed = true; }),
    putReview: r => write(d => { (d.reviews ??= {})[r.id] = r; }),
    delReview: id => write(d => { delete d.reviews?.[id]; }),
    listSubmissions: async () => Object.values((await load()).reviews || {}).sort((a, b) => String(b.date).localeCompare(String(a.date))),
  };
}

const primary = env.DATABASE_URL ? pgStore(env.DATABASE_URL) : fileStore(env.DATA_FILE || path.join(__dirname, 'data', 'db.json'));
// ponytail: fallback is this instance's own /tmp file — a save made while the DB is down is NOT
// replicated back once it recovers; it keeps the admin UI usable, it is not a durable store.
const backup = fileStore(env.FALLBACK_FILE || path.join(os.tmpdir(), 'skm-fallback.json'));   // FALLBACK_FILE: tests point it at a temp file
let dbDown = null;   // last failure reason, surfaced to the admin UI so a degraded save is visible
const db = Object.fromEntries(Object.keys(primary).map(name => [name, async (...args) => {
  try {
    const out = await primary[name](...args);
    if (dbDown) console.warn('[db] recovered — back on the primary store');
    dbDown = null;
    return out;
  } catch (err) {
    dbDown = err.message;
    console.error(`[db] ${name} failed: ${err.message} — serving from the local fallback store`);
    return backup[name](...args);
  }
}]));

/* ---------------- helpers ---------------- */

const sha = s => crypto.createHash('sha256').update(String(s ?? '')).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// signed, expiring JSON — session tokens (salt '') and OTP challenges (salt 'otp:<code>:') can't stand in for each other
const seal = (data, salt = '') => {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${hmac(SESSION_SECRET, salt + payload)}`;
};
function unseal(str, salt = '') {
  const [payload, sig] = String(str ?? '').split('.');
  if (!payload || !sig || !same(sig, hmac(SESSION_SECRET, salt + payload))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url'));
  return data.exp > Date.now() ? data : null;
}

function issueToken(email, role) {
  const exp = Date.now() + 12 * 3600e3;
  return { token: seal({ email, role, exp }), exp };
}

// the role check is what keeps a student token out of the admin APIs (and vice versa)
const bearer = (req, role) => {
  const t = unseal((req.get('authorization') || '').replace(/^Bearer /, ''));
  return t?.role === role ? t : null;
};

function requireAdmin(req, res, next) {
  if (bearer(req, 'admin')) return next();
  res.status(401).json({ error: 'Not signed in' });
}

/* Plans: the app database's `plans` table is the source of truth for price, title, days, access label and features;
   the CMS `plans` section is the website's presentation plus which plan ids it sells (see withAppPlans in data.js).
   Rows are read through a 5-minute cache that Save Plans drops at once. The primary store is called directly, not
   through the db fallback wrapper: a failed read must mean "keep the last good rows", never "read an empty file". */
const PLAN_TTL = 5 * 60e3;
let planCache = { at: 0, rows: null };
const invalidatePlans = () => { planCache.at = 0; };
async function appPlanRows() {
  if (planCache.rows && Date.now() - planCache.at < PLAN_TTL) return planCache.rows;
  try {
    planCache = { at: Date.now(), rows: await primary.listAppPlans() };
  } catch (err) {
    console.error('[plans] database read failed — serving the last good copy:', err.message);
  }
  return planCache.rows;   // null only if the database has never answered: the saved cards stand in
}

// what the site sells right now — the cards on both pages, the checkout charge and the app ids all come from here
async function sitePlans() {
  const saved = (await db.getCms()).plans;
  return withAppPlans(saved?.length ? saved : DEFAULTS.plans, await appPlanRows());
}

async function findPlan(programId, index, planRef) {
  const group = (await sitePlans()).find(g => g.id === programId), card = group?.cards?.[index];
  if (!card || !(Number(card.price) > 0)) return null;
  // the page sent the plan id it showed: if the list changed since, refuse rather than charge for a different plan
  if (planRef && card.planId !== planRef) return { stale: true };
  const app = card.planId && group.courseId ? { courseId: group.courseId, planId: card.planId, days: card.durationDays } : null;
  return { label: planLabel(group, card), price: Number(card.price), app };
}

/* Paid plan -> access in the mobile app. Runs once per enrollment (the result is kept on it) and never
   fails the request: the money is already taken, so a sync error is logged and left visible to the admin. */
async function syncAppAccess(enrollment) {
  // the website's own flag, set on every successful payment (replays included) even when the plan maps to no app course.
  // Never fails the request, for the same reason as below: the money is already taken.
  if (enrollment.email) await db.markSubscribed(enrollment.email).catch(err => console.error('[is_subscribed] failed for', enrollment.email, err.message));
  const map = enrollment.app;
  if (!map || enrollment.appSync) return enrollment;
  try {
    // enrollment.id IS the Razorpay order id (the order row is stored under it); signature only exists on the /verify path
    const appSync = await db.grantAppAccess({ ...map, email: enrollment.email, name: enrollment.name, phone: enrollment.phone,
      paymentId: enrollment.paymentId, orderId: enrollment.id, signature: enrollment.signature });
    if (appSync) return { ...enrollment, appSync, appSyncError: undefined };
    console.warn('[app-sync] not granted for', enrollment.id, '— no app plan row, or no database');
    return enrollment;
  } catch (err) {
    console.error('[app-sync] failed for', enrollment.id, err.message);
    return { ...enrollment, appSyncError: err.message };
  }
}

/* ---------------- app ---------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Render/Vercel sit behind one proxy; needed for req.ip

/* CORS: only the two front ends may call the API from a browser. CLIENT_URL / ADMIN_URL take a comma-separated
   list (e.g. the Vercel production domain plus a custom one). The Vite dev servers are allowed too — in production
   as well, so local development can run against the live API. Auth is a bearer token in the Authorization header;
   no cookies are set, but credentialed requests are allowed for the listed origins (never for any other). */
const originList = v => String(v || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ORIGINS = new Set([
  ...originList(env.CLIENT_URL),
  ...originList(env.ADMIN_URL),
  'http://localhost:5173',
  'http://localhost:5174',
  'https://skms-frontend.vercel.app',
]);
if (PROD && !env.CLIENT_URL && !env.ADMIN_URL) console.warn('[cors] CLIENT_URL / ADMIN_URL not set — browsers on the deployed front ends will be refused');

// every /api response is JSON
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  res.vary('Origin');
  if (origin && ORIGINS.has(origin)) res.set({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  });
  res.type('application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, storage: dbDown ? 'fallback' : 'ok', error: dbDown || undefined }));

// Public front-end config. The OAuth client ID is a public value by design (it ships in every GIS
// page); the client SECRET is never sent here. Lets every page find it without a per-page meta tag.
app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));
app.get('/api/auth/google/client-id', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));

// Razorpay webhook needs the raw body for its signature, so it's registered before express.json()
// (both paths: /api/payments/webhook is the URL already registered in the Razorpay dashboard)
app.post(['/api/checkout/razorpay/webhook', '/api/payments/webhook'], express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = env.RAZORPAY_WEBHOOK_SECRET, sig = req.get('x-razorpay-signature');
  if (!secret || !sig || !Buffer.isBuffer(req.body) || !same(sig, hmac(secret, req.body))) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  const event = JSON.parse(req.body);
  const payment = event.payload?.payment?.entity;
  const orderId = payment?.order_id || event.payload?.order?.entity?.id;
  const e = orderId && await db.getEnrollment(orderId);
  if (e && ['payment.captured', 'order.paid'].includes(event.event)) {
    await db.putEnrollment(await syncAppAccess({ ...e, status: 'Success', paymentId: payment?.id || e.paymentId }));
  } else if (e && event.event === 'payment.failed' && e.status !== 'Success') {
    await db.putEnrollment({ ...e, status: 'Failed' });
  }
  res.json({ ok: true });
});

app.use(express.json({ limit: '5mb' }));   // hero image is sent as a Base64 data URL (admin resizes it to ~0.2–1 MB)

/* auth */
// ponytail: in-memory per-instance limiter; move to Redis/DB if you run several instances
const attempts = new Map();
const blocked = key => (attempts.get(key)?.until || 0) > Date.now();
function strike(key) {   // 5 strikes → 15-minute lockout
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (++a.n >= 5) Object.assign(a, { n: 0, until: Date.now() + 15 * 60e3 });
  attempts.set(key, a);
}
const TOO_MANY = { error: 'Too many attempts — try again in 15 minutes' };
const FALLBACK_OTP = env.FALLBACK_OTP || '123456';   // used only while RESEND_API_KEY is unset
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
// Read for completeness / a future server-side auth-code exchange. The GIS ID-token flow below is
// public-client only: the browser never sees this and Google does the signature check, so it is unused.
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
if (GOOGLE_CLIENT_ID) console.log(`[auth] Google sign-in ready — ${GOOGLE_CLIENT_ID}${GOOGLE_CLIENT_SECRET ? ' (+ client secret)' : ''}`);
else console.warn('[auth] GOOGLE_CLIENT_ID not set — the "Continue with Google" button stays disabled');

app.post('/api/admin/login', (req, res) => {
  const key = 'admin:' + req.ip;
  if (blocked(key)) return res.status(429).json(TOO_MANY);

  const { email, password } = req.body || {};
  // email: any case, surrounding spaces ignored; password: case-sensitive, but a pasted/autofilled edge space is ignored
  const okEmail = same(String(email ?? '').trim().toLowerCase(), ADMIN_EMAIL);
  const okPass = same(String(password ?? '').trim(), ADMIN_PASSWORD);
  if (!(okEmail && okPass)) {
    strike(key);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  attempts.delete(key);
  res.json({ ...issueToken(ADMIN_EMAIL, 'admin'), user: { email: ADMIN_EMAIL, role: 'admin' } });
});

/* student login: email OTP. The challenge is signed together with the code, so no OTP is stored
   and verification works on whichever serverless instance picks up the request. */
async function sendOtpEmail(email, code) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || "Dr. SKM's Academy <onboarding@resend.dev>", to: [email],
        subject: "Your Dr. SKM's Academy login code",
        text: `Your login code is ${code}. It expires in 10 minutes. If you didn't request it, ignore this email.`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return true;
    console.error('[auth] OTP email failed', r.status, await r.text());
  } catch (err) { console.error('[auth] OTP email failed', err.message); }
  return false;
}

app.post('/api/auth/otp', async (req, res) => {
  const key = 'otp:' + req.ip;
  if (blocked(key)) return res.status(429).json(TOO_MANY);
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

  strike(key);   // every code sent counts toward the lockout, so this can't be used to flood an inbox
  // ponytail: no mail provider -> a fixed, publicly known code logs anyone in as any email address.
  // That is deliberate for the review/testing window. Set RESEND_API_KEY to switch to real random codes.
  const code = env.RESEND_API_KEY ? String(crypto.randomInt(1e6)).padStart(6, '0') : FALLBACK_OTP;
  if (env.RESEND_API_KEY && !(await sendOtpEmail(email, code))) return res.status(502).json({ error: 'Could not send the OTP email — please try again' });
  res.json({
    ok: true,
    message: 'Code sent',
    challenge: seal({ email, exp: Date.now() + 10 * 60e3 }, `otp:${code}:`),
    // devOtp is the older name for the same field — kept so existing callers and the smoke test keep working
    ...(env.RESEND_API_KEY ? {} : { devCode: code, devOtp: code }),
  });
});

// ponytail: a challenge stays usable for its 10 minutes even after a login; store used challenges if replay matters
app.post('/api/auth/verify', async (req, res) => {
  const key = 'verify:' + req.ip;
  if (blocked(key)) return res.status(429).json(TOO_MANY);
  const otp = String(req.body?.otp ?? '').trim();
  const challenge = /^\d{6}$/.test(otp) && unseal(req.body?.challenge, `otp:${otp}:`);
  if (!challenge) {
    strike(key);
    return res.status(401).json({ error: 'Invalid or expired OTP' });
  }
  attempts.delete(key);
  let user = await db.getUser(challenge.email);
  if (!user) await db.putUser(user = { email: challenge.email, created: new Date().toISOString() });
  res.json({ ...issueToken(user.email, 'user'), user: { email: user.email, name: user.name, phone: user.phone } });
});

/* Google sign-in (GIS ID-token flow): the browser gets a signed JWT credential from One Tap / the
   account picker and posts it here. Google's tokeninfo endpoint checks the RS256 signature, the
   expiry and the issuer for us, and hands back the profile claims in the same call. */
const GOOGLE_TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

app.post('/api/auth/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'Google sign-in is not configured — set GOOGLE_CLIENT_ID' });
  const key = 'google:' + req.ip;
  if (blocked(key)) return res.status(429).json(TOO_MANY);

  const credential = String(req.body?.credential ?? '');
  const fail = () => { strike(key); res.status(401).json({ error: 'Google sign-in failed — please try again' }); };
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential)) return fail();   // must look like a JWT

  const r = await fetch(GOOGLE_TOKENINFO + encodeURIComponent(credential), { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const p = r?.ok ? await r.json().catch(() => null) : null;
  // tokeninfo rejects a bad signature or an expired token outright; aud pins the token to THIS site
  // (without it a JWT minted for any other Google app would log a user in here) and iss pins the signer.
  if (!p || p.aud !== GOOGLE_CLIENT_ID || !GOOGLE_ISSUERS.includes(p.iss)
      || String(p.email_verified) !== 'true' || !p.email) return fail();
  attempts.delete(key);

  // upsert into web_users: INSERT … ON CONFLICT (email) DO UPDATE, so a repeat sign-in refreshes the
  // profile instead of duplicating it. A name the student set at checkout is never overwritten.
  const email = String(p.email).toLowerCase();
  const existing = (await db.getUser(email)) || { email, created: new Date().toISOString() };
  const user = { ...existing, name: existing.name || p.name, picture: p.picture, googleId: p.sub };
  await db.putUser(user);

  // Same bearer token the OTP flow issues — the front end stores it and sends it to /api/checkout/razorpay.
  res.json({ ...issueToken(email, 'user'), user: { email, name: user.name, phone: user.phone, picture: user.picture } });
});

/* "Write A Review" submissions from visitors: kept in web_reviews, never published as sent — the admin reads them in
   the Review Inbox and approves (optionally after editing) the good ones into Student Reviews, the list below. */
app.post('/api/reviews', async (req, res) => {
  const key = 'review:' + req.ip;
  if (blocked(key)) return res.status(429).json(TOO_MANY);
  const name = String(req.body?.name ?? '').trim(), body = String(req.body?.body ?? '').trim();
  const rating = Number(req.body?.rating);
  if (!name || name.length > 80 || body.length < 10 || body.length > 2000 || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please add your name, a star rating and a review of at least 10 characters' });
  }
  strike(key);   // 5 reviews per IP, then a 15-minute pause
  await db.putReview({ id: crypto.randomUUID(), name, rating, body, date: new Date().toISOString(), status: 'pending' });
  res.status(201).json({ ok: true });
});

/* Student reviews ("What Our Students Say"): one list the admin edits, stored as the `reviews` CMS section.
   Public read; the admin replaces it whole (PUT — also what the admin panel's Save does, via /api/cms/reviews),
   adds one (POST) or removes one by position (DELETE). Every write is validated by cleanReview. */
// never answers with an empty list: an unseeded or emptied database falls back to the built-in reviews,
// so the home page's "What Our Students Say" section always has cards
const readReviews = async () => {
  const list = (await db.getCms()).reviews;
  return list?.length ? list : DEFAULTS.reviews;
};
async function saveReviews(res, list) {
  const clean = Array.isArray(list) && list.length <= 200 ? list.map(cleanReview) : null;
  if (!clean || clean.includes(null)) return res.status(400).json({ error: 'Each review needs a name, a 1–5 star rating and review text' });
  await db.setCms('reviews', clean);
  res.json({ ok: true, reviews: clean, storage: dbDown ? 'fallback' : 'db', warning: dbDown ? 'Saved locally only — the database is unreachable, so this change may not survive a restart.' : undefined });
}

app.get('/api/reviews', async (req, res) => res.json(await readReviews()));
app.get('/api/admin/review-inbox', requireAdmin, async (req, res) =>
  res.json((await db.listSubmissions()).map(({ id, name, rating, body, date, status }) => ({ id, name, rating, body, date, status }))));
// approve: the body may carry the admin's edits (name, role, rating, body); the submission is kept, marked approved
app.post('/api/admin/review-inbox/:id/approve', requireAdmin, async (req, res) => {
  const sub = (await db.listSubmissions()).find(r => r.id === req.params.id);
  if (!sub) return res.status(404).json({ error: 'Review not found' });
  const review = cleanReview({ name: sub.name, role: '', rating: sub.rating, body: sub.body, ...req.body });
  if (!review) return res.status(400).json({ error: 'Each review needs a name, a 1–5 star rating and review text' });
  await db.putReview({ ...sub, status: 'approved' });
  saveReviews(res, [...await readReviews(), review]);
});
app.delete('/api/admin/review-inbox/:id', requireAdmin, async (req, res) => {
  if (!(await db.listSubmissions()).some(r => r.id === req.params.id)) return res.status(404).json({ error: 'Review not found' });
  await db.delReview(req.params.id);
  res.json({ ok: true });
});
app.get('/api/admin/reviews', requireAdmin, async (req, res) => res.json(await readReviews()));
app.put('/api/admin/reviews', requireAdmin, (req, res) => saveReviews(res, req.body));
app.post('/api/admin/reviews', requireAdmin, async (req, res) => saveReviews(res, [...await readReviews(), req.body]));
app.delete('/api/admin/reviews/:index', requireAdmin, async (req, res) => {
  const list = await readReviews(), i = Number(req.params.index);
  if (!Number.isInteger(i) || !list[i]) return res.status(404).json({ error: 'Review not found' });
  saveReviews(res, list.filter((_, j) => j !== i));
});

/* Every program with its plans, as the website sells them. `source`: "db" = from the database (or its last good copy),
   "saved" = the database has not answered yet, so these are the saved cards. */
app.get('/api/plans/live', async (req, res) => {
  const plans = await sitePlans();
  res.json({ source: planCache.rows ? 'db' : 'saved', plans });
});

// one plan card as the admin edits it -> the database columns the website may write
function cleanPlan(c) {
  const price = Number(c?.price), durationDays = Number(c?.durationDays);
  const durationLabel = String(c?.duration ?? '').trim(), title = String(c?.name ?? '').trim() || durationLabel;
  const features = Array.isArray(c?.features) ? c.features.map(f => String(f).trim()).filter(Boolean) : [];
  const ok = title && title.length <= 100 && durationLabel.length <= 100 && price > 0 && price <= 1e7
    && Number.isInteger(durationDays) && durationDays > 0 && durationDays <= 3650
    && features.length <= 20 && features.every(f => f.length <= 100);
  return ok ? { title, price, durationDays, durationLabel: durationLabel || null, features } : null;
}

/* Admin → Pricing & Plans → Save. The whole program list comes back. Every plan is validated first; then one
   transaction updates the website's plan rows, adds new ones, switches off (isActive=false, never deleted) the
   ones removed from a program, and stores the presentation — a failure anywhere changes nothing. Only plans the
   website already sells can be updated or switched off: app-only plans are never touched. ?dryRun=1 rolls back. */
app.put('/api/admin/plans/bulk-sync', requireAdmin, async (req, res) => {
  const groups = req.body, bad = error => res.status(400).json({ error });
  if (!Array.isArray(groups) || !groups.length || groups.length > 20) return bad('Send the full list of programs');
  const current = await sitePlans();
  const managed = new Set(current.flatMap(g => g.cards.map(c => c.planId)).filter(Boolean));
  const upserts = [];
  for (const g of groups) {
    if (!isObj(g) || !/^[\w-]{1,60}$/.test(g.id) || !Number.isInteger(g.courseId) || !Array.isArray(g.cards) || !g.cards.length || g.cards.length > 12) {
      return bad(`Program "${g?.label || g?.id || '?'}" needs a course and at least one plan`);
    }
    for (const [i, c] of g.cards.entries()) {
      const p = isObj(c) && cleanPlan(c);
      if (!p) return bad(`${g.label}: plan ${i + 1} needs a name or access label, a price above 0 and whole-number days`);
      if (c.planId && !managed.has(c.planId)) return bad(`${g.label}: plan #${c.planId} is not one the website sells`);
      upserts.push({ ...p, id: c.planId || undefined, courseId: g.courseId, displayOrder: i });
    }
  }
  const kept = new Set(upserts.map(u => u.id).filter(Boolean));
  const retire = [...managed].filter(id => !kept.has(id));
  // the presentation, with each card pointing at its row (new rows get their ids from the transaction)
  const cms = ids => { let k = 0; return groups.map(g => ({ ...g, cards: g.cards.map(c => ({ ...c, planId: ids[k++] })) })); };
  try {
    const { value } = await primary.syncAppPlans({ upserts, retire, cms, dryRun: req.query.dryRun === '1' });
    if (req.query.dryRun === '1') return res.json({ ok: true, dryRun: true, retire, plans: withAppPlans(value, null) });
  } catch (err) {
    console.error('[plans] bulk-sync rolled back:', err.message);
    return res.status(err.status || 503).json({ error: err.status ? err.message : 'The database did not accept the change — nothing was saved.' });
  }
  invalidatePlans();
  res.json({ ok: true, retired: retire, plans: await sitePlans() });
});

/* CMS: GET all / GET one / PUT replace / DELETE reset-to-default */
app.get('/api/cms', async (req, res) => res.json(await db.getCms()));

app.use('/api/cms/:section', (req, res, next) =>
  SECTIONS.includes(req.params.section) ? next() : res.status(404).json({ error: `Unknown section. Use one of: ${SECTIONS.join(', ')}` }));

app.get('/api/cms/:section', async (req, res) => {
  const { section } = req.params;
  res.json((await db.getCms())[section] ?? DEFAULTS[section]);
});

// PUT and POST both replace the section (POST for clients that only send POST)
app.route('/api/cms/:section').put(requireAdmin, saveSection).post(requireAdmin, saveSection);
async function saveSection(req, res) {
  const { section } = req.params, v = req.body;
  if (section === 'reviews') return saveReviews(res, v);
  const valid = !Array.isArray(DEFAULTS[section])
    ? isObj(v)
    : Array.isArray(v) && v.length <= 200 && v.every(isObj)
      && (section !== 'plans' || v.every(g => /^[\w-]{1,60}$/.test(g.id) && Array.isArray(g.cards) && g.cards.every(isObj)));
  if (!valid) return res.status(400).json({ error: `Invalid ${section} payload` });
  await db.setCms(section, v);
  res.json({ ok: true, section, storage: dbDown ? 'fallback' : 'db', warning: dbDown ? 'Saved locally only — the database is unreachable, so this change may not survive a restart.' : undefined });
}

app.delete('/api/cms/:section', requireAdmin, async (req, res) => {
  await db.delCms(req.params.section);
  res.json({ ok: true, section: req.params.section, storage: dbDown ? 'fallback' : 'db' });
});

app.get('/api/enrollments', requireAdmin, async (req, res) => res.json(await db.listEnrollments()));

app.get('/api/account', async (req, res) => {
  const user = bearer(req, 'user');
  if (!user) return res.status(401).json({ error: 'Please log in' });
  const profile = await db.getUser(user.email);
  const enrollments = await db.listUserEnrollments(user.email);
  res.json({
    user: { email: user.email, name: profile?.name, phone: profile?.phone, picture: profile?.picture, role: 'user' },
    activePlans: enrollments.filter(e => e.status === 'Success').map(e => ({
      id: e.id, planId: e.planId, plan: e.plan, price: e.price, currency: e.currency, date: e.date, status: e.status, appSync: e.appSync,
    })),
  });
});

app.put('/api/account', async (req, res) => {
  const session = bearer(req, 'user');
  if (!session) return res.status(401).json({ error: 'Please log in' });
  const current = await db.getUser(session.email) || { email: session.email };
  const name = String(req.body?.name ?? current.name ?? '').trim();
  const phone = String(req.body?.phone ?? current.phone ?? '').replace(/[\s()-]/g, '');
  if (!name || name.length > 100 || (phone && !/^\+?\d{7,15}$/.test(phone))) {
    return res.status(400).json({ error: 'Enter a valid name and phone number' });
  }
  const profile = { ...current, email: session.email, name, phone };
  await db.putUser(profile);
  res.json({ user: { email: profile.email, name: profile.name, phone: profile.phone, picture: profile.picture, role: 'user' } });
});

/* payments */
app.post(['/api/checkout/razorpay', '/api/payments/order'], async (req, res) => {
  const user = bearer(req, 'user');
  if (!user) return res.status(401).json({ error: 'Please log in to enroll' });
  if (MOCK_PAY && PROD) return res.status(503).json({ error: 'Payments are not configured yet' });
  const { planId, index, planRef } = req.body || {};
  const buyer = cleanBuyer({ ...req.body, email: user.email });   // enrollment is bound to the verified account, never the form's email
  if (!buyer) return res.status(400).json({ error: 'Please enter a valid name and phone number' });
  const plan = await findPlan(planId, Number(index), Number(planRef) || undefined);
  if (!plan) return res.status(404).json({ error: 'That plan is no longer available' });
  if (plan.stale) return res.status(409).json({ error: 'Plans were just updated — please refresh the page and try again' });
  await db.putUser({ ...(await db.getUser(user.email)), ...buyer });   // prefills the next checkout, on any device

  const currency = RZP_CURRENCY;
  if (MOCK_PAY) {   // test order goes straight into enrollments as Success, no gateway call
    const ref = Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
    const enrollment = await syncAppAccess({ id: 'order_MOCK' + ref, paymentId: 'pay_MOCK' + ref, ...buyer, planId, index: Number(index), app: plan.app, plan: plan.label, price: plan.price, currency, date: new Date().toISOString(), status: 'Success' });
    await db.putEnrollment(enrollment);
    return res.json({ mock: true, enrollment });
  }
  const rp = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: RZP_AUTH,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: Math.round(plan.price * 100), currency, receipt: `skm_${Date.now()}`, notes: { plan: plan.label, email: buyer.email } }),
    signal: AbortSignal.timeout(15000),
  });
  const rzOrder = await rp.json();
  if (!rp.ok) {
    console.error('Razorpay order failed', rzOrder);
    return res.status(502).json({ error: 'Payment gateway error — please try again' });
  }

  // planId/index ride along on the enrollment so the app-access sync can map it after payment
  await db.putEnrollment({ id: rzOrder.id, ...buyer, planId, index: Number(index), app: plan.app, plan: plan.label, price: plan.price, currency, date: new Date().toISOString(), status: 'Pending' });
  res.json({ orderId: rzOrder.id, keyId: RZP_KEY_ID, amount: rzOrder.amount, currency: rzOrder.currency });
});

app.post(['/api/checkout/razorpay/verify', '/api/payments/verify'], async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!RZP_KEY_SECRET || !orderId || !paymentId || !signature
      || !same(signature, hmac(RZP_KEY_SECRET, `${orderId}|${paymentId}`))) {
    return res.status(400).json({ error: 'Payment verification failed' });
  }
  const e = await db.getEnrollment(orderId);
  if (!e) return res.status(404).json({ error: 'Order not found' });
  const enrollment = await syncAppAccess({ ...e, paymentId, signature, status: 'Success' });
  await db.putEnrollment(enrollment);
  res.json({ enrollment });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (!(err.status < 500)) console.error(err);
  res.status(err.status || 500).json({ error: err.status < 500 ? err.message : 'Server error' });
});

module.exports = app;   // test.js imports the app; `npm start` runs it directly
if (require.main === module) {
  const port = env.PORT || 4000;
  app.listen(port, () => console.log(`Dr. SKM's Academy API on http://localhost:${port}`));
  // run the schema setup / web_users migration now rather than on the first request, and say where and how it went.
  // Not fatal: requests keep being served from the fallback store and the next query retries (a suspended Neon branch
  // can miss the first attempt), and /api/health reports storage: "fallback" with the error until it succeeds.
  if (env.DATABASE_URL) {
    const u = new URL(env.DATABASE_URL), where = `${u.hostname.split('.')[0]}${u.pathname}`;
    primary.getCms().then(
      () => console.log(`[db] ${where}: schema ready (web_users: id, email, name, phone, data, createdAt)`),
      err => console.error(`[db] ${where}: schema setup / web_users migration FAILED — ${err.message}`));
  }
}
