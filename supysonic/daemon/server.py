# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2019-2023 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import logging
import os
import stat
import sys
import time

from multiprocessing.connection import Listener, Client
from threading import Thread, Event

from .client import DaemonCommand
from ..db import Folder, open_connection, close_connection
from ..jukebox import Jukebox
from ..scanner import Scanner
from ..utils import get_secret_key
from ..watcher import SupysonicWatcher

__all__ = ["Daemon"]

logger = logging.getLogger(__name__)


class Daemon:
    def __init__(self, config):
        self.__config = config
        self.__listener = None
        self.__watcher = None
        self.__scanner = None
        self.__jukebox = None
        self.__stopped = Event()

    watcher = property(lambda self: self.__watcher)
    scanner = property(lambda self: self.__scanner)
    jukebox = property(lambda self: self.__jukebox)

    def __handle_connection(self, connection):
        cmd = connection.recv()
        logger.debug("Received %s", cmd)
        if cmd is None:
            pass
        elif isinstance(cmd, DaemonCommand):
            cmd.apply(connection, self)
        else:
            logger.warning("Received unknown command %s", cmd)

    @staticmethod
    def __secure_socket_dir(address):
        """Make sure the socket lives somewhere only we can reach.

        multiprocessing.connection deserialises with pickle *before* any type
        check, so anyone who can connect and authenticate gets code execution.
        The authkey is the real gate, but the default socket path sits under a
        shared /tmp — where a local user could otherwise pre-create the
        directory and sit in the middle.

        If the directory doesn't exist yet, we create it 0700 (now ours). If it
        already exists and we don't own it, it's only acceptable when it's not
        writable by others, or when it IS writable but carries the sticky bit
        (like /tmp itself: sticky means another user can create entries but
        can't delete/rename ours out from under us — the standard safe pattern
        for a shared temp root, and not itself the vulnerability).
        """
        if sys.platform == "win32" or not address or address.startswith("\\\\"):
            return  # named pipe: no filesystem directory involved
        directory = os.path.dirname(os.path.abspath(address))
        if not directory:
            return
        if not os.path.isdir(directory):
            os.makedirs(directory, mode=0o700, exist_ok=True)
        st = os.stat(directory)
        if st.st_uid == os.getuid():
            if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
                os.chmod(directory, 0o700)
        else:
            world_writable = bool(st.st_mode & (stat.S_IWGRP | stat.S_IWOTH))
            sticky = bool(st.st_mode & stat.S_ISVTX)
            if world_writable and not sticky:
                raise RuntimeError(
                    f"Refusing to listen in {directory}: it belongs to another "
                    "user and is writable without the sticky bit. Point "
                    "[daemon] socket at a directory you own (e.g. /run/supysonic)."
                )
        # A stale socket from a previous run would make bind() fail.
        if os.path.exists(address) and stat.S_ISSOCK(os.stat(address).st_mode):
            os.unlink(address)

    def run(self):
        address = self.__config.DAEMON["socket"]
        self.__secure_socket_dir(address)
        old_umask = os.umask(0o077)
        try:
            self.__listener = Listener(
                address=address, authkey=get_secret_key("daemon_key")
            )
        finally:
            os.umask(old_umask)
        logger.info("Listening to %s", self.__listener.address)

        if self.__config.DAEMON["run_watcher"]:
            self.__watcher = SupysonicWatcher(self.__config)
            self.__watcher.start()

        if self.__config.DAEMON["jukebox_command"]:
            self.__jukebox = Jukebox(self.__config.DAEMON["jukebox_command"])

        close_connection()

        Thread(target=self.__listen).start()
        while not self.__stopped.is_set():
            time.sleep(1)

    def __listen(self):
        while not self.__stopped.is_set():
            conn = self.__listener.accept()
            self.__handle_connection(conn)

        self.__listener.close()

    def start_scan(self, folders=[], force=False):
        if not folders:
            open_connection()
            folders = [
                t[0] for t in Folder.select(Folder.name).where(Folder.root).tuples()
            ]
            close_connection()

        if self.__scanner is not None and self.__scanner.is_alive():
            for f in folders:
                self.__scanner.queue_folder(f)
            return

        extensions = self.__config.BASE["scanner_extensions"]
        if extensions:
            extensions = extensions.split(" ")

        self.__scanner = Scanner(
            force=force,
            extensions=extensions,
            follow_symlinks=self.__config.BASE["follow_symlinks"],
            on_folder_start=self.__unwatch,
            on_folder_end=self.__watch,
        )
        for f in folders:
            self.__scanner.queue_folder(f)

        self.__scanner.start()

    def __watch(self, folder):
        if self.__watcher is not None:
            self.__watcher.add_folder(folder.path)

    def __unwatch(self, folder):
        if self.__watcher is not None:
            self.__watcher.remove_folder(folder.path)

    def terminate(self):
        with Client(self.__listener.address, authkey=self.__listener._authkey) as c:
            self.__stopped.set()
            c.send(None)

        if self.__scanner is not None:
            self.__scanner.stop()
            self.__scanner.join()
        if self.__watcher is not None:
            self.__watcher.stop()
        if self.__jukebox is not None:
            self.__jukebox.terminate()
