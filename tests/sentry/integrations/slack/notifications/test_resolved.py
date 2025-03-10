from unittest import mock

import responses

from sentry.models import Activity
from sentry.notifications.notifications.activity import ResolvedActivityNotification
from sentry.testutils.cases import PerformanceIssueTestCase, SlackActivityNotificationTest
from sentry.testutils.helpers.notifications import TEST_ISSUE_OCCURRENCE
from sentry.testutils.helpers.slack import get_attachment, send_notification
from sentry.types.activity import ActivityType


class SlackResolvedNotificationTest(SlackActivityNotificationTest, PerformanceIssueTestCase):
    @responses.activate
    @mock.patch("sentry.notifications.notify.notify", side_effect=send_notification)
    def test_resolved(self, mock_func):
        """
        Test that a Slack message is sent with the expected payload when an issue is resolved
        """
        notification = ResolvedActivityNotification(
            Activity(
                project=self.project,
                group=self.group,
                user=self.user,
                type=ActivityType.SET_RESOLVED,
                data={"assignee": ""},
            )
        )
        with self.tasks():
            notification.send()

        attachment, text = get_attachment()
        assert (
            text
            == f"{self.name} marked <http://testserver/organizations/{self.organization.slug}/issues/{self.group.id}/?referrer=activity_notification|{self.short_id}> as resolved"
        )
        assert (
            attachment["footer"]
            == f"{self.project.slug} | <http://testserver/settings/account/notifications/workflow/?referrer=resolved_activity-slack-user|Notification Settings>"
        )

    @responses.activate
    @mock.patch("sentry.notifications.notify.notify", side_effect=send_notification)
    def test_resolved_performance_issue(self, mock_func):
        """
        Test that a Slack message is sent with the expected payload when a performance issue is resolved
        """
        event = self.create_performance_issue()
        notification = ResolvedActivityNotification(
            Activity(
                project=self.project,
                group=event.group,
                user=self.user,
                type=ActivityType.SET_RESOLVED,
                data={"assignee": ""},
            )
        )
        with self.tasks():
            notification.send()

        attachment, text = get_attachment()
        assert (
            text
            == f"{self.name} marked <http://testserver/organizations/{self.organization.slug}/issues/{event.group.id}/?referrer=activity_notification|{self.project.slug.upper()}-{event.group.short_id}> as resolved"
        )
        assert attachment["title"] == "N+1 Query"
        assert (
            attachment["text"]
            == "db - SELECT `books_author`.`id`, `books_author`.`name` FROM `books_author` WHERE `books_author`.`id` = %s LIMIT 21"
        )
        assert (
            attachment["footer"]
            == f"{self.project.slug} | production | <http://testserver/settings/account/notifications/workflow/?referrer=resolved_activity-slack-user|Notification Settings>"
        )

    @responses.activate
    @mock.patch(
        "sentry.eventstore.models.GroupEvent.occurrence",
        return_value=TEST_ISSUE_OCCURRENCE,
        new_callable=mock.PropertyMock,
    )
    @mock.patch("sentry.notifications.notify.notify", side_effect=send_notification)
    def test_resolved_generic_issue(self, mock_func, occurrence):
        """
        Test that a Slack message is sent with the expected payload when a generic issue type is resolved
        """
        event = self.store_event(
            data={"message": "Hellboy's world", "level": "error"}, project_id=self.project.id
        )
        event = event.for_group(event.groups[0])
        notification = ResolvedActivityNotification(
            Activity(
                project=self.project,
                group=event.group,
                user=self.user,
                type=ActivityType.SET_RESOLVED,
                data={"assignee": ""},
            )
        )
        with self.tasks():
            notification.send()

        attachment, text = get_attachment()
        assert (
            text
            == f"{self.name} marked <http://testserver/organizations/{self.organization.slug}/issues/{event.group.id}/?referrer=activity_notification|{self.project.slug.upper()}-{event.group.short_id}> as resolved"
        )
        assert attachment["title"] == TEST_ISSUE_OCCURRENCE.issue_title
        assert attachment["text"] == TEST_ISSUE_OCCURRENCE.evidence_display[0].value
        assert (
            attachment["footer"]
            == f"{self.project.slug} | <http://testserver/settings/account/notifications/workflow/?referrer=resolved_activity-slack-user|Notification Settings>"
        )
