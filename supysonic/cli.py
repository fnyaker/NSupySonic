# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2023 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import click
import time

from click.exceptions import ClickException

from .config import IniConfig
from .daemon.client import DaemonClient
from .daemon.exceptions import DaemonUnavailableError
from .db import Folder, User, init_database, release_database
from .managers.folder import FolderManager
from .managers.user import UserManager
from .scanner import Scanner


class TimedProgressDisplay:
    def __init__(self, interval=5):
        self.__stdout = click.get_text_stream("stdout")
        self.__interval = interval
        self.__last_display = 0
        self.__last_len = 0

    def __call__(self, name, scanned):
        if time.time() - self.__last_display > self.__interval:
            progress = f"Scanning '{name}': {scanned} files scanned"
            self.__stdout.write("\b" * self.__last_len)
            self.__stdout.write(progress)
            self.__stdout.flush()

            self.__last_len = len(progress)
            self.__last_display = time.time()


@click.group()
def cli():
    """Supysonic management command line interface"""
    pass


@cli.group()
def folder():
    """Folder management commands"""
    pass


@folder.command("list")
def folder_list():
    """Lists folders."""

    click.echo("Name\t\tPath\n----\t\t----")
    for f in Folder.select().where(Folder.root):
        click.echo(f"{f.name: <16}{f.path}")


@folder.command("add")
@click.argument("name")
@click.argument(
    "path",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, resolve_path=True),
)
def folder_add(name, path):
    """Adds a folder.

    NAME can be anything but must be unique.
    PATH must point to an existing readable directory on the filesystem.

    If the daemon is running it will start to listen for changes in this folder but will
    not scan files already present in the folder.
    """

    try:
        FolderManager.add(name, path)
        click.echo(f"Folder '{name}' added")
    except ValueError as e:
        raise ClickException(str(e)) from e


@folder.command("delete")
@click.argument("name")
def folder_delete(name):
    """Deletes a folder.

    NAME is the name of the folder to delete.
    """

    try:
        FolderManager.delete_by_name(name)
        click.echo(f"Deleted folder '{name}'")
    except Folder.DoesNotExist as e:
        raise ClickException(f"Folder '{name}' does not exist.") from e


@folder.command("scan")
@click.argument(
    "folder",
    nargs=-1,
)
@click.option(
    "-f",
    "--force",
    is_flag=True,
    default=False,
    help="Force scan of already known files even if they haven't changed",
)
@click.option(
    "--background",
    "mode",
    flag_value="background",
    help="Scan the folder(s) in the background. Requires the daemon to be running.",
)
@click.option(
    "--foreground",
    "mode",
    flag_value="foreground",
    help="Scan the folder(s) in the foreground, blocking the processus while the scan is running.",
)
@click.pass_obj
def folder_scan(config, folder, force, mode):
    """Run a scan on specified folders.

    FOLDER is the name of the folder to scan. Multiple can be specified. If ommitted,
    all folders are scanned.
    """

    daemon = DaemonClient(config.DAEMON["socket"])

    # quick and dirty shorthand calls
    scan_bg = lambda: daemon.scan(folder, force)
    scan_fg = lambda: _folder_scan_foreground(config, daemon, folder, force)

    auto = not mode
    if auto:
        try:
            scan_bg()
        except DaemonUnavailableError:
            click.echo(
                "Couldn't connect to the daemon, scanning in foreground", err=True
            )
            scan_fg()
    elif mode == "background":
        try:
            scan_bg()
        except DaemonUnavailableError as e:
            raise ClickException(
                "Couldn't connect to the daemon, please use the '--foreground' option",
            ) from e
    elif mode == "foreground":
        scan_fg()


