<script>
  import { push } from "svelte-spa-router";
  import { credits } from "../lib/format.js";

  export let track = null;
  // Some callers already hold a credit list (a queue row, a search hit) and
  // have no track object to hand over.
  export let list = null;
  // Set false in views where the whole surface is already a link/target and a
  // nested control would steal the tap (the mini-player's own artist button).
  export let linked = true;
  // Custom navigation, for hosts that must do more than route — the full-screen
  // players close themselves first, otherwise the artist page opens *behind*
  // the sheet still covering it.
  export let navigate = null;

  $: people = list || credits(track);
  $: parts = buildParts(people);

  // A flat render list — artists interleaved with their separators — so the
  // template is one loop and the spacing rides in EXPRESSIONS. Written as
  // literal markup, `" feat. "` gets whitespace-collapsed by the compiler and
  // the line comes out as "Alphafeat.Beta".
  function buildParts(all) {
    const main = all.filter((a) => a.role === "Main");
    const feat = all.filter((a) => a.role !== "Main");
    const out = [];
    for (const a of main.length ? main : all) {
      if (out.length) out.push({ sep: ", " });
      out.push({ artist: a });
    }
    if (feat.length && main.length) {
      out.push({ sep: " feat. ", quiet: true });
      let first = true;
      for (const a of feat) {
        if (!first) out.push({ sep: ", " });
        first = false;
        out.push({ artist: a });
      }
    }
    return out;
  }

  function go(a, e) {
    if (!linked || !a.deezer_id) return;
    e.stopPropagation();
    const path = "/artist/" + a.deezer_id;
    if (navigate) navigate(path);
    else push(path);
  }
</script>

<!--
  Rendered inline so the PARENT keeps owning the layout: every call site wraps
  this in its existing `.a`-style element, which is where the ellipsis, colour
  and font size live. Emitting a block here would break that truncation — which
  is also why the loop is one unbroken line: a newline between two inline
  elements renders as a stray space.
-->
{#each parts as p, i (i)}{#if p.sep}<span class="sep" class:quiet={p.quiet}>{p.sep}</span>{:else}<button class="one" class:plain={!linked || !p.artist.deezer_id} tabindex={linked && p.artist.deezer_id ? 0 : -1} on:click={(e) => go(p.artist, e)}>{p.artist.name}</button>{/if}{/each}

<style>
  /* Inherit everything: the wrapper decides how the credit line looks, this
     only makes each name individually hoverable. */
  .one {
    display: inline;
    padding: 0;
    margin: 0;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    letter-spacing: inherit;
    text-align: inherit;
    cursor: pointer;
  }
  .one:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .one.plain {
    cursor: inherit;
  }
  .one.plain:hover {
    color: inherit;
    text-decoration: none;
  }
  .sep {
    /* Separators must survive the wrapper's `white-space: nowrap` collapsing
       AND stay visible on their own. */
    white-space: pre;
  }
  /* "feat." is connective tissue, not a name — keep it a notch quieter so the
     eye lands on the artists. */
  .quiet {
    opacity: 0.65;
  }
</style>
