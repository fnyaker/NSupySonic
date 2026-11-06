# Agent team: routing, handoffs, orchestration

Reference note for the primary agent and for anyone adding or changing a subagent. Read
[CLAUDE.md](../../CLAUDE.md) first: its process and seven non-negotiable rules apply to every
agent, including the subagents defined in `opencode.json`.

## Why a team

The area notes under `docs/agents/` are deep on purpose: each one records a rule, why it exists and
the number that proved it. Together they are over 3 000 lines, and `CLAUDE.md` itself is capped at
16 KB for the same reason. Loading all of that into one session would crowd out the task. One
subagent per area keeps the context focused and gives the primary agent a clean contract: a
specialist reads its own notes, changes only its own files, measures, and returns a report.

## The team

| Agent | Owns | Must read | Does not touch |
|---|---|---|---|
| `frontend` | `webapp/src` screens, components, navigation, offline UX, accessibility, French copy, perceived performance | [webapp.md](webapp.md), [playback.md](playback.md) for the player UI, [commands.md](commands.md), [testing.md](testing.md) | `/api` contract, DSP, viz internals, Android |
| `api` | `supysonic/webui`, `supysonic/api`, `db.py`, `schema/`, `config.py`, `cli.py`, managers, access, providers, `deezer/`, `deezerpy/`, jobs | [server.md](server.md), [providers.md](providers.md), [commands.md](commands.md), [testing.md](testing.md) | Svelte, Android, DSP, viz, Docker |
| `audio` | playback path, graph, output/latency, crossfade/trim, ReplayGain, `webapp/rhythm`, live analysis, server tempo/descriptors, party audio | [playback.md](playback.md), [rhythm.md](rhythm.md), [analysis-genre.md](analysis-genre.md), [party-remote.md](party-remote.md), [testing.md](testing.md) | screens, `/api` payloads, viz, Android activity |
| `animation` | `webapp/src/lib/viz`, worlds, shaders, skins, scope, projector, eco mode, `viz*.rs`, render bench | [animations.md](animations.md), [rhythm.md](rhythm.md), [webapp.md](webapp.md) for the settings route, [commands.md](commands.md) | analyser, audio graph, settings shell, `/api` |
| `security` | threat model, auth, CSRF, SSRF, CSP, secrets, capabilities, Android trust, dependencies, supply chain | [audit-securite.md](../audit-securite.md), [server.md](server.md), [providers.md](providers.md), [android.md](android.md), [testing.md](testing.md) | production code unless explicitly asked to fix |
| `android` | `android/`, bridge `NSNative`, native player/service, offline store, updater, Deezer login, JNI `nscore` | [android.md](android.md), [playback.md](playback.md), [webapp.md](webapp.md) for offline/versioning, [commands.md](commands.md) | Svelte UI, DSP formulas, `/api`, Docker |
| `qa` | `tests/`, `webapp/test/`, benches, `tools/partest.py`, `tools/perf_api.py`, upgrade and CI verification | [testing.md](testing.md), [commands.md](commands.md), the area note of the code under test | production code written to fit a test |
| `devops` | `Dockerfile`, `docker/`, compose, seven workflows, ffmpeg pin, multi-arch, release assets, image size | [commands.md](commands.md), [testing.md](testing.md), [android.md](android.md) for the APK release | application behaviour, Svelte, Kotlin, DSP |

## How to invoke

- Manually: `@frontend`, `@api`, `@audio`, `@animation`, `@security`, `@android`, `@qa`,
  `@devops` in a message.
- Automatically: the primary agent delegates from each agent's `description` in `opencode.json`.
  The description is a routing contract; keep it precise when you edit it.
- List what OpenCode loaded: `opencode debug agents` (`opencode agent list` on older builds).
  `opencode debug config` lists the configuration files in effect.
- A subagent runs in a child session. Use the session navigation keys to read its work; the
  primary agent receives its final report.

## Routing by path

| You are about to touch | Agent |
|---|---|
| `webapp/src/routes/**`, `webapp/src/components/**`, `webapp/src/app.css`, `webapp/public/sw.js` | `frontend` |
| `webapp/src/lib/stores.js`, `actions.js`, `nav.js`, `offline.js`, `reconcile.js`, `grow.js`, `searchrank.js` | `frontend` |
| `webapp/src/components/Player.svelte` layout/copy/controls | `frontend` |
| `Player.svelte` crossfade/trim/seek/source handover, `lib/audio/**`, `webapp/rhythm/**` | `audio` |
| `supysonic/webui/**`, `supysonic/api/**`, `supysonic/db.py`, `supysonic/schema/**` | `api` |
| `supysonic/deezer/**`, `supysonic/providers/**`, `deezerpy/**`, `sources.py`, `access.py` | `api` |
| `supysonic/deezer/analysis.py`, `beats.py`, `measure.py`, `embedding.py`, `genre*.py` | `audio` (route/DB part: `api`) |
| `webapp/src/lib/viz/**`, `webapp/rhythm/src/viz*.rs`, `webapp/test/render/**` | `animation` |
| `android/**`, `webapp/src/lib/native*.js`, `webapp/src/lib/offline.js` native branch | `android` |
| `tests/**`, `webapp/test/**`, a failing CI test job | `qa` |
| `Dockerfile`, `docker/**`, `.github/workflows/**`, `docker-compose.yml`, `.dockerignore` | `devops` |
| auth, sessions, CSRF, CSP, SSRF, uploads, shares, remote/party capabilities, secrets, dependencies | `security` first, then the owner |

