import re
import requests
import json
from urllib.parse import urlsplit
from deezerpy.gw import GW
from deezerpy.api import API
from deezerpy.graphql import GraphQL
from deezerpy._circuit import breaker
from deezerpy.errors import (
    DeezerError,
    DeezerUnavailable,
    WrongLicense,
    WrongGeolocation,
)

__version__ = "1.3.7"

class TrackFormats():
    """Number associtation for formats"""
    FLAC    = 9
    MP3_320 = 3
    MP3_128 = 1
    MP4_RA3 = 15
    MP4_RA2 = 14
    MP4_RA1 = 13
    DEFAULT = 8
    LOCAL   = 0

# (connect, read) seconds applied to every Deezer request that doesn't ask for
# its own timeout. requests defaults to NO timeout at all, so a single silent
# TCP black hole (Deezer degraded, a dropped NAT entry) parked a server thread
# forever — enough of those and the whole app stops answering, which is exactly
# the "Deezer took the app down" failure mode.
#
# Both halves are deliberately tight. The connect half is what a real outage
# burns: Deezer's edge is a CDN, so it either accepts a TCP connection in a
# couple of seconds or it is not there — waiting 30 for that answer bought
# nothing and cost a worker thread. The read half is the gap BETWEEN bytes (not
# the total transfer), so 20s is generous even for a 4000-track playlist page.
# Long transfers (audio, episodes) pass their own timeout and are unaffected.
DEFAULT_TIMEOUT = (5, 20)

# Deezer talks to us over a handful of hosts, from up to a couple of dozen
# threads (web workers + prefetch + download + sync). Sized so the pool is not
# constantly opening and discarding sockets under that load.
_POOL_CONNECTIONS = 16
_POOL_MAXSIZE = 32


def request_host(url) -> str:
    """The hostname a request is aimed at, lowercased ("" if unparseable)."""
    try:
        return (urlsplit(str(url)).hostname or "").lower()
    except ValueError:
        return ""


class _Session(requests.Session):
    """A requests Session with a mandatory timeout and a per-host circuit breaker.

    Two guarantees, both about the app rather than about Deezer:

    - **no call blocks forever** — every request carries a timeout, even the
      ones that forgot to ask for one;
    - **no call blocks at all once a host is known to be down** — the breaker
      short-circuits it (``DeezerUnavailable``) instead of paying the timeout
      again, so an outage costs a handful of slow calls in total rather than one
      per request for as long as it lasts.
    """

    def __init__(self):
        super().__init__()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=_POOL_CONNECTIONS,
            pool_maxsize=_POOL_MAXSIZE,
            max_retries=0,  # retries are the callers' business, with a budget
        )
        self.mount("https://", adapter)
        self.mount("http://", adapter)

    def request(self, *args, **kwargs):
        if kwargs.get("timeout") is None:
            kwargs["timeout"] = DEFAULT_TIMEOUT
        url = kwargs.get("url") or (args[1] if len(args) > 1 else None)
        host = request_host(url)
        probe = breaker.before_request(host)  # raises while the host is down
        try:
            response = super().request(*args, **kwargs)
        except (requests.ConnectionError, requests.Timeout) as exc:
            breaker.on_failure(host, exc, probe)
            raise
        except Exception:
            # It answered; whatever went wrong afterwards is not reachability.
            breaker.on_success(host, probe)
            raise
        breaker.on_success(host, probe)
        return response


def new_session() -> _Session:
    """A session carrying this project's timeout and circuit breaker.

    Anything in the app that speaks HTTP on Deezer's behalf — including the
    per-fetch sessions the podcast SSRF pinning needs — starts here rather than
    with a bare ``requests.Session``, which has neither.
    """
    return _Session()


def _close_quietly(session) -> None:
    try:
        session.close()
    except Exception:
        pass


