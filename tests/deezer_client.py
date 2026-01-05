import os
import asyncio
from streamrip.client import DeezerClient
from streamrip.config import Config
from streamrip.media import PendingAlbum
from streamrip.db import Dummy, Database


async def main():
    config = Config.defaults()
    arl = os.getenv("ARL")
    print("ARL:", arl)
    if not arl:
        print("Warning: ARL env var not set. Deezer may reject requests.")
    config.session.deezer.arl = arl
    c = DeezerClient(config)

    # login is asynchronous
    await c.login()
    # some clients expose a `logged_in` attribute after login
    logged = getattr(c, "logged_in", None)
    print("logged_in:", logged)

    db = Database(downloads=Dummy(), failed=Dummy())
    p = PendingAlbum("123456", c, config, db)

    # resolve is asynchronous
    resolved_album = await p.resolve()

    print("Resolved album:", resolved_album)
    # print metadata if available
    if hasattr(resolved_album, "meta"):
        meta = resolved_album.meta
        if meta is None:
            print("Resolved album has no meta (None)")
        else:
            # print a short summary of metadata keys to avoid huge dumps
            keys = None
            try:
                # Try common ways to get keys. Add type-ignore where static analysis
                # cannot determine concrete types.
                if hasattr(meta, "keys"):
                    # meta.keys may be a callable or a mapping method; attempt both
                    keys_attr = getattr(meta, "keys")
                    if callable(keys_attr):
                        keys = list(keys_attr())  # type: ignore
                    else:
                        keys = list(keys_attr)  # type: ignore
                elif isinstance(meta, dict):
                    keys = list(meta.keys())
                elif hasattr(meta, "__dict__"):
                    keys = list(getattr(meta, "__dict__", {}).keys())
                else:
                    keys = [k for k in dir(meta) if not k.startswith("_")]
            except Exception:
                keys = None
            print("Metadata keys:", keys)


if __name__ == "__main__":
    asyncio.run(main())
