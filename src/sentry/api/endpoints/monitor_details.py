from __future__ import annotations

from django.db import transaction
from rest_framework.request import Request
from rest_framework.response import Response

from sentry import audit_log
from sentry.api.base import region_silo_endpoint
from sentry.api.bases.monitor import MonitorEndpoint
from sentry.api.serializers import serialize
from sentry.api.validators import MonitorValidator
from sentry.models import Monitor, MonitorStatus, ScheduledDeletion


@region_silo_endpoint
class MonitorDetailsEndpoint(MonitorEndpoint):
    def get(
        self, request: Request, project, monitor, organization_slug: str | None = None
    ) -> Response:
        """
        Retrieve a monitor
        ``````````````````

        :pparam string monitor_id: the id of the monitor.
        :auth: required
        """
        if organization_slug:
            if project.organization.slug != organization_slug:
                return self.respond_invalid()

        return self.respond(serialize(monitor, request.user))

    def put(
        self, request: Request, project, monitor, organization_slug: str | None = None
    ) -> Response:
        """
        Update a monitor
        ````````````````

        :pparam string monitor_id: the id of the monitor.
        :auth: required
        """
        if organization_slug:
            if project.organization.slug != organization_slug:
                return self.respond_invalid()

        validator = MonitorValidator(
            data=request.data,
            partial=True,
            instance={
                "name": monitor.name,
                "status": monitor.status,
                "type": monitor.type,
                "config": monitor.config,
                "project": project,
            },
            context={"organization": project.organization, "access": request.access},
        )
        if not validator.is_valid():
            return self.respond(validator.errors, status=400)

        result = validator.save()

        params = {}
        if "name" in result:
            params["name"] = result["name"]
        if "status" in result:
            if result["status"] == MonitorStatus.ACTIVE:
                if monitor.status not in (MonitorStatus.OK, MonitorStatus.ERROR):
                    params["status"] = MonitorStatus.ACTIVE
            else:
                params["status"] = result["status"]
        if "config" in result:
            params["config"] = result["config"]
        if "project" in result and result["project"].id != monitor.project_id:
            params["project_id"] = result["project"].id

        if params:
            monitor.update(**params)
            self.create_audit_entry(
                request=request,
                organization=project.organization,
                target_object=monitor.id,
                event=audit_log.get_event_id("MONITOR_EDIT"),
                data=monitor.get_audit_log_data(),
            )

        return self.respond(serialize(monitor, request.user))

    def delete(
        self, request: Request, project, monitor, organization_slug: str | None = None
    ) -> Response:
        """
        Delete a monitor
        ````````````````

        :pparam string monitor_id: the id of the monitor.
        :auth: required
        """
        if organization_slug:
            if project.organization.slug != organization_slug:
                return self.respond_invalid()

        with transaction.atomic():
            affected = (
                Monitor.objects.filter(id=monitor.id)
                .exclude(
                    status__in=[MonitorStatus.PENDING_DELETION, MonitorStatus.DELETION_IN_PROGRESS]
                )
                .update(status=MonitorStatus.PENDING_DELETION)
            )
            if not affected:
                return self.respond(status=404)

            schedule = ScheduledDeletion.schedule(monitor, days=0, actor=request.user)
            self.create_audit_entry(
                request=request,
                organization=project.organization,
                target_object=monitor.id,
                event=audit_log.get_event_id("MONITOR_REMOVE"),
                data=monitor.get_audit_log_data(),
                transaction_id=schedule.guid,
            )

        return self.respond(status=202)
