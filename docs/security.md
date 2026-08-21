# Security

How Yume protects accounts, the API and the VPS it runs on. This documents what
is implemented today — see the end for what is deliberately still open.

---

## 1. Authentication

* **Access tokens** — stateless JWT, 15 minute lifetime, signed with `JWT_SECRET`.
* **Refresh tokens** — 256-bit random values. Only their SHA-256 is stored, in
  the `sessions` table; the token itself never touches the database.
* **Rotation** — every refresh revokes the session it came from and issues a new
  one, so a stolen refresh token is usable at most once before it stops working.
* **Passwords** — scrypt with OWASP-recommended parameters (N=2¹⁷, r=8, p=1),
  compared with `timingSafeEqual`. The hash string is self-describing
  (`scrypt$N$r$p$salt$hash`) so the parameters can be raised later without
  invalidating existing passwords.
* **Session records** carry IP and user agent and can be revoked (`revoked_at`).

### The secret must be real in production

`JWT_SECRET` is the whole account-security boundary — anyone who knows it can
mint a token for any user. The app **refuses to start** in production if it is
missing, still the development placeholder, or shorter than 32 characters:

```
Error: JWT_SECRET is still the development placeholder.
       Generate one with: openssl rand -base64 48
```

`docker-compose.yml` requires it too, so `docker compose up` fails with a clear
message rather than booting insecurely. Put it in `.env` (see `.env.example`).

### Login does not reveal which accounts exist

A failed login costs the same whether the account exists or not: when there is no
matching user the request still runs a scrypt verification against a decoy hash.
Without this the response time alone (about 5 ms versus 400 ms) enumerates
registered usernames and emails.

Measured after the fix — existing account vs unknown account, median of 10
interleaved requests: **408.5 ms vs 402.5 ms (1.5 % apart)**.

> Registration still answers `409` when an email or username is taken. That is a
> deliberate usability trade-off, and it is the only place account existence is
> observable.

---

## 2. Authorisation

One RBAC system, no second auth path:

```
users → user_roles → role_permissions → permissions
```

`fastify.requirePermission(slug)` guards a route; `fastify.authenticate` covers
routes that only need a signed-in user. Anonymous requests get **401**,
authenticated users without the permission get **403**.

Monitoring is gated on `system.metrics.view`, diagnostics on
`system.diagnostics.run`. Permissions carry a `status` (`active` / `planned`) so
the catalogue never claims to enforce something it does not — see
[`allapot.md`](./allapot.md).

---

## 3. Rate limiting

Password hashing is deliberately expensive, which makes unlimited login attempts
both a brute-force and a CPU-exhaustion vector. Limits are per IP
(`trustProxy` is on, so the real client IP is used behind a reverse proxy):

| Scope | Default | Env override |
|---|---|---|
| Global | 300 / minute | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW` |
| `POST /v1/auth/login`, `/register` | 10 / 15 min | `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW` |
| `POST /v1/auth/refresh` | 60 / 15 min | `REFRESH_RATE_LIMIT_MAX` |
| Comments, reports | 30 / 5 min | `WRITE_RATE_LIMIT_MAX` |

**Health endpoints are never rate limited** — orchestrators poll them and a 429
would be read as the service being down.

Exceeding a limit returns RFC 9457 problem+json:

```json
{ "type": "about:blank", "title": "Too Many Requests", "status": 429,
  "detail": "Rate limit exceeded — retry in 15 minutes." }
```

> Limits are held in process memory. With a single app container that is exact;
> if you scale to several replicas each holds its own counter, so the effective
> limit multiplies. A shared store belongs with the Redis adoption.

---

## 4. Request hardening

* **Body limit** — 1 MB (`BODY_LIMIT_BYTES`). Oversized requests get **413**
  before the body is buffered.
* **Schema validation** — every route declares a JSON Schema; unknown
  properties are rejected (`additionalProperties: false` on mutation bodies),
  which closes mass-assignment.
* **Parameterised SQL everywhere** — the query helpers only take values as
  parameters, so no user input is concatenated into SQL.

## 5. Response headers

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | see below | blocks injected scripts |
| `X-Content-Type-Options` | `nosniff` | no MIME sniffing |
| `X-Frame-Options` | `DENY` | no clickjacking |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | no URL leakage |
| `Cross-Origin-Opener-Policy` | `same-origin` | isolates the browsing context |
| `Strict-Transport-Security` | opt-in via `ENABLE_HSTS=true` | only once HTTPS terminates in front |

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' …;
img-src 'self' data: blob: https:; media-src 'self' blob: https:;
connect-src 'self' https:; frame-src <youtube>; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

`script-src` stays strict — that is the directive that actually stops XSS.
`style-src` needs `'unsafe-inline'` because the UI sets inline style attributes
and injects a `<style>` element for themes.

## 6. CORS

In development anything is allowed. In production a wildcard would let any site
drive the API with a user's bearer token, so:

* `CORS_ORIGINS` unset **or** `*` → **same-origin only** (what the
  single-container deployment needs).
* Set it explicitly to host the web client on another origin:
  `CORS_ORIGINS=https://yume.example.com`.

---

## 7. What monitoring never exposes

* Public `/v1/health/ready` returns service names and colours only — no latency,
  error detail, hostnames, versions, paths or configuration.
* Probe failures are redacted before they are stored: URLs, credentials and IP
  addresses are stripped and the message truncated (`safeDetail` in
  `lib/probes.ts`, covered by tests).
* The Docker socket is **not** mounted. It grants root-equivalent access to the
  host, so per-container detail is deliberately traded away for that boundary.
* The only host path exposed to a container is `/` mounted **read-only** at
  `/host` for the worker, so disk usage measures the VPS rather than the
  container overlay.

## 8. Verified by tests

`npm test` covers: security headers and the CSP shape, health never being
throttled, throttling returning problem+json, oversized bodies rejected with
413, every admin monitoring endpoint refusing anonymous and forged tokens, the
production secret validation (placeholder / too short / valid) and wildcard CORS
collapsing to same-origin.

## 9. Still open

Known and deliberately not yet done — roughly in priority order:

1. **Account lockout / progressive delays** after repeated failures per account
   (today the protection is per IP only).
2. **Two-factor authentication** and passkeys (`user_settings` schema exists).
3. **A shared rate-limit store** for multi-replica deployments.
4. **Session management UI** — the data model supports listing and revoking
   sessions and devices; there is no screen for it yet.
5. **WebSocket rate limiting** — connections authenticate, but message rate is
   not yet bounded.
6. **Automated dependency scanning** in CI.
