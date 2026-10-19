# RouteResolver modules

`@corridor/router` draws the routing seam in code: an engine gets a
`RouteResolver`, and where the receiving anchor comes from is that resolver's
business. The repo ships two — `StaticRouteResolver` (trust the manifest) and
`RegistryRouteResolver` (require a fresh on-chain attestation) — and an
operator can point a deployment at a third, private one without forking
anything. This page documents that mechanism.

## The module contract

`loadResolver(spec, { adapterFor })` (exported from `@corridor/router`) turns a
named module into a `RouteResolver`. The module must satisfy two things:

```ts
export const apiVersion = ROUTE_RESOLVER_API_VERSION; // named export, exact match

export default function createResolver(ctx, options) {
  // (ctx, options) => RouteResolver — sync or async.
  // ctx = { adapterFor: (corridor) => AnchorAdapter }
  return {
    async resolve(intent, corridor) {
      return { receiving: ctx.adapterFor(corridor), trust: "manifest" };
    },
  };
}
```

Loading refuses, by name, every way the contract can be broken:

| Failure                               | Result                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| `module` is a URL (`http://...`)      | refused; only filesystem paths or installed packages load  |
| module does not exist / import throws | `ResolverLoadError: could not be loaded (...)`             |
| `apiVersion` missing or mismatched    | `ResolverLoadError: declares apiVersion ..., expected ...` |
| no default-exported factory           | `ResolverLoadError: must default-export a factory (...)`   |
| factory throws                        | `ResolverLoadError: factory threw (...)`                   |
| factory's return has no `resolve()`   | `ResolverLoadError: ... did not return a RouteResolver`    |

All of these stop the boot. A deploy that names a resolver which is missing or
incompatible must never fall back to a weaker one silently; falling back IS
the failure this seam exists to prevent.

## Environment

`examples/run-service.ts` (`pnpm serve`) reads two variables, both optional:

| Variable                    | Meaning                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CORRIDOR_RESOLVER_MODULE`  | Filesystem path (`./examples/resolvers/allowlist-resolver.ts`) or installed package name to load. Unset = built-in `StaticRouteResolver`. |
| `CORRIDOR_RESOLVER_OPTIONS` | Optional JSON object passed to the module's factory as `options`. Must be valid JSON when set.                                            |

Both are recorded in `.env.example`. The startup summary logs which resolver
the process is running with:

```text
• resolver: ./examples/resolvers/allowlist-resolver.ts (CORRIDOR_RESOLVER_MODULE)
...
✓ @corridor/service listening on :8080
  resolver:  ./examples/resolvers/allowlist-resolver.ts
```

## The example: allowlist-resolver

`examples/resolvers/allowlist-resolver.ts` is a complete, non-proprietary
resolver living outside `@corridor/router`. It wraps another resolver —
`RegistryRouteResolver` by default — and refuses any corridor whose
`dest.endpoints.home_domain` is not on an operator allowlist, so an allowlist
entry can never re-enable a lane that the attestation evidence then rejects,
and vice versa.

Run it:

```sh
CORRIDOR_RESOLVER_MODULE=./examples/resolvers/allowlist-resolver.ts \
CORRIDOR_RESOLVER_OPTIONS='{"domains":["localhost:8080"]}' \
pnpm serve
```

Its options (via `CORRIDOR_RESOLVER_OPTIONS`):

| Option                   | Meaning                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domains` (required)     | Destination home domains payments may be routed to. Aliased `allowlist`. An empty list fails the boot — an allowlist that allows nothing by accident is a misconfiguration, not a policy.                                                     |
| `wrap`                   | Wrap this resolver instead of the default `RegistryRouteResolver`. JSON cannot carry functions, so this is for programmatic callers and tests only.                                                                                           |
| `registry`               | Inject an `AttestationSource` for the default registry resolver (programmatic/testing). Deployment default: the on-chain registry when `REGISTRY_CONTRACT_ID` is set, otherwise a source that throws so `RegistryRouteResolver` fails closed. |
| `maxStalenessLedgers`    | Freshness bound passed through to the default registry resolver.                                                                                                                                                                              |
| `allowUnattestedDomains` | Passed through to the default registry resolver. `localhost` variants and `REFERENCE_ANCHOR_URL` are included by default (same defaults as the CLI), because a self-hosted reference anchor can never be attested by a public attester.       |

Refusals name the domain, e.g.
`refusing to route to example.com: not on the operator allowlist (1 domain allowed)`.

## Writing your own

1. Create a file (any path or package you control).
2. Export `apiVersion` (import it from `@corridor/router` so a future contract
   bump stays honest) and a default factory `(ctx, options) => RouteResolver`.
3. Point `CORRIDOR_RESOLVER_MODULE` at it and restart `pnpm serve`.
4. Read `examples/resolvers/allowlist-resolver.ts` and
   `tests/router.test.ts` for the tested shape of both.
