"""Entry point: runs the app on the ingress port and (optionally) the direct LAN port."""
from __future__ import annotations

import asyncio
import logging
import sys

import uvicorn

from .config import VERSION, load_config
from .services import LOG_BUFFER


def setup_logging(level: str) -> None:
    lvl = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(level=lvl, format="%(asctime)s %(levelname)s [%(name)s] %(message)s", stream=sys.stdout)
    LOG_BUFFER.setLevel(logging.INFO)
    logging.getLogger().addHandler(LOG_BUFFER)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


async def serve() -> None:
    from .app import create_app

    config = load_config()
    setup_logging(config.log_level)
    log = logging.getLogger("has")
    log.info("Home Analytics Studio %s startet (Daten: %s)", VERSION, config.data_dir)
    app = create_app(config)
    servers = []
    ports = [config.ingress_port]
    if config.direct_port and config.direct_port != config.ingress_port:
        ports.append(config.direct_port)
    for i, port in enumerate(ports):
        cfg = uvicorn.Config(app, host=config.host, port=port, log_level=config.log_level.lower(),
                             proxy_headers=config.trust_proxy_headers, forwarded_allow_ips="*" if config.trust_proxy_headers else None,
                             lifespan="on" if i == 0 else "off", ws_ping_interval=30, timeout_graceful_shutdown=5)
        servers.append(uvicorn.Server(cfg))
    for s in servers[1:]:
        s.install_signal_handlers = lambda: None  # type: ignore[method-assign]
    log.info("Ports: Ingress %s%s", config.ingress_port,
             f", Direktzugriff {config.direct_port}" if len(ports) > 1 else " (kein Direktport)")

    main = asyncio.create_task(servers[0].serve())
    # secondary listener starts after app lifespan completed
    while not servers[0].started and not main.done():
        await asyncio.sleep(0.05)
    others = [asyncio.create_task(s.serve()) for s in servers[1:]]
    await main
    for s in servers[1:]:
        s.should_exit = True
    if others:
        await asyncio.gather(*others, return_exceptions=True)


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "pre-backup":
        from .cli import pre_backup

        sys.exit(pre_backup())
    if len(sys.argv) > 1 and sys.argv[1] == "post-backup":
        from .cli import post_backup

        sys.exit(post_backup())
    asyncio.run(serve())


if __name__ == "__main__":
    main()
