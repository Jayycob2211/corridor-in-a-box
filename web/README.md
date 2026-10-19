# corridor-in-a-box — web

A small Next.js (App Router, Tailwind v4) frontend for the engine:

- **Dashboard** — the corridors with build-time liveness in three states —
  `verified` / `unverified` / `not runnable` — where only `verified` counts as
  runnable (`lib/corridors.ts`, `liveness()`).
- **Run a payment** — drive a payment through the engine and watch it walk the
  state machine, including the idempotent replay.
- **Docs** — overview, getting started, architecture, HTTP API, key management, and
  why not Anchor Platform? (the six pages in `lib/docs.ts`).

Since [#80](https://github.com/ezedike-evan/corridor-in-a-box/pull/80) `web/` is
its own pnpm workspace root (`web/pnpm-workspace.yaml`, with its own lockfile), so
it builds and runs on its own — gated by its own CI job (`pnpm typecheck` +
`pnpm build`, see `.github/workflows/ci.yml`) rather than by the monorepo's
test/lint gate.

## Develop

```bash
cd web
pnpm install
pnpm dev      # http://localhost:3000
```

```bash
pnpm typecheck
pnpm build
```

## How it talks to the engine

By default the **Run a payment** page calls a local API route
(`app/api/payments/route.ts`) that invokes the real `@corridor/engine` with
in-memory mock anchor and settlement adapters. The scenario selector exercises
the happy path, quote expiry, settlement retries, and reconciliation recovery;
no live anchor endpoints or funds are used. `web/` keeps its own pnpm lockfile
but resolves engine, adapter-kit, manifest, router, and types from their source
using `tsconfig.json` paths and Next's `transpilePackages`.

To drive the **real** engine, run `@corridor/service` and set:

```bash
CORRIDOR_SERVICE_URL=http://localhost:8080      # the route proxies POST /payments here
CORRIDOR_SERVICE_API_KEY=…                        # optional; if the service requires Bearer auth
```

When `CORRIDOR_SERVICE_URL` is set the route forwards to the real service and
relays its response; the demo-only scenario field is removed from the proxied
request.
