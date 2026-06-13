# PIM/DAM API — Beverage Catalog

Dynamic product model on PostgreSQL + Node/TypeScript.

## Setup
```bash
createdb pim
psql pim -f ../schema.sql        # schema + seed attribute sets
cp .env.example .env
npm install
npm run dev
```

## Core ideas
- **Product types = attribute sets.** Beer, Wine, Soft Drink each declare
  which attributes apply, which are required, and how they're grouped.
- **Values live in `products.attributes` (JSONB)**, validated server-side
  against the attribute definitions (type, min/max, allowed options).
  Required fields are only enforced on publish, so drafts stay flexible.
- **DAM**: content-addressed file storage (sha256 dedupe), assets linked
  to products with roles (hero, packshot, label, document).

## API quick reference
```
GET    /meta/types                     types + their attribute schemas
POST   /meta/attributes                define a new attribute
POST   /meta/types/:id/attributes      attach attribute to a type
GET    /products?type=beer&attr.beer_style=IPA&q=hazy
GET    /products/:id                   includes variants, assets, attribute_schema
POST   /products                       validates attributes against type
PATCH  /products/:id                   merge-update + audit trail
POST   /assets (multipart: file)       upload, dedupe by checksum
POST   /assets/:id/link                {product_id, role}
```

## Extending
Add a new product type (e.g. kombucha) entirely through the API —
no migration needed: POST /meta/types, then attach existing or new
attributes. The product editor UI can render forms directly from
`attribute_schema` returned by GET /products/:id.

## Feature endpoints (v2)
```
GET    /dashboard/completeness            per-product %, rollup by type
GET    /dashboard/compliance?markets=DE,SE
GET    /io/export.csv?type=beer           one column per attribute
POST   /io/import.csv?type=beer           upsert by SKU, per-row report
GET    /channels/shopify/feed             also /amazon/feed, /gs1/feed
GET    /features/products/:id/compliance  EU label rules, caffeine, GTIN…
POST   /features/products/:id/reviews     {body, decision: approve|request_changes}
POST   /features/products/:id/window      {publish_from, publish_until} auto-archive
POST   /features/variants/:id/gtin        check-digit + uniqueness validation
PATCH  /features/products/:id/i18n        {locale, name, description, legal_text}
POST   /features/products/:id/enrich      Claude-generated copy (needs ANTHROPIC_API_KEY)
POST   /features/share                    distributor portal link → GET /portal/:token
POST   /features/webhooks                 HMAC-signed product.* events
```
Run `migration-002-features.sql` after `schema.sql`.
Image uploads now auto-generate thumb (200px) and web (1200px) WebP renditions.
Note: compliance rules are illustrative defaults — verify against current
regulations per target market before relying on them.

## Users, roles & permissions (v3)
Run `migration-003-users.sql`, then bootstrap the first admin:
```bash
npm run create-admin -- admin@acme.com "Ada Admin" "a-strong-password"
```
Login with `POST /auth/login {email, password}` → returns a signed token.
Send it as `Authorization: Bearer <token>` on every request.

System roles → permissions:
```
admin            everything
catalog_manager  product.view/edit/publish, review.approve, import.run, settings.manage, model.manage
editor           product.view, product.edit
reviewer         product.view, review.approve
viewer           product.view
```
Custom roles: `POST /users/roles {code, name, permissions[]}`.
User admin (needs user.manage): `GET/POST/PATCH /users`.

Enforcement is layered: route groups are gated in `index.ts`
(e.g. /io needs import.run), and sensitive transitions are checked
in-route (publishing needs product.publish even via PATCH /products;
review decisions need review.approve). Safety rails prevent admins
from deactivating themselves or removing their own user-management role.
Set AUTH_SECRET in production; tokens are HMAC-SHA256 signed, 12h TTL;
passwords are scrypt-hashed.

## Hardening (v4)
**Fixed**: asset file serving (`GET /assets/file/:key`, immutable cache,
path-traversal protected); orphaned files removed on asset delete;
CSV import rows and user creation are transactional; optimistic locking
on products (echo `version` on PATCH, 409 on conflict).

**Auth**: 1h access tokens + 30-day rotating refresh tokens
(`POST /auth/refresh`; rotation makes stolen tokens single-use).
`POST /auth/logout` and `/auth/logout-all` revoke sessions; deactivating
a user or changing their password revokes all their sessions. Login is
rate-limited (5 fails / 15 min per IP+email). The server refuses to boot
in production without a 32+ char AUTH_SECRET. Helmet + CORS configured
via CORS_ORIGIN.

**Operations**: versioned migrations (`npm run migrate`, node-pg-migrate,
files in migrations/); `docker compose up` brings up Postgres + API with
migrations applied; webhooks retry 3x with backoff and log every attempt;
list endpoints return `{items, total, limit, offset}`; English-stemmed
full-text search.

**Quality**: unit tests (`npm test`) for the validation engine, GTIN
check digits, compliance rules, and auth primitives. `openapi.yaml`
documents the full API. `src/client/apiClient.ts` is a typed frontend
SDK with automatic token refresh and ConflictError handling for
optimistic locking.

## Pimcore-parity features (v5)
Run `migration-005-pimcore-parity.sql` (or `npm run migrate`).

**Versioning**: every save snapshots the pre-edit state.
`GET /objects/products/:id/versions`, restore with
`POST .../versions/:v/restore` (current state is snapshotted first;
restored products re-enter the workflow as drafts).

