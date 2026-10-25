<script>
  // Réglages → Sources: what each provider does, the accounts it is reached
  // through, and who may use them (plan multi-provider §15). What is archived
  // on the server is everybody's; this screen is about the rest.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import WhoPicker from "./WhoPicker.svelte";

  let data = null;
  let failed = false;
  let busy = false;
  let openFeatures = {}; // provider id -> the per-feature table is open
  let newGroup = "";
  let editing = null; // group id whose members are being edited
  let confirmDel = null; // group id waiting for its second tap

  async function load() {
    try {
      data = await api.access();
      failed = false;
    } catch {
      failed = true;
    }
  }
  onMount(load);

  $: sound = data ? data.providers.filter((p) => p.role !== "info") : [];
  $: facts = data ? data.providers.filter((p) => p.role === "info") : [];
  $: groups = data?.groups || [];
  $: users = data?.users || [];

  const shared = (p) => p.features.filter((f) => f.scope === "shared");
  const personal = (p) => p.features.filter((f) => f.scope === "personal");

  function holderLine(a) {
    if (a.server) return a.owner ? `Compte du serveur · tenu par ${a.owner.name}` : "Compte du serveur";
    return a.mine ? "Votre compte" : a.owner ? `Compte de ${a.owner.name}` : "Compte";
  }

  async function setWho(p, accountId, feature, subjects) {
    if (busy) return;
    busy = true;
    try {
      const r = await api.setGrants(p.id, accountId, feature, subjects);
      const target = accountId === "" ? p.anonymous_use : p.accounts.find((a) => a.id === accountId);
      if (target) target.grants = r.grants;
      data = data;
    } catch (e) {
      toasts.push(e?.message || "Échec", "error");
    }
    busy = false;
  }

  async function addGroup() {
    const name = newGroup.trim();
    if (!name || busy) return;
    busy = true;
    try {
      const g = await api.createGroup(name, []);
      newGroup = "";
      await load();
      editing = g.id;
    } catch (e) {
      toasts.push(e?.message || "Échec", "error");
    }
    busy = false;
  }

  async function toggleMember(g, uid) {
    if (busy) return;
    const ids = g.members.map((m) => m.id);
    const next = ids.includes(uid) ? ids.filter((i) => i !== uid) : [...ids, uid];
    busy = true;
    try {
      const r = await api.updateGroup(g.id, { members: next });
      g.members = r.members;
      data = data;
    } catch (e) {
      toasts.push(e?.message || "Échec", "error");
    }
    busy = false;
  }

  async function removeGroup(g) {
    if (busy) return;
    if (confirmDel !== g.id) {
      confirmDel = g.id;
      setTimeout(() => confirmDel === g.id && (confirmDel = null), 4000);
      return;
    }
    confirmDel = null;
    busy = true;
    try {
      await api.deleteGroup(g.id);
      await load();
    } catch (e) {
      toasts.push(e?.message || "Échec", "error");
    }
    busy = false;
  }

  const glyph = (id) => (id === "youtube" ? "youtube" : "music");
</script>

