"""Optional AI providers.

The default provider is ``none``: the application only *exports* data and a
prompt which the user pastes into ChatGPT (or any other assistant) manually.
No ChatGPT login, cookies or unofficial APIs are used.

Optional providers (disabled by default) for direct analysis:
* ``ollama``             – local Ollama instance (/api/chat)
* ``openai_compatible``  – any server implementing the OpenAI chat completions
                           API (LM Studio, vLLM, LocalAI, OpenAI itself ...)
"""
from __future__ import annotations

from dataclasses import dataclass

import aiohttp


class ProviderError(Exception):
    pass


@dataclass
class ProviderInfo:
    id: str
    name: str
    enabled: bool
    direct: bool
    description: str


class BaseProvider:
    id = "none"
    name = "Nur Export (ChatGPT manuell)"
    direct = False

    def __init__(self, conf: dict):
        self.conf = conf

    def info(self) -> ProviderInfo:
        return ProviderInfo(self.id, self.name, True, self.direct,
                            "Daten und Prompt werden exportiert; die Übergabe an ChatGPT erfolgt durch Sie.")

    async def complete(self, system: str, prompt: str) -> str:
        raise ProviderError("Für diesen Anbieter ist keine direkte Analyse verfügbar – bitte Export verwenden.")


class OllamaProvider(BaseProvider):
    id = "ollama"
    name = "Ollama (lokal)"
    direct = True

    def info(self) -> ProviderInfo:
        return ProviderInfo(self.id, self.name, True, True, f"{self.conf.get('ollama_url')} · Modell {self.conf.get('ollama_model')}")

    async def complete(self, system: str, prompt: str) -> str:
        url = (self.conf.get("ollama_url") or "").rstrip("/") + "/api/chat"
        payload = {
            "model": self.conf.get("ollama_model") or "llama3.1",
            "stream": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        }
        timeout = aiohttp.ClientTimeout(total=float(self.conf.get("timeout_seconds") or 120))
        try:
            async with aiohttp.ClientSession(timeout=timeout) as s, s.post(url, json=payload) as r:
                if r.status != 200:
                    raise ProviderError(f"Ollama antwortete mit HTTP {r.status}: {(await r.text())[:300]}")
                data = await r.json()
        except aiohttp.ClientError as err:
            raise ProviderError(f"Ollama nicht erreichbar: {err}") from err
        return ((data.get("message") or {}).get("content") or "").strip()


class OpenAICompatibleProvider(BaseProvider):
    id = "openai_compatible"
    name = "OpenAI-kompatible API"
    direct = True

    def info(self) -> ProviderInfo:
        return ProviderInfo(self.id, self.name, True, True,
                            f"{self.conf.get('openai_base_url')} · Modell {self.conf.get('openai_model')}")

    async def complete(self, system: str, prompt: str) -> str:
        base = (self.conf.get("openai_base_url") or "").rstrip("/")
        if not base:
            raise ProviderError("Basis-URL fehlt")
        url = base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")
        headers = {}
        if self.conf.get("openai_api_key"):
            headers["Authorization"] = f"Bearer {self.conf['openai_api_key']}"
        payload = {
            "model": self.conf.get("openai_model") or "gpt-4o-mini",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        }
        timeout = aiohttp.ClientTimeout(total=float(self.conf.get("timeout_seconds") or 120))
        try:
            async with aiohttp.ClientSession(timeout=timeout) as s, s.post(url, json=payload, headers=headers) as r:
                if r.status != 200:
                    raise ProviderError(f"API antwortete mit HTTP {r.status}: {(await r.text())[:300]}")
                data = await r.json()
        except aiohttp.ClientError as err:
            raise ProviderError(f"API nicht erreichbar: {err}") from err
        try:
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, AttributeError) as err:
            raise ProviderError("Unerwartete Antwort der API") from err


PROVIDERS = {cls.id: cls for cls in (BaseProvider, OllamaProvider, OpenAICompatibleProvider)}


def get_provider(conf: dict) -> BaseProvider:
    cls = PROVIDERS.get(conf.get("provider") or "none", BaseProvider)
    return cls(conf)
