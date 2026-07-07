"""
Абстракция LLM-провайдера.

Режимы (env LLM_PROVIDER):
  openrouter — OpenAI-совместимый API, есть бесплатные модели (*:free).
  groq       — OpenAI-совместимый API, бесплатный tier.
  anthropic  — Anthropic Messages API (claude-*).
  none       — LLM не используется, работает экстрактивный фолбэк (см. pipeline).

Модель каждой роли задаётся своей env-переменной (см. agents.yaml → model_env),
поэтому роль можно переключить на другую модель без правки кода.
"""

import os

import httpx

PROVIDERS = {
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "default_model": "nvidia/nemotron-3-super-120b-a12b:free",
    },
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "default_model": "llama-3.3-70b-versatile",
    },
    "anthropic": {
        "url": "https://api.anthropic.com/v1/messages",
        "default_model": "claude-haiku-4-5-20251001",
    },
}


class LLMError(Exception):
    """Ошибка вызова модели (для отличия от прочих исключений в пайплайне)."""


class LLMClient:
    def __init__(self):
        self.provider = os.environ.get("LLM_PROVIDER", "none").strip().lower()
        self.api_key = os.environ.get("LLM_API_KEY", "").strip()

    @property
    def enabled(self) -> bool:
        return self.provider in PROVIDERS and bool(self.api_key)

    def model_for(self, model_env: str) -> str:
        """Модель роли из её env-переменной, иначе дефолт провайдера."""
        return (os.environ.get(model_env, "").strip()
                or PROVIDERS[self.provider]["default_model"])

    async def complete(self, model_env: str, system: str, user: str,
                       max_tokens: int = 3500) -> str:
        """Один вызов chat-completion с одним ретраем. Бросает LLMError."""
        cfg = PROVIDERS[self.provider]
        model = self.model_for(model_env)
        last_err = None
        for attempt in range(2):
            try:
                return await self._call(cfg, model, system, user, max_tokens)
            except Exception as e:  # сеть/лимиты/пустой ответ — пробуем ещё раз
                last_err = e
        raise LLMError(f"{model}: {type(last_err).__name__}: {last_err}")

    async def _call(self, cfg, model, system, user, max_tokens) -> str:
        async with httpx.AsyncClient(timeout=150) as client:
            if self.provider == "anthropic":
                resp = await client.post(cfg["url"], json={
                    "model": model, "max_tokens": max_tokens, "system": system,
                    "messages": [{"role": "user", "content": user}],
                }, headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                })
                resp.raise_for_status()
                return resp.json()["content"][0]["text"].strip()

            # OpenAI-совместимые (openrouter, groq)
            headers = {"Authorization": f"Bearer {self.api_key}"}
            if self.provider == "openrouter":
                headers["HTTP-Referer"] = "http://localhost:8080"
                headers["X-Title"] = "Machinarium Agents"
            resp = await client.post(cfg["url"], json={
                "model": model,
                "max_tokens": max_tokens,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            if "choices" not in data:  # OpenRouter возвращает ошибку 200-кодом
                raise LLMError(str(data.get("error", data))[:200])
            msg = data["choices"][0]["message"]
            # у reasoning-моделей ответ может быть в content, иначе — в reasoning
            text = (msg.get("content") or msg.get("reasoning") or "").strip()
            if not text:
                raise LLMError("пустой ответ модели")
            return text