## The orchestration protocol

1. **The primary agent keeps the need.** Restate what the person will do, on which device and
   network. Split the work by area; do not send a vague "make it better" to a specialist.
2. **Contract first.** When a change crosses areas, the producer defines the contract before the
   consumers start:
   - `api` defines the route, payload, status codes, schema and config keys;
   - `audio` defines the analysis frame, the latency reading or the audio contract;
   - `android` defines the bridge version and the message shape;
   - `frontend` and `animation` consume those contracts; they do not invent a parallel one.
3. **One writer per file at a time.** Two subagents editing the same worktree can overwrite each
   other. Run the writing agents sequentially, or use separate worktrees for genuinely
   independent areas. Read-only agents (`explore`, `security` during an audit) may run in
   parallel.
4. **The specialist measures.** Each prompt says which bench or suite proves the rule. A report
   without a command and a number is not done.
5. **`qa` verifies the whole.** After the area agents, run the suite and the bench that cover the
   change, then the broader suite. `qa` may be invoked directly for a failing check or a
   performance question.
6. **`security` signs off sensitive surfaces.** Auth, access, uploads, shares, remote/party
   capabilities, CSP, secrets, Android trust and new dependencies deserve a review before merge.
   Its findings go back to the owner agent.
7. **The primary agent does the final pass.** Re-read the diff, run the full tests, update the
   area note, write the PR with the sources and the measured numbers, drive CI green, merge. A
   subagent never commits, pushes, opens a PR or merges.
8. **Write down what was learned.** The specialist updates its area note; a rule that applies to
   every area goes into `CLAUDE.md` in one or two lines.

## Parallelisation

Safe to run at the same time, because they do not write the same files:

- `security` (read-only audit) with any implementation agent;
- `qa` measuring the current state while `frontend` or `api` works in another area;
- `frontend` and `animation` only if the boundary is explicit (the settings shell vs. the viz
  panel), otherwise sequential;
- `api` and `audio` only when the API route and the DSP file are disjoint; the contract must be
  agreed first.

Not safe in parallel: two agents that both edit `Player.svelte`, `stores.js`, `webapp.md`,
`server.md`, the same migration or the same test file. Decide the owner, or split the files.

## What a subagent returns

Every prompt asks for the same skeleton, in French:

- **Besoin** — restated, with device/network.
- **Changement / contrat** — what the person sees, or the payload/schema/bridge contract.
- **Fichiers** — paths and why each.
- **Mesures** — before/after, the number the rule claims.
- **Vérifications** — commands, databases, real audio, what was looked at.
- **Docs** — area note updated, or why not.
- **Risques / questions** — what the primary agent must decide.

A subagent that cannot finish says what is blocked and what it tried. It does not guess silently
and it does not weaken a test to claim success.

## Model and permissions

- No model is hardcoded in `opencode.json`: each subagent inherits the primary agent's model.
  This keeps the config portable across providers.
- `security` is read-only by default (`edit: ask`). It reports findings and recommended patches;
  the owner agent implements them unless the primary agent explicitly asks `security` to patch.
- Every subagent may call `explore` for read-only codebase search, and nothing else through the
  task tool. This prevents recursive delegation storms.
- The security agent may run the test suite and the scanners; it must not print a secret it finds,
  and must not attack a third-party service.

## What not to delegate

- The final decision on a trade-off the person did not specify. The specialist researches and
  recommends; the primary agent decides and reports the sources.
- The merge, the tag, the image publication, the release: the primary agent owns them.
- Secret handling: no subagent may write a real ARL, password, token or keystore into a file, a
  test, a log or a report.
- A destructive command against a real library, database, archive or account.
- A broad rewrite "while you are there". A subagent keeps the diff inside its area.

## Worked examples

**A new screen that lists something.** `api` defines the endpoint and its payload (and the
statement budget), `frontend` builds the screen against that contract and benches the click, `qa`
runs the request and list benches, `security` reviews it if the data is personal.

**A track sounds sped up on a car radio.** `audio` reads the output-path policy and the timekeeper,
reproduces with the output bench, and may ask `android` for the route/connection information. `qa`
runs `test/output/run.mjs`; `frontend` is not involved unless the path indicator's UI changes.

**A new visual world.** `animation` reads `animations.md`, writes the world and its driver, runs
the render bench and the oracles; `audio` is consulted if the frame layout changes; `frontend` is
consulted only if the settings panel's shell changes.

**A migration that adds a column.** `api` writes the three migration files, bumps
`SCHEMA_VERSION`, tests the upgrade on SQLite and a real PostgreSQL, and measures the statement
cost. `qa` runs `test_schema.py` and the upgrade path. `security` reviews it only if the column
stores a secret or a capability.

**A red security workflow.** `devops` reads the failing job's log and reproduces the scanner
locally; `security` judges whether the finding is real and what the fix is; the owner agent
implements it; `devops` confirms the workflow.

## Maintaining the team

When adding or changing a subagent:

1. Add or edit its entry in `opencode.json` (description, prompt path, permissions, colour).
2. Add or edit its prompt under `.opencode/prompts/`.
3. List it in the table in `CLAUDE.md` and in this file.
4. Keep `CLAUDE.md` under 16 KB (`tests/test_agent_docs.py` checks it) and keep every area file
   linked from it.
5. Run `python -m unittest tests.test_agent_docs` and `opencode debug agents`.
6. If the agent owns a new area, add its note under `docs/agents/` and a row in the area table.