<section class="card">
  <h2>Sources et accès</h2>
  <p class="muted sub">
    Tout ce qui est déjà sur le serveur est à tout le monde. Ici se règle le reste&nbsp;:
    qui peut chercher, écouter et ouvrir des pages chez chaque service, et avec quel compte.
  </p>

  {#if failed}
    <p class="muted">Impossible de lire les accès. <button class="link" on:click={load}>Réessayer</button></p>
  {:else if !data}
    <p class="muted">Chargement…</p>
  {:else}
    {#each sound as p (p.id)}
      <article class="prov">
        <header>
          <span class="glyph"><Icon name={glyph(p.id)} size={18} /></span>
          <span class="txt">
            <span class="nm">{p.name}{#if p.role === "fallback"}<span class="tag">secours</span>{/if}</span>
            <span class="muted st">
              {#if p.allowed.length}Vous pouvez : {p.features.filter((f) => p.allowed.includes(f.id)).map((f) => f.label.toLowerCase()).join(", ")}
              {:else if !p.accounts.length && !p.anonymous_use}Aucun compte relié{#if data.admin && p.id === "deezer"}{"\u00a0: "}l'ARL du serveur se règle dans Compte{/if}
              {:else}Pas accessible pour vous{/if}
            </span>
          </span>
        </header>

        <ul class="feats" aria-label="Ce que fournit {p.name}">
          {#each shared(p) as f (f.id)}
            <li title={f.help}>
              <span>{f.label}</span>
              <span class="need" class:acc={f.auth === "account"}>{f.auth === "account" ? "compte" : "sans compte"}</span>
            </li>
          {/each}
          {#each personal(p) as f (f.id)}
            <li class="perso" title={f.help}>
              <span>{f.label}</span>
              <span class="need acc">personnel</span>
            </li>
          {/each}
        </ul>
        {#if personal(p).length}
          <p class="fine muted">
            Les fonctions personnelles (vos favoris, vos playlists chez {p.name}) ne servent qu'au
            titulaire du compte et ne se prêtent pas.
          </p>
        {/if}
        {#if p.auth_modes.length}
          <p class="fine muted">
            Connexion : {p.auth_modes.map((m) => m.label + (m.app_only ? " (application Android)" : "")).join(" ou ")}.
          </p>
        {/if}

        {#each p.accounts as a (a.id)}
          <div class="acct">
            <div class="acct-h">
              <Icon name="user" size={15} />
              <span>{holderLine(a)}</span>
            </div>
            {#if a.editable}
              <WhoPicker
                value={a.grants["*"] || []}
                {groups}
                {users}
                holder={a.owner?.id}
                disabled={busy}
                on:change={(e) => setWho(p, a.id, "*", e.detail)} />
              <button class="more" aria-expanded={!!openFeatures[a.id]} on:click={() => (openFeatures[a.id] = !openFeatures[a.id])}>
                <Icon name={openFeatures[a.id] ? "chevronUp" : "chevronDown"} size={16} />
                Fonction par fonction
              </button>
              {#if openFeatures[a.id]}
                <div class="per">
                  {#each shared(p) as f (f.id)}
                    <div class="row">
                      <span class="fl">{f.label}</span>
                      <WhoPicker
                        inherit
                        value={a.grants[f.id] ?? null}
                        {groups}
                        {users}
                        holder={a.owner?.id}
                        disabled={busy}
                        label={"Qui peut : " + f.label}
                        on:change={(e) => setWho(p, a.id, f.id, e.detail)} />
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        {/each}

        {#if p.anonymous_use}
          <div class="acct">
            <div class="acct-h">
              <Icon name="eye" size={15} />
              <span>Sans compte</span>
            </div>
            {#if p.anonymous_use.editable}
              <WhoPicker
                value={p.anonymous_use.grants["*"] || []}
                {groups}
                {users}
                disabled={busy}
                on:change={(e) => setWho(p, "", "*", e.detail)} />
            {/if}
          </div>
        {/if}
      </article>
    {/each}

    {#if facts.length}
      <h3>Sources de faits</h3>
      <p class="muted fine">
        Elles ne donnent jamais de son&nbsp;: le serveur s'en sert, pour tout le monde, pour compléter
        les fiches de la bibliothèque.
      </p>
      <ul class="facts">
        {#each facts as p (p.id)}
          <li>
            <span class="nm">{p.name}</span>
            {#each p.features as f (f.id)}
              <span class="muted fine">{f.label}{#if f.fields.length}{"\u00a0: "}{f.fields.map((x) => x.label).join(", ")}{/if}</span>
            {/each}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if data?.admin}
  <section class="card">
    <h2>Groupes</h2>
    <p class="muted sub">
      Pour prêter un compte à plusieurs personnes d'un coup («&nbsp;Proches&nbsp;», «&nbsp;Famille&nbsp;»).
    </p>
    {#if groups.length}
      <ul class="groups">
        {#each groups as g (g.id)}
          <li>
            <div class="g-h">
              <span class="glyph sm"><Icon name="users" size={16} /></span>
              <span class="txt">
                <span class="nm">{g.name}</span>
                <span class="muted st">{g.members.length ? g.members.map((m) => m.name).join(", ") : "Personne pour l'instant"}</span>
              </span>
              <button class="ghost-btn" on:click={() => (editing = editing === g.id ? null : g.id)}>{editing === g.id ? "Fermer" : "Membres"}</button>
              {#if confirmDel === g.id}
                <button class="ghost-btn danger" on:click={() => removeGroup(g)}>Supprimer ?</button>
              {:else}
                <button class="icon-btn" aria-label="Supprimer le groupe {g.name}" title="Supprimer (ce qui lui était prêté ne l'est plus)" on:click={() => removeGroup(g)}><Icon name="trash" size={16} /></button>
              {/if}
            </div>
            {#if editing === g.id}
              <div class="chips">
                {#each users as u (u.id)}
                  {@const on = g.members.some((m) => m.id === u.id)}
                  <button type="button" class="chip" class:on aria-pressed={on} disabled={busy} on:click={() => toggleMember(g, u.id)}>
                    {#if on}<Icon name="check" size={14} />{:else}<Icon name="user" size={14} />{/if}<span>{u.name}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <form class="add" on:submit|preventDefault={addGroup}>
      <input type="text" bind:value={newGroup} placeholder="Nouveau groupe" maxlength="64" aria-label="Nom du nouveau groupe" />
      <button class="pill" type="submit" disabled={busy || !newGroup.trim()}>Créer</button>
    </form>
  </section>
{/if}

<style>
  .card {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 18px;
  }
  .card h2 {
    margin-top: 0;
    font-size: 1.05rem;
  }
  .card h3 {
    font-size: 0.9rem;
    font-weight: 700;
    margin: 24px 0 4px;
  }
  .sub {
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 4px 0 14px;
  }
  .fine {
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 8px 0 0;
  }
  .link {
    color: var(--accent);
    font-weight: 600;
  }
  .prov {
    padding: 16px 0 18px;
    border-top: 1px solid var(--bg-hover);
  }
  .prov:first-of-type {
    border-top: none;
    padding-top: 4px;
  }
  header,
  .g-h {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
  }
  .glyph {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--bg-hover);
    color: var(--accent);
  }
  .glyph.sm {
    width: 32px;
    height: 32px;
    color: var(--text-dim);
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nm {
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .tag {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
    border-radius: 6px;
    padding: 1px 6px;
  }
  .st {
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .feats {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .feats li {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px 5px 11px;
    border-radius: 8px;
    background: var(--bg);
    font-size: 0.8rem;
  }
  .need {
    font-size: 0.68rem;
    font-weight: 700;
    color: var(--text-dim);
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--bg-hover);
  }
  .need.acc {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .feats li.perso {
    outline: 1px dashed var(--bg-hover);
  }
  .acct {
    margin-top: 16px;
    padding: 14px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg) 55%, transparent);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .acct-h {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 0.88rem;
    color: var(--text);
    min-width: 0;
  }
  .acct-h span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: fit-content;
    min-height: 36px;
    padding: 6px 10px 6px 6px;
    border-radius: 8px;
    color: var(--text-dim);
    font-size: 0.82rem;
    font-weight: 600;
  }
  .more:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .per {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(140px, 200px) 1fr;
    gap: 12px;
    align-items: start;
  }
  .fl {
    font-size: 0.84rem;
    font-weight: 600;
    padding-top: 12px;
  }
  @media (max-width: 640px) {
    .row {
      grid-template-columns: 1fr;
      gap: 6px;
    }
    .fl {
      padding-top: 0;
    }
  }
  .facts,
  .groups {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .facts li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 0;
    border-top: 1px solid var(--bg-hover);
  }
  .facts li .fine {
    margin: 0;
  }
  .groups li {
    padding: 6px 0 10px;
    border-top: 1px solid var(--bg-hover);
  }
  .groups li:first-child {
    border-top: none;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 8px 0 4px 44px;
  }
  @media (max-width: 480px) {
    .chips {
      margin-left: 0;
    }
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 13px;
    min-height: 36px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-size: 0.84rem;
    font-weight: 600;
  }
  .chip.on {
    color: var(--accent);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .ghost-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    padding: 8px 15px;
    min-height: 36px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .ghost-btn:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .ghost-btn.danger {
    color: #ff6b6b;
    border-color: #ff6b6b;
  }
  .icon-btn {
    flex: none;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    color: var(--text-dim);
  }
  .icon-btn:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .add {
    display: flex;
    gap: 10px;
    margin-top: 14px;
    flex-wrap: wrap;
  }
  .add input {
    flex: 1 1 200px;
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--bg-hover);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 0.9rem;
  }
  .add input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .pill:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