def _folder_scan_foreground(config, daemon, folders, force):
    try:
        progress = daemon.get_scanning_progress()
        if progress is not None:
            raise ClickException(
                "The daemon is currently scanning, can't start a scan now"
            )
    except DaemonUnavailableError:
        pass

    extensions = config.BASE["scanner_extensions"]
    if extensions:
        extensions = extensions.split(" ")

    def unwatch_folder(folder):
        try:
            daemon.remove_watched_folder(folder.path)
        except DaemonUnavailableError:
            pass

    def watch_folder(folder):
        try:
            daemon.add_watched_folder(folder.path)
        except DaemonUnavailableError:
            pass

    scanner = Scanner(
        force=force,
        extensions=extensions,
        follow_symlinks=config.BASE["follow_symlinks"],
        progress=TimedProgressDisplay(),
        on_folder_start=unwatch_folder,
        on_folder_end=watch_folder,
    )

    if folders:
        fstrs = folders
        folders = [
            f
            for f, in Folder.select(Folder.name)
            .where(Folder.root, Folder.name.in_(fstrs))
            .tuples()
        ]
        notfound = set(fstrs) - set(folders)
        if notfound:
            click.echo("No such folder(s): " + " ".join(notfound))
        for folder in folders:
            scanner.queue_folder(folder)
    else:
        for (folder,) in Folder.select(Folder.name).where(Folder.root).tuples():
            scanner.queue_folder(folder)

    scanner.run()
    stats = scanner.stats()

    click.echo("\nScanning done")
    click.echo(
        "Added: {0.artists} artists, {0.albums} albums, {0.tracks} tracks".format(
            stats.added
        )
    )
    click.echo(
        "Deleted: {0.artists} artists, {0.albums} albums, {0.tracks} tracks".format(
            stats.deleted
        )
    )
    if stats.errors:
        click.echo("Errors in:")
        for err in stats.errors:
            click.echo("- " + err)


@cli.group("user")
def user():
    """User management commands"""
    pass


@user.command("list")
def user_list():
    """Lists users."""

    click.echo("Name\t\tAdmin\tJukebox\tEmail")
    click.echo("----\t\t-----\t-------\t-----")
    for u in User.select():
        click.echo(
            "{: <16}{}\t{}\t{}".format(
                u.name, "*" if u.admin else "", "*" if u.jukebox else "", u.mail
            )
        )


@user.command("add")
@click.argument("name")
@click.password_option("-p", "--password", help="Specifies the user's password")
@click.option("-e", "--email", default="", help="Sets the user's email address")
def user_add(name, password, email):
    """Adds a new user.

    NAME is the name (or login) of the new user.
    """

    try:
        UserManager.add(name, password, mail=email)
    except ValueError as e:
        raise ClickException(str(e)) from e


@user.command("delete")
@click.argument("name")
def user_delete(name):
    """Deletes a user.

    NAME is the name of the user to delete.
    """

    try:
        UserManager.delete_by_name(name)
        click.echo(f"Deleted user '{name}'")
    except User.DoesNotExist as e:
        raise ClickException(f"User '{name}' does not exist.") from e


def _echo_role_change(username, name, value):
    click.echo(
        "{} '{}' {} rights".format("Granted" if value else "Revoked", username, name)
    )


@user.command("setroles")
@click.argument("name")
@click.option(
    "-A/-a", "--admin/--noadmin", default=None, help="Grant or revoke admin rights"
)
@click.option(
    "-J/-j",
    "--jukebox/--nojukebox",
    default=None,
    help="Grant or revoke jukebox rights",
)
def user_roles(name, admin, jukebox):
    """Enable/disable rights for a user.

    NAME is the login of the user to which grant or revoke rights.
    """

    try:
        user = User.get(name=name)
    except User.DoesNotExist as e:
        raise ClickException("No such user") from e

    if admin is not None:
        user.admin = admin
        _echo_role_change(name, "admin", admin)
    if jukebox is not None:
        user.jukebox = jukebox
        _echo_role_change(name, "jukebox", jukebox)
    user.save()


@user.command("changepass")
@click.argument("name")
@click.password_option("-p", "--password", help="New password")
def user_changepass(name, password):
    """Changes a user's password.

    NAME is the login of the user to which change the password.
    """

    try:
        UserManager.change_password2(name, password)
        click.echo(f"Successfully changed '{name}' password")
    except User.DoesNotExist as e:
        raise ClickException(f"User '{name}' does not exist.") from e


@user.command("rename")
@click.argument("name")
@click.argument("newname")
def user_rename(name, newname):
    """Renames a user.

    User NAME will then be known as NEWNAME.
    """

    if not name or not newname:
        raise ClickException("Missing user current name or new name")

    if name == newname:
        return

    try:
        user = User.get(name=name)
    except User.DoesNotExist as e:
        raise ClickException("No such user") from e

    try:
        User.get(name=newname)
        raise ClickException("This name is already taken")
    except User.DoesNotExist:
        pass

    user.name = newname
    user.save()
    click.echo(f"User '{name}' renamed to '{newname}'")


