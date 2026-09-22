// Fail fast, and in one readable line, when the tests are run before an install.
//
// WHY THIS EXISTS. `node --test` handles an unresolved import per FILE: the
// files that need nothing still run, the ones that reach `svelte/store` through
// `stores.js` abort, and the summary reads "63 pass, 5 fail" — five failures
// with DSP names on them and fourteen tests that silently never ran at all.
// That is indistinguishable from a real bug in the analysis engine, and it has
// already cost one debugging session chasing exactly that. The suite genuinely
// needs no test framework — no jest, no vitest, no jsdom, just `node --test` —
// but the modules under test are part of a Svelte app and import its store
// primitives, so the app's own dependencies have to be there.
const NEEDED = ["svelte/store"];

const missing = [];
for (const spec of NEEDED) {
  try {
    await import(spec);
  } catch {
    missing.push(spec);
  }
}

if (missing.length) {
  console.error(
    `\n  Cannot run the tests: ${missing.join(", ")} not installed.\n` +
      "  Run `npm install` in webapp/ first.\n\n" +
      "  (The suite itself needs no test framework — this is the app's own\n" +
      "   dependency, reached through src/lib/stores.js.)\n"
  );
  process.exit(1);
}
