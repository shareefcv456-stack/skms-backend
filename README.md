# skms-backend

Dr. SKM's Academy API — CMS content, student reviews, plans (shared with the mobile app's Neon database), student login and Razorpay checkout. Express 5 + `pg`, no other dependencies.

## Run locally

```bash
# create .env with the keys listed in render.yaml (NODE_ENV=development, CLIENT_URL=http://localhost:5173,
# ADMIN_URL=http://localhost:5174); leave DATABASE_URL empty to use ./data/db.json
npm install
npm run dev               # http://localhost:4000
npm test
```

Without Razorpay keys, checkout is simulated. Without `RESEND_API_KEY`, the login code is `FALLBACK_OTP`. Without `ADMIN_EMAIL`/`ADMIN_PASSWORD`, the admin login is `admin@skmsacademy.com` / `AdminPass@2026` (development only).

## Deploy (Render)

New → Blueprint → pick this repo. `render.yaml` creates the web service and prompts for the secrets. Set `CLIENT_URL` and `ADMIN_URL` to the two Vercel domains; without them, browsers can't call the API (CORS). Health check: `GET /api/health`.

Razorpay webhook URL: `https://<service>.onrender.com/api/checkout/razorpay/webhook` (the older `/api/payments/webhook` keeps working).

## Endpoints

| Area | Routes |
|---|---|
| Content | `GET /api/cms`, `GET /api/cms/:section`, `PUT`/`POST`/`DELETE /api/cms/:section` (admin) |
| Reviews | `GET /api/reviews`, `POST /api/reviews` (visitor submission); admin: `GET/PUT/POST /api/admin/reviews`, `DELETE /api/admin/reviews/:index`, `GET /api/admin/review-inbox`, `POST /api/admin/review-inbox/:id/approve`, `DELETE /api/admin/review-inbox/:id` |
| Plans | `GET /api/plans/live`, `PUT /api/admin/plans/bulk-sync` (admin, one transaction, `?dryRun=1`) |
| Checkout | `POST /api/checkout/razorpay` (student), `POST /api/checkout/razorpay/verify`, `POST /api/checkout/razorpay/webhook`; `GET /api/account` (student profile and successful plans); `GET /api/enrollments` (admin) |
| Auth | `POST /api/admin/login`, `POST /api/auth/otp`, `POST /api/auth/verify`, `POST /api/auth/google`, `GET /api/config` |

Admin routes need `Authorization: Bearer <token>` from `/api/admin/login` (12-hour, HMAC-signed).
