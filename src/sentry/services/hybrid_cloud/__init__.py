from __future__ import annotations

import contextlib
import inspect
import logging
import threading
from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, Generator, Generic, List, Mapping, Type, TypeVar, cast

logger = logging.getLogger(__name__)

from sentry.silo import SiloMode


class InterfaceWithLifecycle(ABC):
    @abstractmethod
    def close(self) -> None:
        pass


ServiceInterface = TypeVar("ServiceInterface", bound=InterfaceWithLifecycle)


class DelegatedBySiloMode(Generic[ServiceInterface]):
    """
    Using a mapping of silo modes to backing type classes that match the same ServiceInterface,
    delegate method calls to a singleton that is managed based on the current SiloMode.get_current_mode().
    This delegator is dynamic -- it knows to swap the backing implementation even when silo mode is overwritten
    during run time, or even via the stubbing methods in this module.

    It also supports lifecycle management by invoking close() on the backing implementation anytime either this
    service is closed, or when the backing service implementation changes.
    """

    _constructors: Mapping[SiloMode, Callable[[], ServiceInterface]]
    _singleton: Dict[SiloMode, ServiceInterface | None]
    _lock: threading.RLock

    def __init__(self, mapping: Mapping[SiloMode, Callable[[], ServiceInterface]]):
        self._constructors = mapping
        self._singleton = {}
        self._lock = threading.RLock()

    @contextlib.contextmanager
    def with_replacement(
        self, service: ServiceInterface | None, silo_mode: SiloMode
    ) -> Generator[None, None, None]:
        with self._lock:
            prev = self._singleton.get(silo_mode, None)
            self._singleton[silo_mode] = service
        try:
            yield
        finally:
            with self._lock:
                self.close(silo_mode)
                self._singleton[silo_mode] = prev

    def __getattr__(self, item: str) -> Any:
        cur_mode = SiloMode.get_current_mode()

        with self._lock:
            if impl := self._singleton.get(cur_mode, None):
                return getattr(impl, item)
            if con := self._constructors.get(cur_mode, None):
                self.close(cur_mode)
                self._singleton[cur_mode] = inst = con()
                return getattr(inst, item)

        raise KeyError(f"No implementation found for {cur_mode}.")

    def close(self, mode: SiloMode | None = None) -> None:
        to_close: List[ServiceInterface] = []
        with self._lock:
            if mode is None:
                to_close.extend(s for s in self._singleton.values() if s is not None)
                self._singleton = dict()
            else:
                existing = self._singleton.get(mode)
                if existing:
                    to_close.append(existing)
                self._singleton = self._singleton.copy()
                self._singleton[mode] = None

        for service in to_close:
            service.close()


hc_test_stub: Any = threading.local()


def CreateStubFromBase(
    base: Type[ServiceInterface], target_mode: SiloMode
) -> Type[ServiceInterface]:
    """
    Using a concrete implementation class of a service, creates a new concrete implementation class suitable for a test
    stub.  It retains parity with the given base by passing through all of its abstract method implementations to the
    given base class, but wraps it to run in the target silo mode, allowing tests written for monolith mode to largely
    work symmetrically.  In the future, however, when monolith mode separate is deprecated, this logic should be
    replaced by true mocking utilities, for say, target RPC endpoints.

    This implementation will not work outside of test contexts.
    """
    Super = base.__bases__[0]

    def __init__(self: Any, backing_service: ServiceInterface) -> None:
        self.backing_service = backing_service

    def close(self: Any) -> None:
        self.backing_service.close()

    def make_method(method_name: str) -> Any:
        def method(self: Any, *args: Any, **kwds: Any) -> Any:
            from sentry.services.hybrid_cloud.auth import AuthenticationContext

            with SiloMode.exit_single_process_silo_context():
                if cb := getattr(hc_test_stub, "cb", None):
                    cb(self.backing_service, method_name, *args, **kwds)
                method = getattr(self.backing_service, method_name)
                call_args = inspect.getcallargs(method, *args, **kwds)

                auth_context: AuthenticationContext = AuthenticationContext()
                if "auth_context" in call_args:
                    auth_context = call_args["auth_context"] or auth_context
                with auth_context.applied_to_request(), SiloMode.enter_single_process_silo_context(
                    target_mode
                ):
                    return method(*args, **kwds)

        return method

    methods = {
        name: make_method(name)
        for name in dir(Super)
        if getattr(getattr(Super, name), "__isabstractmethod__", False)
    }

    methods["close"] = close
    methods["__init__"] = __init__

    return cast(Type[ServiceInterface], type(f"Stub{Super.__name__}", (Super,), methods))


def stubbed(f: Callable[[], ServiceInterface], mode: SiloMode) -> Callable[[], ServiceInterface]:
    def factory() -> ServiceInterface:
        backing = f()
        return cast(ServiceInterface, cast(Any, CreateStubFromBase(type(backing), mode))(backing))

    return factory


def silo_mode_delegation(
    mapping: Mapping[SiloMode, Callable[[], ServiceInterface]]
) -> ServiceInterface:
    """
    Simply creates a DelegatedBySiloMode from a mapping object, but casts it as a ServiceInterface matching
    the mapping values.
    """
    return cast(ServiceInterface, DelegatedBySiloMode(mapping))
