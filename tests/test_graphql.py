#!/usr/bin/env python
# coding: utf-8
#
# Unit tests for the Deezer GraphQL client's auth handling. The auth flow can't
# be exercised against live Deezer here, so these tests pin the two things that
# silently broke it before: the JWT comes back as a *text/plain* body (not a
# JSON wrapper), and a missing/expired JWT surfaces as a GraphQL error on an
# HTTP 200 response (so it must trigger a re-mint + retry, not only 401/403).

import unittest

from deezerpy.graphql import GraphQL, GraphQLError


# A realistic-looking compact JWT: three "ey..."-ish base64url segments.
FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlX2hlcmU"


class FakeResp:
    def __init__(self, *, text="", json_data=None, status=200):
        self.text = text
        self._json = json_data
        self.status_code = status

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError("HTTP %d" % self.status_code)


class FakeSession:
    """Stand-in for requests.Session recording calls and replaying scripts.

    Both the auth endpoints and the GraphQL endpoint are reached with POST, so
    we route by host: ``auth.deezer.com`` -> auth, ``pipe.deezer.com`` -> query.
    """

    def __init__(self, *, auth_resp=None, post_responses=None):
        self.auth_resp = auth_resp
        self.post_responses = list(post_responses or [])
        self.auth_calls = []
        self.post_calls = []

    def post(self, url, params=None, json=None, headers=None, timeout=None):
        if "auth.deezer.com" in url:
            self.auth_calls.append(("post", url))
            if isinstance(self.auth_resp, Exception):
                raise self.auth_resp
            return self.auth_resp
        self.post_calls.append({"headers": headers, "body": json})
        return self.post_responses.pop(0)


class ExtractJwtTest(unittest.TestCase):
    def test_plain_text_body(self):
        # The real endpoints answer with the raw token as text/plain.
        r = FakeResp(text=FAKE_JWT + "\n")
        self.assertEqual(GraphQL._extract_jwt(r), FAKE_JWT)

    def test_quoted_text_body(self):
        r = FakeResp(text='"' + FAKE_JWT + '"')
        self.assertEqual(GraphQL._extract_jwt(r), FAKE_JWT)

    def test_json_wrapper(self):
        r = FakeResp(text='{"jwt": "%s"}' % FAKE_JWT, json_data={"jwt": FAKE_JWT})
        self.assertEqual(GraphQL._extract_jwt(r), FAKE_JWT)

    def test_empty_body(self):
        self.assertIsNone(GraphQL._extract_jwt(FakeResp(text="")))

    def test_non_jwt_text(self):
        self.assertIsNone(GraphQL._extract_jwt(FakeResp(text="not a token")))


class JwtTokenTest(unittest.TestCase):
    def test_mints_from_plain_text(self):
        sess = FakeSession(auth_resp=FakeResp(text=FAKE_JWT))
        gql = GraphQL(sess, {})
        self.assertEqual(gql._jwt_token(), FAKE_JWT)
        # First attempt is the ARL bootstrap: POST /login/arl (GET 405s).
        self.assertEqual(sess.auth_calls[0][0], "post")
        self.assertIn("/login/arl", sess.auth_calls[0][1])

    def test_token_is_cached(self):
        sess = FakeSession(auth_resp=FakeResp(text=FAKE_JWT))
        gql = GraphQL(sess, {})
        gql._jwt_token()
        gql._jwt_token()
        self.assertEqual(len(sess.auth_calls), 1)  # not re-minted


class CallRetryTest(unittest.TestCase):
    def _gql(self, post_responses):
        sess = FakeSession(
            auth_resp=FakeResp(text=FAKE_JWT), post_responses=post_responses
        )
        return GraphQL(sess, {}), sess

    def test_retries_on_graphql_jwt_error(self):
        # HTTP 200 + JwtTokenMissingError on the first call, success on retry.
        err = FakeResp(
            json_data={
                "errors": [
                    {"message": "Jwt token is missing", "type": "JwtTokenMissingError"}
                ]
            }
        )
        ok = FakeResp(json_data={"data": {"flowConfig": {"id": "default"}}})
        gql, sess = self._gql([err, ok])
        data = gql.call("FlowConfig", "query {}", {})
        self.assertEqual(data, {"flowConfig": {"id": "default"}})
        self.assertEqual(len(sess.post_calls), 2)  # retried once
        # The retry must carry a Bearer token.
        self.assertTrue(
            sess.post_calls[1]["headers"]["Authorization"].startswith("Bearer ")
        )

    def test_non_jwt_error_is_raised(self):
        bad = FakeResp(
            json_data={"errors": [{"message": "nope", "type": "ValidationError"}]}
        )
        gql, sess = self._gql([bad])
        with self.assertRaises(GraphQLError):
            gql.call("FlowConfig", "query {}", {})
        self.assertEqual(len(sess.post_calls), 1)  # not retried

    def test_success_first_try(self):
        ok = FakeResp(json_data={"data": {"ok": True}})
        gql, sess = self._gql([ok])
        self.assertEqual(gql.call("X", "query {}", {}), {"ok": True})
        self.assertEqual(len(sess.post_calls), 1)


if __name__ == "__main__":
    unittest.main()
