# Resilience rules (Deezer is optional to the app running)

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching ANY Deezer network call, the circuit breaker, timeouts, retries, error handlers, podcast URL fetching/SSRF, or 'unreachable' UX.

**Resilience rules (learned from a production outage — do not regress).** The governing rule:
**Deezer is optional to the app running.** Everything on disk — playing archived music, browsing,
playlists, favourites, uploads, the SPA itself — must keep working at full speed while Deezer is
unreachable, and the parts that do need Deezer must fail *fast* and *without a verdict*.

- Every upsert in `library.py` is a check-then-insert, which is **not atomic**. Concurrent plays of
  the same album race and the loser gets a unique-constraint violation (and, on Postgres, a poisoned
  transaction). All of them go through `library.create_or_get` (insert inside its own
  `db.atomic()` → savepoint, then read the winner's row back). Keep any new upsert on that path.
- `deezerpy` requests carry a **default timeout** (`deezerpy.DEFAULT_TIMEOUT`, applied by `_Session`)
  — `requests` has none, and one black-holed socket parks a server thread until the gunicorn worker
  is killed. Never build a bare `requests.Session()` for Deezer, and never pass a *scalar* timeout
  (that applies the whole budget to the connect phase alone).
- **Latency, not errors, is what an outage takes the app down with.** Every call blocking for the
  timeout parks a thread; enough of them and the worker runs out of threads and of file descriptors
  (`Errno 24`), and the app is down for everyone — including the users who never needed Deezer. So:
  - `deezerpy/_circuit.py` holds a **per-host circuit breaker** on the shared `_Session`. After a
    few *transport* failures a host is short-circuited: further calls raise `DeezerUnavailable`
    instantly instead of paying the timeout, until a cooldown elapses and one probe is let through.
    Per host on purpose (a rate-limited `api.deezer.com` must not stop playback from the CDN); only
    transport failures count (an HTTP error or a gateway error payload is Deezer *answering*).
  - `api_call` in `api.py`/`gw.py` retries against a **wall-clock budget** (`NET_BUDGET`), not just a
    count, and never retries a short-circuited call. Their non-network replays (CSRF refresh,
    gateway `FALLBACK`) are bounded too — they used to recurse without limit.
  - `DeezerProvider.available()` is the instant, no-network "is it worth calling Deezer?" read.
    `_dz_api()` / `_dz_live()` in the webui are the route-level version: they return `None` instead
    of raising, so a route drops to its database answer at once. **Reading `provider.dz` logs in**,
    so touching it outside a `try` is how an outage became a 500 — go through those helpers.
  - A failed login is not retried on every request (`_login_retry_at` backoff), and a re-login
    `close()`s the old client so its connection pool goes back to the OS.
- **A failure to reach Deezer is never a verdict about the data.** `TrackUnavailable` and
  `ShowUnavailable` condemn a track / retire a subscription, and the user is then offered to replace
  or delete it — so they may only be raised when Deezer *answered*. `errors.is_transport_failure()`
  (which walks the `__cause__` chain) is the test; `provider.resolve` downgrades any unconfirmed
  verdict to a plain `DeezerError`, and `_url_from_info` raises rather than reporting "no source"
  when it could not ask.
- Background work backs off instead of burning through itself: the download queue waits out the
  breaker's cooldown (`prefetch._outage_wait`, and *only* while a circuit is actually open) rather
  than failing every queued id in seconds, and the scheduler postpones a sync while Deezer is
  unreachable (the local scan still runs).
- **Podcast episode URLs come from third-party feeds**, so `check_public_url` refuses anything but
  http(s) to a public address — and then the fetch **connects to the address it just validated**
  (`_PinnedAddressAdapter`, via requests' `build_connection_pool_key_attributes`). Checking the
  *name* alone can never be enough: the guard resolves it and the HTTP client resolves it again, so
  a resolver that answers differently the second time (DNS rebinding) walks straight past a
  name-based check and its answer gets archived and served by `/api/stream`. The pin moves the TCP
  connection only — SNI, certificate validation and the `Host` header still carry the real hostname
  — and it walks the host's addresses itself, since pinning gives up the fail-over
  `create_connection` does for free. It steps aside when a proxy is configured (the proxy does the
  resolving, and it is the operator's boundary).
- `socket.getaddrinfo` takes no timeout, and glibc's defaults make one stalled lookup 20s+.
  `requests` folds DNS into its connect timeout, so the session is covered — but the podcast SSRF
  pre-flight (`check_public_url`) resolves *before* requests is involved, once per redirect hop, on
  a host a third-party feed chose. It goes through `provider.resolve_addresses`: a deadline, a
  short-lived cache (positive *and* negative, so the next caller never re-pays a timeout), and a
  bounded set of **daemon** lookup threads — a `ThreadPoolExecutor` would be joined at interpreter
  exit and one wedged name would hang the shutdown of the worker being recycled because of it.
- The `/api` blueprint has a catch-all error handler: an unforeseen failure becomes a JSON 500 with
  the traceback in the log, never an HTML page the SPA can't parse.
- **Reaching Deezer again is the SERVER's job, never the client's.** A page only Deezer has, asked
  while Deezer does not answer, is a 503 marked `X-NS-Error: deezer-unreachable` (`_deezer_missing` /
  `_deezer_unreachable`, with `retry_in`); the proxy switched off is `deezer-disabled`. `lib/api.js`
  reads the header as final and never retries it (an unmarked 503 — a restart — still is): the
  server's calls already retry inside their budget and the breaker probes once its cooldown is over,
  so three client retries only fetched the same instant refusal ~3 s later. Deezer ANSWERING that a
  thing is not there stays a 404. The screens say "Deezer est injoignable" (`LoadFailed.svelte`),
  never "introuvable", and only the person's "Réessayer" asks again.
- The ARL can die at any moment. `DeezerProvider.check_login()` is the cached health check and
  distinguishes `"arl"` (credential dead — admin action) from `"network"` (says nothing about it);
  `/api/deezer/status` surfaces it, with `retry_in`, and the SPA raises a notice
  (`lib/deezerhealth.js`) — an actionable one for the credential, an explanatory one ("your
  downloaded library is still there") for an outage, re-checked when the server says it will retry.
