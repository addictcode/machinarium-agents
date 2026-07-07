"""
Единая нормализованная событийная схема Машинариума.

Все сервисы (оркестратор, телеграм-бот, 3D-дашборд) общаются ТОЛЬКО через
Redis Stream событиями этого формата. Одна схема на всю систему.

Событие (плоский JSON в поле "data" записи стрима):
{
  "event_id":      "uuid",              # уникальный id события
  "ts":            1720000000.123,      # unix time (float)
  "task_id":       "uuid задачи",
  "agent_id":      "manager|analyst|developer|reviewer" | null,
  "status":        см. Status,
  "action":        "человекочитаемое описание действия",
  "tool_name":     "web_search|llm|..." | null,
  "tool_status":   "pending|in_progress|completed|error" | null,
  "output_preview":"первые ~200 символов результата" | null,
  "full_output":   "полный результат (может быть большим)" | null,
  "error_message": "текст ошибки при status=error" | null,
  "chat_id":       telegram chat id | null,   # для маршрутизации ответа
  "extra":         { ... }              # доп. поля: handoff from/to, level и т.п.
}
"""

import json
import time
import uuid

import redis.asyncio as aioredis

STREAM_MAXLEN = 2000  # стрим подрезается, чтобы не рос бесконечно


class Status:
    """Значения поля status (жизненный цикл задачи и агента)."""
    TASK_RECEIVED = "task_received"   # задача принята оркестратором
    STARTED = "started"               # агент проснулся и начал работу
    THINKING = "thinking"             # агент "думает" (перед вызовом модели)
    TOOL_CALLING = "tool_calling"     # агент вызвал инструмент
    WORKING = "working"               # агент выполняет основную работу
    HANDOFF = "handoff"               # передача результата другому агенту
    COMPLETED = "completed"           # агент завершил свою часть
    ERROR = "error"                   # ошибка у агента
    TASK_DONE = "task_done"           # вся задача завершена (есть финальный отчёт)
    TASK_ERROR = "task_error"         # вся задача упала


def make_event(task_id, status, agent_id=None, action="", tool_name=None,
               tool_status=None, output_preview=None, full_output=None,
               error_message=None, chat_id=None, extra=None):
    """Собрать событие в каноническом плоском формате."""
    return {
        "event_id": str(uuid.uuid4()),
        "ts": time.time(),
        "task_id": task_id,
        "agent_id": agent_id,
        "status": status,
        "action": action,
        "tool_name": tool_name,
        "tool_status": tool_status,
        "output_preview": (output_preview or "")[:200] or None,
        "full_output": full_output,
        "error_message": error_message,
        "chat_id": chat_id,
        "extra": extra or {},
    }


class EventBus:
    """Тонкая обёртка над Redis Stream: publish + подписка с блокирующим чтением."""

    def __init__(self, redis_url: str, stream: str):
        # socket_timeout > блокировки xread + keepalive: подписка не рвётся
        # на паузах между событиями (медленные LLM-ответы могут длиться минуты)
        self.redis = aioredis.from_url(
            redis_url, decode_responses=True,
            socket_timeout=60, socket_keepalive=True, health_check_interval=30)
        self.stream = stream

    async def publish(self, event: dict) -> None:
        await self.redis.xadd(
            self.stream,
            {"data": json.dumps(event, ensure_ascii=False)},
            maxlen=STREAM_MAXLEN,
            approximate=True,
        )

    async def subscribe(self, last_id: str = "$"):
        """Асинхронный генератор событий: yield (stream_id, event_dict).
        Устойчив к таймаутам сокета на длинных паузах между событиями."""
        while True:
            try:
                resp = await self.redis.xread({self.stream: last_id}, block=5000, count=50)
            except (TimeoutError, aioredis.RedisError, ConnectionError):
                continue  # временный обрыв/таймаут — пробуем снова, не роняем подписку
            for _stream, entries in resp or []:
                for entry_id, fields in entries:
                    last_id = entry_id
                    try:
                        event = json.loads(fields["data"])
                    except (KeyError, json.JSONDecodeError):
                        continue  # мусор в стриме молча пропускаем
                    if "status" not in event and "type" not in event:
                        continue  # событие чужой/старой схемы — игнорируем
                    yield entry_id, event

    async def close(self):
        await self.redis.aclose()
