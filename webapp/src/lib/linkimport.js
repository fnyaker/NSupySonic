// Shared playlist links (Deezer, Spotify, YouTube, Apple Music).
//
// Only RECOGNISES a link, to offer the import where one was pasted (the search
// box). The server parses it again and is the only judge of what it reads —
// see supysonic/linkimport.py.

const SERVICES = [
  { id: "deezer", label: "Deezer", host: /(^|\.)deezer\.com$/, path: /\/(playlist|album)\/\d+/ },
  { id: "deezer", label: "Deezer", host: /^(link\.deezer\.com|deezer\.page\.link|dzr\.page\.link)$/, path: /./ },
  { id: "spotify", label: "Spotify", host: /^(open|play)\.spotify\.com$/, path: /\/(playlist|album)\/[A-Za-z0-9]{22}/ },
  { id: "spotify", label: "Spotify", host: /^(spotify\.link|spoti\.fi)$/, path: /./ },
  { id: "youtube", label: "YouTube", host: /(^|\.)(youtube\.com|youtu\.be)$/, path: /[?&]list=|\/browse\/VL/ },
  { id: "apple", label: "Apple Music", host: /^(embed\.)?music\.apple\.com$/, path: /\/(playlist|album)\// },
];

const URL_RE = /(?:https?:\/\/|spotify:)[^\s"'<>]+/i;

/** `{ url, source, label }` for a playlist link in `text`, else null. */
export function playlistLink(text) {
  const m = URL_RE.exec(String(text || ""));
  if (!m) return null;
  const url = m[0].replace(/[).,;!?»]+$/, "");
  if (/^spotify:(playlist|album):[A-Za-z0-9]{22}$/i.test(url))
    return { url, source: "spotify", label: "Spotify" };
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const rest = u.pathname + u.search;
  for (const s of SERVICES) {
    if (s.host.test(host) && s.path.test(rest)) return { url, source: s.id, label: s.label };
  }
  return null;
}

/** The screen that imports it. */
export function importRoute(url) {
  return "#/import/" + encodeURIComponent(url);
}
