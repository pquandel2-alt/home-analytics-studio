"""ChatGPT export package and optional AI providers (tested against local fake servers)."""
import time

import pytest
from aiohttp import web

from has.ai.export import build_export
from has.ai.providers import BaseProvider, OllamaProvider, OpenAICompatibleProvider, ProviderError, get_provider
from has.core.analysis import AnalysisEngine
from has.core.engine import DataEngine


async def test_export_package_contains_real_values(db, settings, store):
    attrs = {"unit_of_measurement": "kWh", "state_class": "total_increasing"}
    store.set_recording(["sensor.e"], True, {"sensor.e": attrs})
    info = store.get("sensor.e")
    now = time.time()
    store.insert_samples(info.id, [((int(now) - 86400 * 3 + i * 3600) * 1000, float(i)) for i in range(72)])
    eng = DataEngine(db, store, settings)
    res = await build_export(eng, AnalysisEngine(eng), [{"type": "entity", "id": "sensor.e"}], "last_7d", "energy", "Warum?")
    item = res["package"]["items"][0]
    assert item["unit"] == "kWh" and item["range_value"] == pytest.approx(71, abs=1)
    assert item["series"]["points"]
    assert "Warum?" in res["prompt"] and "Einsparpotenziale" in res["prompt"]
    assert "```json" in res["prompt"] and "sensor.e" in res["markdown"]


async def _fake_server(handler, path):
    app = web.Application()
    app.router.add_post(path, handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


async def test_ollama_provider():
    async def h(req):
        body = await req.json()
        assert body["messages"][1]["content"] == "Hallo"
        return web.json_response({"message": {"content": "Antwort"}})
    runner, port = await _fake_server(h, "/api/chat")
    try:
        p = OllamaProvider({"ollama_url": f"http://127.0.0.1:{port}", "ollama_model": "m"})
        assert await p.complete("sys", "Hallo") == "Antwort"
    finally:
        await runner.cleanup()


async def test_openai_compatible_provider_and_errors():
    async def h(req):
        assert req.headers["Authorization"] == "Bearer k"
        return web.json_response({"choices": [{"message": {"content": " ok "}}]})
    runner, port = await _fake_server(h, "/v1/chat/completions")
    try:
        p = OpenAICompatibleProvider({"openai_base_url": f"http://127.0.0.1:{port}/v1", "openai_api_key": "k", "openai_model": "x"})
        assert await p.complete("s", "p") == "ok"
    finally:
        await runner.cleanup()
    with pytest.raises(ProviderError):
        await OllamaProvider({"ollama_url": "http://127.0.0.1:1", "timeout_seconds": 2}).complete("s", "p")


async def test_default_provider_is_export_only():
    p = get_provider({"provider": "none"})
    assert isinstance(p, BaseProvider) and not p.direct
    with pytest.raises(ProviderError):
        await p.complete("s", "p")
