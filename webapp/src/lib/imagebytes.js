// Whether a stored picture is really broken, or was only refused.
//
// An <img> that fails reports a bare `error`, and the cover caches used to
// read every such error as "these bytes are corrupt" and delete them. That is
// right for a truncated write — and exactly wrong for everything else that
// makes an image fail: a Content-Security-Policy without `blob:` in img-src
// refused every cached cover this app painted, each one was deleted, fetched
// again on the next play, refused again, and so on for every track, for weeks.
//
// createImageBitmap decodes the bytes THEMSELVES. It fetches nothing, so no
// policy stands between it and the blob, and it rejects what is not a picture
// (measured in Chromium under the refusing policy: a JPEG decodes while the
// <img> showing it is refused; eight bytes of garbage are rejected). It
// answers the one question the cache has to ask before destroying something.

/**
 * Resolve true when `blob` holds a picture this browser can decode.
 *
 * An engine without createImageBitmap cannot tell, and answers false: the
 * caller then does what it always did, which is to drop the blob.
 */
export async function blobDecodes(blob) {
  if (!blob || !blob.size) return false;
  if (typeof createImageBitmap !== "function") return false;
  try {
    const bmp = await createImageBitmap(blob);
    // A decoded 1000px cover is 4 MB of pixels; nothing needs it past here.
    if (bmp && typeof bmp.close === "function") bmp.close();
    return true;
  } catch {
    return false;
  }
}
