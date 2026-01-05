import os
from streamrip.client import DeezerClient
from streamrip.config import Config
from streamrip.media import Album, PendingAlbum
from streamrip.db import Dummy, Database


config = Config.defaults()
arl = os.getenv("ARL")
print("ARL:", arl)
config.session.deezer.arl = arl
c = DeezerClient(config)

c.login()

