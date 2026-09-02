from __future__ import annotations

import asyncio
import base64
import contextlib
import http
import logging
import signal
import time
from collections.abc import Awaitable, Callable

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK
from websockets.http11 import Request, Response

from compat.compat import install_runtime_compatibility_patches
from config.config import load_settings
from pipeline.pipeline import NoFaceFoundError, Pipeline
from protocol.protocol import dumps, parse_message
from service.service import FaceRecognitionService


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


logger = logging.getLogger("mira.pipeline")


async def _handle_pipeline_run(payload: dict[str, object], pipeline: Pipeline) -> str:
    session_id = payload.get("sessionId")
    session_str = session_id if isinstance(session_id, str) else ""
    t0 = time.perf_counter()

    try:
        image_field = payload.get("image")
        if not isinstance(image_field, dict):
            raise ValueError("Missing image field")

        data_field = image_field.get("data")  # type: ignore[attr-defined]
        if not isinstance(data_field, str) or not data_field:
            raise ValueError("Missing image data")

        image_bytes = base64.b64decode(data_field)
        logger.info(
            "[ws] pipeline.run received: session=%s %d bytes",
            session_str[:8] if session_str else "?",
            len(image_bytes),
        )
        result = await pipeline.run(image_bytes)
        logger.info(
            "[ws] pipeline.result sent: session=%s strategy=%s "
            "cacheHit=%s results=%d (%.0fms)",
            session_str[:8] if session_str else "?",
            result.anchor_strategy,
            result.cache_hit,
            len(result.results),
            (time.perf_counter() - t0) * 1000,
        )

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
                "cacheHit": bool(result.cache_hit),
                "inputFaceHash": result.input_face_hash_or_computed,
            }
        )
    except NoFaceFoundError as exc:
        logger.warning(
            "[ws] pipeline no-face: session=%s (%s)",
            session_str[:8] if session_str else "?",
            exc,
        )
        return dumps(
            {
                "type": "pipeline.result",
                "sessionId": session_str,
                "error": str(exc),
                "results": [],
                "anchorStrategy": "none",
                "enginesUsed": [],
                "cacheHit": False,
            }
        )
    except Exception as exc:
        logger.error(
            "[ws] pipeline ERROR: session=%s %s: %s",
            session_str[:8] if session_str else "?",
            exc.__class__.__name__,
            exc,
            exc_info=True,
        )
        return dumps(
            {
                "type": "pipeline.result",
                "sessionId": session_str,
                "error": f"{exc.__class__.__name__}: {exc}",
                "results": [],
                "anchorStrategy": "none",
                "enginesUsed": [],
                "cacheHit": False,
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
    # INFO logs for the whole pipeline (stages, engines, timings).
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    service = FaceRecognitionService(settings)
    pipeline = Pipeline(service, settings)
    websocket_logger = logging.getLogger("mira.websockets")
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
