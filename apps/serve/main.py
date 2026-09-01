from __future__ import annotations

import asyncio
import base64
import contextlib
import http
import logging
import signal
from collections.abc import Awaitable, Callable

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK
from websockets.http11 import Request, Response

from mira_serve import (
    FaceRecognitionService,
    install_runtime_compatibility_patches,
    load_settings,
)
from mira_serve.pipeline import NoFaceFoundError, Pipeline
from mira_serve.protocol import dumps, parse_message


class IgnoreInvalidUpgradeFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return record.getMessage() != "opening handshake failed"


async def handle_connection(
    websocket: ServerConnection,
    service: FaceRecognitionService,
    pipeline: Pipeline,
) -> None:
    try:
        await websocket.send(dumps(service.ready_message()))

        async for message in websocket:
            try:
                payload = parse_message(message)
            except Exception:
                response = await service.handle_raw_message(message)
                await websocket.send(response)
                continue

            if payload.get("type") == "pipeline.run":
                response = await _handle_pipeline_run(payload, pipeline)
                await websocket.send(response)
            else:
                response = await service.handle_raw_message(message)
                await websocket.send(response)
    except ConnectionClosedOK:
        return
    except ConnectionClosedError as error:
        print(
            "Mira serve websocket closed unexpectedly: "
            f"code={error.code} reason={error.reason!r}"
        )


async def _handle_pipeline_run(payload: dict[str, object], pipeline: Pipeline) -> str:
    session_id = payload.get("sessionId")
    session_str = session_id if isinstance(session_id, str) else ""

    try:
        image_field = payload.get("image")
        if not isinstance(image_field, dict):
            raise ValueError("Missing image field")

        data_field = image_field.get("data")  # type: ignore[attr-defined]
        if not isinstance(data_field, str) or not data_field:
            raise ValueError("Missing image data")

        image_bytes = base64.b64decode(data_field)
        result = await pipeline.run(image_bytes)

        return dumps(
            {
                "type": "pipeline.result",
                "sessionId": session_str,
                "face": {
                    "bbox": result.face.bbox,
                    "confidence": result.face.confidence,
                },
                "results": [r.to_protocol_dict() for r in result.results],
                "anchorStrategy": result.anchor_strategy,
                "enginesUsed": result.engines_used,
            }
        )
    except NoFaceFoundError as exc:
        return dumps(
            {
                "type": "pipeline.result",
                "sessionId": session_str,
                "error": str(exc),
                "results": [],
                "anchorStrategy": "none",
                "enginesUsed": [],
            }
        )
    except Exception as exc:
        return dumps(
            {
                "type": "pipeline.result",
                "sessionId": session_str,
                "error": f"{exc.__class__.__name__}: {exc}",
                "results": [],
                "anchorStrategy": "none",
                "enginesUsed": [],
            }
        )


def handle_process_request(
    service: FaceRecognitionService,
) -> Callable[[ServerConnection, Request], Awaitable[Response | None]]:
    async def process_request(
        connection: ServerConnection,
        request: Request,
    ) -> Response | None:
        if request.path == "/healthz":
            return connection.respond(http.HTTPStatus.OK, "ok\n")
        if request.path == "/admin/reload":
            changed = await service.refresh_enrollment()
            return connection.respond(
                http.HTTPStatus.OK,
                dumps(
                    {
                        "changed": changed,
                        "enrollment": service.ready_message()["enrollment"],
                        "status": "ok",
                    }
                ),
            )
        return None

    return process_request


async def main() -> None:
    install_runtime_compatibility_patches()
    settings = load_settings()
    service = FaceRecognitionService(settings)
    pipeline = Pipeline(service, settings)
    websocket_logger = logging.getLogger("mira_serve.websockets")
    websocket_logger.addFilter(IgnoreInvalidUpgradeFilter())
    await service.start()

    try:
        async with serve(
            lambda websocket: handle_connection(websocket, service, pipeline),
            settings.host,
            settings.port,
            logger=websocket_logger,
            max_size=8 * 1024 * 1024,
            process_request=handle_process_request(service),
        ) as server:
            loop = asyncio.get_running_loop()
            for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
                with contextlib.suppress(NotImplementedError):
                    loop.add_signal_handler(shutdown_signal, server.close)
            print(
                f"Mira serve listening on ws://{settings.host}:{settings.port} "
                f"(enrollment source: {settings.enrollment_sync_base_url or 'memory'})"
            )
            await server.wait_closed()
    finally:
        with contextlib.suppress(asyncio.CancelledError):
            await service.stop()
        with contextlib.suppress(Exception):
            await pipeline.aclose()


if __name__ == "__main__":
    asyncio.run(main())
