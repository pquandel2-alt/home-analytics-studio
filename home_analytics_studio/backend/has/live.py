"""WebSocket hub pushing live states, connection status and job progress to browsers."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

from fastapi import WebSocket

if TYPE_CHECKING:
    from .services import Services

log = logging.getLogger(__name__)


class Client:
    def __init__(self, ws: WebSocket, principal):
        self.ws = ws
        self.principal = principal
        self.entities: set[str] = set()
        self.all_states = False
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=2000)


def slim_state(state: dict | None) -> dict | None:
    if state is None:
        return None
    attrs = state.get("attributes") or {}
    return {
        "entity_id": state.get("entity_id"),
        "state": state.get("state"),
        "last_changed": state.get("last_changed"),
        "last_updated": state.get("last_updated"),
        "attributes": {k: attrs[k] for k in ("unit_of_measurement", "friendly_name", "device_class", "state_class", "icon")
                       if k in attrs},
    }


class LiveHub:
    def __init__(self, services: "Services"):
        self.services = services
        self.clients: set[Client] = set()

    def publish_state(self, entity_id: str, state: dict | None) -> None:
        if not self.clients:
            return
        msg = None
        for c in list(self.clients):
            if c.all_states or entity_id in c.entities:
                if msg is None:
                    msg = {"type": "state", "entity_id": entity_id, "state": slim_state(state)}
                self._enqueue(c, msg)

    def broadcast(self, msg: dict) -> None:
        for c in list(self.clients):
            if msg.get("type") == "job" and c.principal.kind == "share":
                continue
            self._enqueue(c, msg)

    def _enqueue(self, c: Client, msg: dict) -> None:
        try:
            c.queue.put_nowait(msg)
        except asyncio.QueueFull:
            pass  # slow client: drop updates rather than blocking the event loop

    async def serve(self, ws: WebSocket, principal) -> None:
        await ws.accept()
        client = Client(ws, principal)
        self.clients.add(client)
        sender = asyncio.create_task(self._sender(client))
        try:
            await ws.send_text(json.dumps({"type": "hello", "user": principal.as_dict(),
                                           "ha_status": self.services.ha.status.as_dict()}))
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                await self._handle(client, msg)
        except Exception:  # noqa: BLE001 - disconnects
            pass
        finally:
            sender.cancel()
            self.clients.discard(client)

    async def _handle(self, client: Client, msg: dict[str, Any]) -> None:
        mtype = msg.get("type")
        if mtype == "subscribe":
            ids = [e for e in (msg.get("entities") or []) if isinstance(e, str)][:2000]
            client.entities.update(ids)
            states = {e: slim_state(self.services.ha.states.get(e)) for e in ids}
            self._enqueue(client, {"type": "states", "states": states})
        elif mtype == "unsubscribe":
            for e in msg.get("entities") or []:
                client.entities.discard(e)
        elif mtype == "ping":
            self._enqueue(client, {"type": "pong"})

    async def _sender(self, client: Client) -> None:
        while True:
            msg = await client.queue.get()
            batch = [msg]
            while not client.queue.empty() and len(batch) < 200:
                batch.append(client.queue.get_nowait())
            try:
                await client.ws.send_text(json.dumps(batch if len(batch) > 1 else batch[0], default=str))
            except Exception:  # noqa: BLE001
                return