@cli.group("deezer")
def deezer():
    """Deezer proxy management commands"""
    pass


def _require_provider(config):
    from .deezer import get_provider

    provider = get_provider(config)
    if provider is None:
        raise ClickException(
            "Deezer proxy is disabled or misconfigured (check the [deezer] "
            "section: 'enabled', 'arl' and 'archive_dir')."
        )
    return provider


@deezer.command("login-test")
@click.pass_obj
def deezer_login_test(config):
    """Check that the configured ARL can log in to Deezer."""

    provider = _require_provider(config)
    try:
        provider.dz  # triggers the lazy login
    except Exception as e:
        raise ClickException(f"Login failed: {e}") from e

    click.echo(f"Logged in as '{provider.dz.current_user.get('name')}' (id {provider.user_id})")
    click.echo(f"Lossless (FLAC) available: {'yes' if provider.can_lossless else 'no'}")
    click.echo(f"Archive dir: {provider.archive_dir}")
    click.echo(f"Default quality: {provider.default_quality}")


@deezer.command("import")
@click.argument("ref")
@click.pass_obj
def deezer_import(config, ref):
    """Import a Deezer TRACK, ALBUM or PLAYLIST into the library.

    REF is a deezer.com URL or a 'track|album|playlist <id>' reference. The
    audio is fetched lazily on first play; this only imports the metadata.
    """

    provider = _require_provider(config)
    from .deezer.archive import (
        parse_deezer_ref,
        import_track,
        import_album,
        import_playlist_tracks,
    )

    try:
        kind, did = parse_deezer_ref(ref)
    except ValueError as e:
        raise ClickException(str(e)) from e

    try:
        if kind == "track":
            import_track(provider, did)
            click.echo(f"Imported track {did}")
        elif kind == "album":
            tracks = import_album(provider, did)
            click.echo(f"Imported album {did}: {len(tracks)} tracks")
        elif kind == "playlist":
            tracks = import_playlist_tracks(provider, did)
            click.echo(f"Imported playlist {did}: {len(tracks)} tracks")
        else:
            raise ClickException(f"Cannot import a Deezer {kind}")
    except Exception as e:
        raise ClickException(str(e)) from e


@deezer.command("sync")
@click.pass_obj
def deezer_sync(config):
    """Import Deezer playlists, favorites and recommendations into supysonic."""

    provider = _require_provider(config)
    cfg = config.DEEZER
    sync_user = cfg.get("sync_user")
    if not sync_user:
        raise ClickException("Set 'sync_user' in the [deezer] config to a supysonic username.")

    from .deezer.importer import DeezerImporter

    try:
        importer = DeezerImporter(provider, sync_user, progress=click.echo)
    except User.DoesNotExist as e:
        raise ClickException(
            f"sync_user '{sync_user}' does not exist (create it with 'supysonic-cli user add')."
        ) from e

    click.echo("Logging in to Deezer...")
    try:
        provider.dz  # trigger login now so failures surface immediately
    except Exception as e:
        raise ClickException(f"Deezer login failed: {e}") from e
    click.echo(f"Logged in as '{provider.dz.current_user.get('name')}'.")

    try:
        out = importer.sync(cfg)
    except Exception as e:
        raise ClickException(str(e)) from e

    if "playlists" in out:
        click.echo(f"Playlists synced: {out['playlists']}")
    if "favorites" in out:
        click.echo(f"Favorite tracks: {out['favorites']}")
    if "recommendations" in out:
        click.echo(f"Recommendations: {out['recommendations']}")


@deezer.command("scan-local")
@click.pass_obj
def deezer_scan_local(config):
    """Import user-dropped audio files from the archive dir as local tracks.

    Any audio file you copy into archive_dir becomes a normal library track
    (searchable, playlistable, streamable) tagged as local — the Deezer sync
    leaves it alone. Runs automatically on each sync too.
    """
    cfg = config.DEEZER
    archive = cfg.get("archive_dir")
    if not archive:
        raise ClickException("Set 'archive_dir' in the [deezer] config.")
    from .deezer import local

    out = local.scan_local(archive)
    click.echo(f"Local scan: {out['added']} added, {out['removed']} removed.")


def main():
    config = IniConfig.from_common_locations()
    init_database(config.BASE["database_uri"])
    try:
        cli.main(obj=config)
    finally:
        release_database()


if __name__ == "__main__":
    main()