**Configurable workflows**: status transitions are validated against a
workflow definition (states + transitions, each with a required
permission and optional completeness gate). The default lives in the
`workflows` table; add per-type workflows by inserting a row with a
`product_type_id`. Invalid transitions return 422 listing the allowed
targets; missing permissions return 403.

**Hierarchy & inheritance**: products can have a `parent_id`
(`POST /objects/products/:id/parent`, cycle-safe). Children inherit
attribute values from ancestors; `GET /products/:id` returns
`effective_attributes` plus an `inherited_from` map showing which
ancestor supplied each value.

**Calculated attributes**: attributes may carry a `formula`
(e.g. `round(sugar_g_100ml * volume_ml / 100, 1)`), evaluated by a safe
arithmetic parser (no eval — formulas cannot execute code; missing
inputs or division by zero yield no value). Clients can't write
calculated codes; they're computed into `effective_attributes`.

**Relations**: typed product links (related, cross_sell, up_sell,
accessory, replacement) via `/objects/products/:id/relations`,
returned in both directions.

**Category tree**: full CRUD + nested tree at `/objects/categories`,
with product assignment.

**Locale fallbacks**: `GET /objects/products/:id/localized?locale=de-AT`
resolves de-AT → de → base per field and reports the source level.
Chains are configured in the `locales` table.

**Workspaces (object-level permissions)**: scope users to brands and/or
category subtrees with `POST /users/:id/scopes`. Scoped users only see
matching products in lists, can't edit or create outside their
workspace. No scopes = unrestricted (RBAC still applies).

**DAM**: assets live in folders (`?folder=/labels/` filters subtrees),
carry extracted technical metadata (dimensions, format, orientation),
and support a focal point (`PATCH /assets/:id {focal_x, focal_y}`) for
smart cropping.

Still deliberately out (vs Pimcore): GraphQL Datahub (REST + the typed
client cover it; add Apollo if needed), WYSIWYG/CMS pages and
e-commerce framework (out of PIM scope), Symfony-style plugin system.

## Operations & robustness (v6)
Run `migration-006-operations.sql` (or `npm run migrate`).

**Async jobs (pg-boss, Postgres-backed — no Redis)**: CSV imports return
202 + a job id (poll `GET /io/imports/:id`); image renditions and webhook
deliveries run in background workers with queue-managed retries. Workers
start with the API process; scale them out by running more instances.

**Multi-instance safe**: login rate limiting now lives in Postgres
(shared, restart-proof); the publish-window sweep and retention pruning
take transaction-scoped advisory locks so only one instance runs them.

**Soft deletes**: `DELETE /products/:id` marks `deleted_at` (needs
product.publish); `POST /products/:id/undelete` restores. Deleted
products vanish from every list, feed, and dashboard.

**Lifecycle**: `/health/live` + `/health/ready` (pings the DB);
SIGTERM drains in-flight requests, stops the queue, closes the pool.
Structured pino logs with request IDs (x-request-id honored/returned).

**Retention**: versions pruned to the last 50 per product; webhook
deliveries 30d; idempotency keys 24h; expired tokens/resets cleaned —
all on a 6h advisory-locked schedule.

**Idempotency**: send an `Idempotency-Key` header on POSTs; retries
replay the stored response (`x-idempotent-replay: true`).

**Security**: uploads validated by magic bytes (a PDF claiming to be a
PNG is rejected; pair with ClamAV at the ingress for AV scanning);
password reset flow (`/auth/forgot` → emailed link → `/auth/reset`,
single-use, revokes sessions); optional TOTP 2FA (`/auth/totp/setup` →
`/auth/totp/enable`; login then requires `totp_code`); full auth audit
log in `auth_audit` (logins, failures, resets, role/scope changes).

**Quality gates**: GitHub Actions CI (npm audit, typecheck, unit tests,
migrations + integration tests against a real Postgres, Docker build).
Integration tests cover auth, RBAC denials, optimistic-lock conflicts,
workflow rejections, rate limiting, and soft delete/undelete.

**Backups**: `ops/backup.sh` (pg_dump + assets tar, restore-verified,
14-day retention) — schedule via cron; restore commands documented inline.

## Running on Supabase
1. Supabase Dashboard → SQL Editor → paste & run `supabase-setup.sql`
   (all migrations + an RLS lockdown so Supabase's auto-REST API can't
   touch the tables — this app does its own auth).
2. Dashboard → Connect → copy the **Session pooler** connection string
   (port 5432). Set in .env:
   DATABASE_URL=postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   DB_SSL=true
   DB_SSL_NO_VERIFY=true   # or install Supabase's CA and leave false
3. `npm install && npm run create-admin -- you@email "You" "a-strong-password"`
4. `npm run dev` — the API runs anywhere (it's just Node), only the
   database lives in Supabase.

Notes: use the session pooler (5432) or direct connection — pg-boss and
advisory locks need it; avoid the transaction pooler (6543) for this app.
Asset files still live on local disk/volume; swapping `storeFile` for
Supabase Storage is a ~20-line adapter if you want assets there too.

## Deployment (Fly.io + Supabase, v7)
Assets now go through `src/lib/storage.ts` — `STORAGE_DRIVER=local` (dev)
or `supabase` (production, private bucket via the Storage REST API; the
API proxies reads so RBAC/portal tokens remain the access model). CSV
import files also travel through storage, so the app is fully stateless
and `fly scale count N` is safe.

Deploy: see the comment block at the top of `fly.toml` — `fly launch`,
set five secrets, `fly deploy`. Migrations run automatically in the
release phase. DATABASE_URL must be the direct connection (port 5432);
pg-boss needs LISTEN/NOTIFY which the pooler doesn't support.
