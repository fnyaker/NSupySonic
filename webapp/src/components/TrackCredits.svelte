<script>
  // Who is on a track's sleeve: one row per role (in the order a sleeve lists
  // them, see webui/credits.py), then the release line. Shown under the
  // full-screen player and in the track menu's credits sheet.
  //
  // A name opens what the library has of that person: their artist page when
  // the library holds an artist of that name, else their credits page (what
  // they wrote, composed or produced) once they are credited on another track
  // too. A name with neither is plain text: a link must lead somewhere.
  //
  // Colours come from the surface it sits on: `--tc-dim` and `--tc-line`
  // (the player sets them for its dark glass; the sheet keeps the theme's).
  import { entityRef } from "../lib/entity.js";

  export let data = null; // { credits: [{role, label, people}], info }

  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  // "2001-03-12" -> "12 mars 2001" (or just the year when that is all there is).
  function formatDate(d) {
    const m = DATE.exec(d);
    if (!m) return d;
    try {
      return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
    } catch {
      return d;
    }
  }

  function href(p) {
    if (entityRef(p)) return "#/artist/" + entityRef(p);
    if (p.credited) return "#/credits/" + encodeURIComponent(p.name);
    return null;
  }

  $: rows = data?.credits || [];
  $: info = data?.info || {};
  $: release = [info.album, info.released && formatDate(info.released), info.label, info.copyright]
    .filter(Boolean)
    .join(" · ");
</script>

{#if rows.length}
  <dl class="credits">
    {#each rows as c (c.role)}
      <div class="crow">
        <dt>{c.label}</dt>
        <dd>
          {#each c.people as p, k}{#if k}<span class="sep">,</span>{/if}{#if href(p)}<a
                href={href(p)}
                title={p.credited && !entityRef(p) ? `Crédité sur ${p.credited} titres` : null}>{p.name}</a
              >{:else}<span>{p.name}</span>{/if}{/each}
        </dd>
      </div>
    {/each}
  </dl>
{/if}
{#if release || info.isrc}
  <p class="release">
    {release}
    {#if info.isrc}<span class="isrc">ISRC {info.isrc}</span>{/if}
  </p>
{/if}

<style>
  .credits {
    margin: 0;
    padding: 0;
  }
  .crow {
    display: grid;
    grid-template-columns: minmax(96px, 34%) 1fr;
    gap: 12px;
    padding: 9px 2px;
    border-bottom: 1px solid var(--tc-line, var(--bg-hover));
  }
  .crow:last-child {
    border-bottom: none;
  }
  dt {
    font-size: 0.8rem;
    color: var(--tc-dim, var(--text-dim));
    padding-top: 1px;
  }
  dd {
    margin: 0;
    font-weight: 600;
    font-size: 0.92rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  dd a {
    color: inherit;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
    /* a comfortable target on a phone without changing the line's rhythm */
    padding: 4px 0;
    margin: -4px 0;
  }
  dd a:hover,
  dd a:focus-visible {
    text-decoration-color: currentColor;
  }
  .sep {
    margin-right: 0.3em;
    font-weight: 400;
    color: var(--tc-dim, var(--text-dim));
  }
  .release {
    margin: 10px 2px 0;
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--tc-dim, var(--text-dim));
  }
  .isrc {
    display: block;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
</style>
