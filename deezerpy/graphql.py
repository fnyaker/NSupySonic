"""Minimal client for Deezer's GraphQL endpoint (pipe.deezer.com).

Used for features the private gateway doesn't expose — notably the customizable
**Flow** (genre/style clusters you can enable/disable). Authenticates with the
existing ARL session: it first tries a short-lived JWT minted from the ARL
(``auth.deezer.com``) as a Bearer token, and otherwise falls back to the session
cookies. All calls are best-effort; callers should handle failures gracefully.
"""

from __future__ import annotations

from deezerpy._throttle import limiter

PIPE_URL = "https://pipe.deezer.com/api"
# The web app mints a short-lived JWT from the ARL session. Both endpoints are
# **POST** (``/login/arl`` answers 405 to GET) and return the raw JWT as a
# text/plain body (not a JSON wrapper). ``/login/arl`` bootstraps from the
# ``arl`` cookie and also drops a ``refresh-token`` cookie; ``/login/renew``
# then reuses that cookie (it 400s with "no refresh-token cookie found" if it
# was never bootstrapped), so we always try ``/login/arl`` first.
ARL_URL = "https://auth.deezer.com/login/arl"
RENEW_URL = "https://auth.deezer.com/login/renew"
AUTH_PARAMS = {"jo": "p", "rto": "c", "i": "c"}
# pipe.deezer.com / auth.deezer.com validate the browser origin.
ORIGIN = "https://www.deezer.com"
REFERER = "https://www.deezer.com/"

# Exact operations captured from the Deezer web app.
Q_CUSTOMIZABLE = """query CustomizableFlowConfig($flowConfigId: String!) {
  flowConfig(flowConfigId: $flowConfigId) {
    id
    hasCustomizableClusterConfigurations
    __typename
  }
}"""

Q_FLOW_CONFIG = """query FlowConfig($flowConfigId: String!, $filter: FlowConfigClusterFilter = ALL, $first: Int!, $cursor: String) {
  flowConfig(flowConfigId: $flowConfigId) {
    id
    title
    clusterConfigurations(filter: $filter, after: $cursor, first: $first) {
      pageInfo { endCursor hasNextPage __typename }
      edges { node { ...FlowConfigClusterConfiguration __typename } __typename }
      __typename
    }
    __typename
  }
}

fragment FlowConfigClusterConfiguration on FlowConfigClusterConfiguration {
  id
  isEnabled
  isEditedByUser
  cluster {
    id
    title
    artists {
      id
      name
      picture { ...PictureMedium __typename }
      __typename
    }
    __typename
  }
  __typename
}

fragment PictureMedium on Picture {
  id
  medium: urls(pictureRequest: {width: 264, height: 264})
  explicitStatus
  __typename
}"""

M_UPDATE_FLOW = """mutation UpdateFlowConfig($flowConfigId: String!, $clusters: [UpdateFlowConfigClusterConfigurationInput!]!) {
  updateFlowConfigClusters(input: {flowConfigId: $flowConfigId, clusters: $clusters}) {
    ... on UpdateFlowConfigClustersError { isInvalidFlowConfigId __typename }
    __typename
  }
}"""


class GraphQLError(Exception):
    pass


class GraphQL:
    def __init__(self, session, headers):
        self.session = session
        self.headers = headers
        self._jwt = None

    def _auth_headers(self):
        headers = dict(self.headers)
        headers["Origin"] = ORIGIN
        headers["Referer"] = REFERER
        return headers

    @staticmethod
    def _extract_jwt(resp):
        """Pull the JWT out of an auth.deezer.com response.

        The endpoints return the bare token as ``text/plain``; some deployments
        wrap it in JSON instead, so handle both.
        """
        body = (resp.text or "").strip()
        if not body:
            return None
        if body[:1] in "{[":
            try:
                obj = resp.json()
            except Exception:
                return None
            if isinstance(obj, dict):
                tok = (
                    obj.get("jwt")
                    or obj.get("jwtToken")
                    or (obj.get("results") or {}).get("jwt")
                )
                return tok.strip() if tok else None
            return None
        body = body.strip('"')
        # A JWT is three dot-separated base64url segments starting with "ey".
        if body.startswith("ey") and body.count(".") == 2:
            return body
        return None

    def _jwt_token(self):
        if self._jwt:
            return self._jwt
        headers = self._auth_headers()
        # Bootstrap from the ARL cookie first; fall back to the renew endpoint.
        # Both are POST (a GET to /login/arl is rejected with HTTP 405).
        for url in (ARL_URL, RENEW_URL):
            try:
                resp = self.session.post(
                    url, params=AUTH_PARAMS, headers=headers, timeout=(5, 10)
                )
            except Exception:
                continue
            token = self._extract_jwt(resp)
            if token:
                self._jwt = token
                return token
        return None

    @staticmethod
    def _is_jwt_error(errors):
        for err in errors or []:
            t = str(err.get("type") or "")
            xt = str((err.get("extensions") or {}).get("type") or "")
            if "jwt" in t.lower() or "jwt" in xt.lower():
                return True
        return False

    def call(self, operation_name, query, variables=None, _retry=True):
        limiter.acquire()
        headers = self._auth_headers()
        headers["Content-Type"] = "application/json"
        token = self._jwt_token()
        if token:
            headers["Authorization"] = "Bearer " + token
        body = {
            "operationName": operation_name,
            "query": query,
            "variables": variables or {},
        }
        resp = self.session.post(PIPE_URL, json=body, headers=headers, timeout=(5, 15))
        if resp.status_code in (401, 403) and _retry:
            self._jwt = None  # force a fresh token and retry once
            return self.call(operation_name, query, variables, _retry=False)
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("errors"):
            # The token endpoint answers HTTP 200, so an expired/missing JWT
            # surfaces as a GraphQL error — re-mint and retry once.
            if _retry and self._is_jwt_error(payload["errors"]):
                self._jwt = None
                return self.call(operation_name, query, variables, _retry=False)
            raise GraphQLError(str(payload["errors"])[:300])
        return payload.get("data") or {}

    # -- Flow customization ----------------------------------------------

    def is_flow_customizable(self, flow_config_id="default") -> bool:
        data = self.call(
            "CustomizableFlowConfig", Q_CUSTOMIZABLE, {"flowConfigId": flow_config_id}
        )
        cfg = (data or {}).get("flowConfig") or {}
        return bool(cfg.get("hasCustomizableClusterConfigurations"))

    def get_flow_clusters(self, flow_config_id="default") -> list:
        """All genre/style clusters with their enabled state."""
        out = []
        cursor = None
        for _ in range(10):  # safety bound on pagination
            data = self.call(
                "FlowConfig",
                Q_FLOW_CONFIG,
                {
                    "flowConfigId": flow_config_id,
                    "filter": "ALL",
                    "first": 50,
                    "cursor": cursor,
                },
            )
            cfg = (data or {}).get("flowConfig") or {}
            conns = cfg.get("clusterConfigurations") or {}
            for edge in conns.get("edges") or []:
                node = edge.get("node") or {}
                if node:
                    out.append(node)
            page = conns.get("pageInfo") or {}
            if not page.get("hasNextPage"):
                break
            cursor = page.get("endCursor")
        return out

    def update_flow_clusters(self, clusters, flow_config_id="default"):
        """`clusters` = [{clusterId, isEnabled, isEditedByUser}]."""
        return self.call(
            "UpdateFlowConfig",
            M_UPDATE_FLOW,
            {"flowConfigId": flow_config_id, "clusters": clusters},
        )
