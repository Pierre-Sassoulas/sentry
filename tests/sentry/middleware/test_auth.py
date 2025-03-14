import base64
from functools import cached_property
from typing import cast

from django.test import RequestFactory
from django.utils import timezone
from freezegun import freeze_time

from sentry.middleware.auth import AuthenticationMiddleware
from sentry.models import ApiKey, ApiToken, UserIP
from sentry.region_to_control.producer import (
    MockRegionToControlMessageService,
    region_to_control_message_service,
)
from sentry.services.hybrid_cloud.auth import AuthenticatedToken
from sentry.services.hybrid_cloud.user import user_service
from sentry.silo import SiloMode
from sentry.testutils import TestCase
from sentry.testutils.silo import all_silo_test, exempt_from_silo_limits
from sentry.utils.auth import login


@all_silo_test(stable=True)
class AuthenticationMiddlewareTestCase(TestCase):
    middleware = cached_property(AuthenticationMiddleware)

    def assert_user_equals(self, request):
        if SiloMode.get_current_mode() == SiloMode.MONOLITH:
            assert request.user == self.user
        else:
            assert request.user == user_service.serialize_user(self.user)

    def assert_user_ip(self, request):
        if SiloMode.get_current_mode() == SiloMode.REGION:
            cast(
                MockRegionToControlMessageService, region_to_control_message_service
            ).mock.write_region_to_control_message.assert_called_with(
                dict(
                    user_ip_event=dict(
                        user_id=self.user.id,
                        ip_address="127.0.0.1",
                        last_seen=timezone.now(),
                        country_code=None,
                        region_code=None,
                    ),
                    audit_log_event=None,
                ),
                False,
            )
            with exempt_from_silo_limits():
                assert not UserIP.objects.filter(user=self.user, ip_address="127.0.0.1").exists()
        else:
            # Force the user object to materialize
            request.user.id  # noqa
            assert UserIP.objects.filter(user=self.user, ip_address="127.0.0.1").exists()

    def setUp(self):
        from django.core.cache import cache

        cache.clear()
        yield
        cache.clear()

    @cached_property
    def request(self):
        rv = RequestFactory().get("/")
        rv.session = self.session
        return rv

    def test_process_request_anon(self):
        self.middleware.process_request(self.request)
        assert self.request.user.is_anonymous

    def test_process_request_user(self):
        request = self.request
        with exempt_from_silo_limits():
            assert login(request, self.user)
        with freeze_time("2000-01-01"):
            self.middleware.process_request(request)
            self.assert_user_ip(request)

        assert request.user.is_authenticated
        self.assert_user_equals(request)
        assert "_nonce" not in request.session

    def test_process_request_good_nonce(self):
        request = self.request
        user = self.user
        user.session_nonce = "xxx"
        with exempt_from_silo_limits():
            user.save()
            assert login(request, user)
        self.middleware.process_request(request)
        assert request.user.is_authenticated
        self.assert_user_equals(request)
        assert request.session["_nonce"] == "xxx"

    def test_process_request_missing_nonce(self):
        request = self.request
        user = self.user
        user.session_nonce = "xxx"
        with exempt_from_silo_limits():
            user.save()
            assert login(request, user)
        del request.session["_nonce"]
        self.middleware.process_request(request)
        assert request.user.is_anonymous

    def test_process_request_bad_nonce(self):
        request = self.request
        user = self.user
        user.session_nonce = "xxx"
        with exempt_from_silo_limits():
            user.save()
            assert login(request, user)
        request.session["_nonce"] = "gtfo"
        self.middleware.process_request(request)
        assert request.user.is_anonymous

    def test_process_request_valid_authtoken(self):
        with exempt_from_silo_limits():
            token = ApiToken.objects.create(user=self.user, scope_list=["event:read", "org:read"])
        request = self.make_request(method="GET")
        request.META["HTTP_AUTHORIZATION"] = f"Bearer {token.token}"
        self.middleware.process_request(request)
        self.assert_user_equals(request)
        assert AuthenticatedToken.from_token(request.auth) == AuthenticatedToken.from_token(token)

    def test_process_request_invalid_authtoken(self):
        request = self.make_request(method="GET")
        request.META["HTTP_AUTHORIZATION"] = "Bearer absadadafdf"
        self.middleware.process_request(request)
        # Should swallow errors and pass on
        assert request.user.is_anonymous
        assert request.auth is None

    def test_process_request_valid_apikey(self):
        with exempt_from_silo_limits():
            apikey = ApiKey.objects.create(organization=self.organization, allowed_origins="*")
            request = self.make_request(method="GET")
            request.META["HTTP_AUTHORIZATION"] = b"Basic " + base64.b64encode(
                apikey.key.encode("utf-8")
            )

        self.middleware.process_request(request)
        # ApiKey is tied to an organization not user
        assert request.user.is_anonymous
        assert AuthenticatedToken.from_token(request.auth) == AuthenticatedToken.from_token(apikey)

    def test_process_request_invalid_apikey(self):
        request = self.make_request(method="GET")
        request.META["HTTP_AUTHORIZATION"] = b"Basic adfasdfasdfsadfsaf"

        self.middleware.process_request(request)
        # Should swallow errors and pass on
        assert request.user.is_anonymous
        assert request.auth is None
