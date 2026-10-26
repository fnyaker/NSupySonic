// The sources of sound and the place each holds: the main one, then the
// fallbacks in the order they are asked (server: webui/sourcesapi.py). The
// admin chooses that order in Réglages → Sources, so no screen writes a
// source's name for the role it plays ("Rien sur <main>", "Chercher aussi sur
// <fallback>"): it reads it here.
//
// The list comes with the person (`user.sources`, from /me and the login): no
// request of its own, and kept with the remembered session for an offline
// launch. A server that predates it says nothing; then the names are the ids,
// capitalised, and the screens that need a fallback offer none.
import { derived } from "svelte/store";
import { api } from "./api.js";
import { user } from "./stores.js";

const LOCAL = "Fichier local";

export function listOf(u) {
  return Array.isArray(u?.sources) ? u.sources : [];
}

export const sources = derived(user, ($u) => listOf($u));
// The same list for the plain functions below (a row's tooltip): read without
// a subscription per call.
let current = [];
user.subscribe(($u) => (current = listOf($u)));
export const mainSource = derived(sources, ($s) => $s.find((x) => x.place === "main") || null);
export const fallbackSources = derived(sources, ($s) =>
  $s.filter((x) => x.place === "fallback").sort((a, b) => a.rank - b.rank)
);

// The glyph of a source (Icon.svelte); one without its own gets a generic one.
const ICONS = { youtube: "youtube", local: "cloudOff" };
export const iconOf = (id) => ICONS[id] || "music";

const capital = (id) => (id ? String(id)[0].toUpperCase() + String(id).slice(1) : "");

// A source's name by its id, for a track's `source` field. Not reactive: names
// do not change while a screen is open, and a row reading a store would cost
// a subscription per row.
export function nameOf(id) {
  if (!id) return "";
  if (id === "local") return LOCAL;
  const hit = current.find((x) => x.id === id);
  return hit ? hit.name : capital(id);
}

// The badge's tooltip on a track a fallback delivers: where it comes from,
// and that the main source does not have it.
// Whether a track's `source` is a source other than the main one (and not a
// file of the library): what earns a row its badge.
export function offMain(id) {
  if (!id || id === "local" || !current.length) return false;
  const main = current.find((x) => x.place === "main");
  return !main || main.id !== id;
}

export function sourceTitle(id) {
  const main = current.find((x) => x.place === "main");
  if (id === "local") return main ? `Fichier local (pas sur ${main.name})` : "Fichier local";
  const name = nameOf(id);
  return main && main.id !== id ? `Source : ${name} (pas sur ${main.name})` : `Source : ${name}`;
}

// "Deezer", "Deezer puis YouTube", "Deezer, YouTube puis Qobuz": the order in
// which a title is looked for, in words.
export function chain(list) {
  const names = list.map((x) => x.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} puis ${names[names.length - 1]}`;
}

// After the admin saved the order: every screen follows at once.
function adopt(full) {
  const brief = (full?.sources || []).map(({ id, name, place, rank, quality }) => ({
    id,
    name,
    place,
    rank,
    quality: quality?.label || "",
    lossless: !!quality?.lossless,
  }));
  user.update((u) => (u ? { ...u, sources: brief } : u));
  return full;
}

export const loadSources = () => api.sources().then(adopt);
export const saveSources = (change) => api.setSources(change).then(adopt);