class Deezer:
    def __init__(self):
        self.http_headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " \
                          "Chrome/79.0.3945.130 Safari/537.36"
        }
        self.session = _Session()

        self.logged_in = False
        self.current_user = {}
        self.childs = []
        self.selected_account = 0

        self.api = API(self.session, self.http_headers)
        self.gw = GW(self.session, self.http_headers)
        self.gql = GraphQL(self.session, self.http_headers)

    def close(self):
        """Release this client's sockets. A re-login builds a whole new client,
        and the old one's pooled connections are file descriptors: leaving them
        to the garbage collector is how a long-running server runs out."""
        _close_quietly(self.session)

    def get_session(self):
        return {
            'logged_in': self.logged_in,
            'current_user': self.current_user,
            'childs': self.childs,
            'selected_account': self.selected_account,
            'cookies': self.session.cookies.get_dict()
        }

    def set_session(self, data):
        self.logged_in = data['logged_in']
        self.current_user = data['current_user']
        self.childs = data['childs']
        self.selected_account = data['selected_account']
        old, self.session = self.session, _Session()
        _close_quietly(old)
        self.session.cookies.update(data['cookies'])
        self.api.session = self.gw.session = self.gql.session = self.session

    def login(self, email, password, re_captcha_token, child=0):
        if child: child = int(child)
        # Check if user already logged in
        user_data = self.gw.get_user_data()
        if not user_data or user_data and len(user_data.keys()) == 0:
            self.logged_in = False
            return False
        if user_data['USER']['USER_ID'] == 0:
            self.logged_in = False
            return False
        # Get the checkFormLogin
        check_form_login = user_data['checkFormLogin']
        login = self.session.post(
            "https://www.deezer.com/ajax/action.php",
            data={
                'type': 'login',
                'mail': email,
                'password': password,
                'checkFormLogin': check_form_login,
                'reCaptchaToken': re_captcha_token
            },
            headers={'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', **self.http_headers}
        )
        # Check if user logged in
        if 'success' not in login.text:
            self.logged_in = False
            return False
        user_data = self.gw.get_user_data()
        self._post_login(user_data)
        self.change_account(child)
        self.logged_in = True
        return True

    def login_via_arl(self, arl, child=0):
        arl = arl.strip()
        if child: child = int(child)
        cookie_obj = requests.cookies.create_cookie(
            domain='.deezer.com',
            name='arl',
            value=arl,
            path="/",
            rest={'HttpOnly': True}
        )
        self.session.cookies.set_cookie(cookie_obj)
        user_data = self.gw.get_user_data()
        # Check if user logged in
        if not user_data or user_data and len(user_data.keys()) == 0:
            self.logged_in = False
            return False
        if user_data["USER"]["USER_ID"] == 0:
            self.logged_in = False
            return False
        self._post_login(user_data)
        self.change_account(child)
        self.logged_in = True
        return True

    def _post_login(self, user_data):
        self.childs = []
        family = user_data["USER"]["MULTI_ACCOUNT"]["ENABLED"] and not user_data["USER"]["MULTI_ACCOUNT"]["IS_SUB_ACCOUNT"]
        if family:
            childs = self.gw.get_child_accounts()
            for child in childs:
                if child['EXTRA_FAMILY']['IS_LOGGABLE_AS']:
                    self.childs.append({
                        'id': child["USER_ID"],
                        'name': child["BLOG_NAME"],
                        'picture': child.get("USER_PICTURE", ""),
                        'license_token': user_data["USER"]["OPTIONS"]["license_token"],
                        'can_stream_hq': user_data["USER"]["OPTIONS"]["web_hq"] or user_data["USER"]["OPTIONS"]["mobile_hq"],
                        'can_stream_lossless': user_data["USER"]["OPTIONS"]["web_lossless"] or user_data["USER"]["OPTIONS"]["mobile_lossless"],
                        'country': user_data["USER"]["OPTIONS"]["license_country"],
                        'language': user_data["USER"]["SETTING"]["global"].get("language", ""),
                        'loved_tracks': child.get("LOVEDTRACKS_ID")
                    })
        else:
            self.childs.append({
                'id': user_data["USER"]["USER_ID"],
                'name': user_data["USER"]["BLOG_NAME"],
                'picture': user_data["USER"].get("USER_PICTURE", ""),
                'license_token': user_data["USER"]["OPTIONS"]["license_token"],
                'can_stream_hq': user_data["USER"]["OPTIONS"]["web_hq"] or user_data["USER"]["OPTIONS"]["mobile_hq"],
                'can_stream_lossless': user_data["USER"]["OPTIONS"]["web_lossless"] or user_data["USER"]["OPTIONS"]["mobile_lossless"],
                'country': user_data["USER"]["OPTIONS"]["license_country"],
                'language': user_data["USER"]["SETTING"]["global"].get("language", ""),
                'loved_tracks': user_data["USER"].get("LOVEDTRACKS_ID")
            })

    def change_account(self, child_n):
        if len(self.childs)-1 < child_n: child_n = 0
        self.current_user = self.childs[child_n]
        self.selected_account = child_n
        lang = re.sub(r"[^0-9A-Za-z *,-.;=]", "", str(self.current_user['language']))
        if lang[2:1] == '-':
            lang = lang[0:5]
        else:
            lang = lang[0:2]
        self.http_headers["Accept-Language"] = re.sub(r"[^0-9A-Za-z *,-.;=]", "", str(self.current_user['language']))

        return (self.current_user, self.selected_account)

    def get_track_url(self, track_token, track_format):
        tracks = self.get_tracks_url([track_token, ], track_format)
        if len(tracks) > 0:
            if isinstance(tracks[0], DeezerError):
                raise tracks[0]
            else:
                return tracks[0]
        return None

    def get_tracks_url(self, track_tokens, track_format):
        if not isinstance(track_tokens, list):
            track_tokens = [track_tokens, ]
        if not self.current_user.get('license_token'):
            return []
        if (track_format == "FLAC" or track_format.startswith("MP4_RA")) and not self.current_user.get('can_stream_lossless') or track_format == "MP3_320" and not self.current_user.get('can_stream_hq'):
            raise WrongLicense(format)

        result = []
        try:
            request = self.session.post(
                "https://media.deezer.com/v1/get_url",
                json={
                    'license_token': self.current_user['license_token'],
                    'media': [{
                        'type': "FULL",
                        'formats': [
                            { 'cipher': "BF_CBC_STRIPE", 'format': track_format }
                        ]
                    }],
                    'track_tokens': track_tokens
                },
                headers = self.http_headers
            )
            if request.status_code == 429 or request.status_code >= 500:
                # media.deezer.com is unwell, not answering about the track.
                # Returning [] here made every quality resolve to "no URL",
                # which is what the caller reads as "this track has no source"
                # — an outage must never condemn a track.
                raise DeezerUnavailable(
                    f"media.deezer.com answered {request.status_code}"
                )
            request.raise_for_status()
            response = request.json()
        except requests.exceptions.HTTPError:
            return []
        except ValueError as exc:
            raise DeezerUnavailable("media.deezer.com returned a non-JSON body") from exc

        if len(response.get('data', [])):
            for data in response['data']:
                if 'errors' in data:
                    if data['errors'][0]['code'] == 2002:
                        result.append(WrongGeolocation(self.current_user['country']))
                    else:
                        result.append(DeezerError(json.dumps(response)))
                if 'media' in data and len(data['media']):
                    result.append(data['media'][0]['sources'][0]['url'])
                else:
                    result.append(None)
        return result
