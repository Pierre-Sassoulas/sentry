from datetime import timedelta

from django.urls import reverse
from rest_framework.exceptions import ErrorDetail

from sentry.testutils.cases import APITestCase, SnubaTestCase
from sentry.testutils.helpers.datetime import before_now, iso_format
from sentry.testutils.silo import region_silo_test
from sentry.utils.samples import load_data


@region_silo_test
class OrganizationEventsSpansHistogramEndpointTest(APITestCase, SnubaTestCase):
    URL = "sentry-api-0-organization-events-spans-count-histogram"

    def setUp(self):
        super().setUp()
        self.login_as(user=self.user)
        self.org = self.create_organization(owner=self.user)
        self.project = self.create_project(organization=self.org)
        self.url = reverse(
            self.URL,
            kwargs={"organization_slug": self.org.slug},
        )

        self.min_ago = before_now(minutes=1).replace(microsecond=0)

    def create_event(self, **kwargs):
        if "spans" not in kwargs:
            kwargs["spans"] = [
                {
                    "same_process_as_parent": True,
                    "parent_span_id": "a" * 16,
                    "span_id": x * 16,
                    "start_timestamp": iso_format(self.min_ago + timedelta(seconds=1)),
                    "timestamp": iso_format(self.min_ago + timedelta(seconds=4)),
                    "op": "django.middleware",
                    "description": "middleware span",
                    "hash": "cd" * 8,
                    "exclusive_time": 3.0,
                }
                for x in ["b", "c"]
            ] + [
                {
                    "same_process_as_parent": True,
                    "parent_span_id": "a" * 16,
                    "span_id": x * 16,
                    "start_timestamp": iso_format(self.min_ago + timedelta(seconds=4)),
                    "timestamp": iso_format(self.min_ago + timedelta(seconds=5)),
                    "op": "django.middleware",
                    "description": "middleware span",
                    "hash": "cd" * 8,
                    "exclusive_time": 10.0,
                }
                for x in ["d", "e", "f"]
            ]

        data = load_data("transaction", **kwargs)
        data["transaction"] = "root transaction"

        return self.store_event(data, project_id=self.project.id)

    def do_request(self, query):
        return self.client.get(self.url, query, format="json")

    def test_no_projects(self):
        query = {
            "projects": [-1],
            "spanOp": "django.middleware",
            "numBuckets": 50,
        }
        response = self.do_request(query)

        assert response.status_code == 200
        assert response.data == {}

    def test_bad_params_missing_span_op(self):
        query = {
            "project": [self.project.id],
            "numBuckets": 50,
        }

        response = self.do_request(query)

        assert response.status_code == 400
        assert response.data == {
            "spanOp": [ErrorDetail("This field is required.", code="required")]
        }

    def test_bad_params_missing_num_buckets(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
        }

        response = self.do_request(query)

        assert response.status_code == 400
        assert response.data == {
            "numBuckets": [ErrorDetail("This field is required.", code="required")]
        }

    def test_bad_params_invalid_num_buckets(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": "foo",
        }

        response = self.do_request(query)

        assert response.status_code == 400, "failing for numBuckets"
        assert response.data == {
            "numBuckets": ["A valid integer is required."]
        }, "failing for numBuckets"

    def test_bad_params_outside_range_num_buckets(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": -1,
        }

        response = self.do_request(query)

        assert response.status_code == 400, "failing for numBuckets"
        assert response.data == {
            "numBuckets": ["Ensure this value is greater than or equal to 1."]
        }, "failing for numBuckets"

    def test_bad_params_num_buckets_too_large(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": 101,
        }

        response = self.do_request(query)

        assert response.status_code == 400, "failing for numBuckets"
        assert response.data == {
            "numBuckets": ["Ensure this value is less than or equal to 100."]
        }, "failing for numBuckets"

    def test_bad_params_invalid_precision_too_small(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": 50,
            "precision": -1,
        }

        response = self.do_request(query)

        assert response.status_code == 400, "failing for precision"
        assert response.data == {
            "precision": ["Ensure this value is greater than or equal to 0."],
        }, "failing for precision"

    def test_bad_params_invalid_precision_too_big(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": 50,
            "precision": 100,
        }

        response = self.do_request(query)
        assert response.status_code == 400, "failing for precision"
        assert response.data == {
            "precision": ["Ensure this value is less than or equal to 4."],
        }, "failing for precision"

    def test_bad_params_reverse_min_max(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": 50,
            "min": 10,
            "max": 5,
        }

        response = self.do_request(query)
        assert response.data == {"non_field_errors": ["min must be less than max."]}

    def test_bad_params_invalid_min(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": 50,
            "min": "foo",
        }

        response = self.do_request(query)
        assert response.status_code == 400, "failing for min"
        assert response.data == {"min": ["A valid number is required."]}, "failing for min"

    def test_bad_params_invalid_max(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": 50,
            "max": "bar",
        }

        response = self.do_request(query)
        assert response.status_code == 400, "failing for max"
        assert response.data == {"max": ["A valid number is required."]}, "failing for max"

    def test_bad_params_invalid_data_filter(self):
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": 50,
            "dataFilter": "invalid",
        }

        response = self.do_request(query)
        assert response.status_code == 400, "failing for dataFilter"
        assert response.data == {
            "dataFilter": ['"invalid" is not a valid choice.']
        }, "failing for dataFilter"

    def test_histogram_empty(self):
        num_buckets = 5
        query = {
            "project": [self.project.id],
            "spanOp": "django.view",
            "numBuckets": num_buckets,
        }

        expected_empty_response = [{"bin": i, "count": 0} for i in range(num_buckets)]

        response = self.do_request(query)
        assert response.status_code == 200, response.content
        assert response.data == expected_empty_response

    def test_histogram(self):
        self.create_event()
        num_buckets = 50
        query = {
            "project": [self.project.id],
            "spanOp": "django.middleware",
            "numBuckets": num_buckets,
        }

        response = self.do_request(query)

        assert response.status_code == 200, response.content
        for bucket in response.data:
            if bucket["bin"] == 5:
                assert bucket["count"] == 1
            else:
                assert bucket["count"] == 0
