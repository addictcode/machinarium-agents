"""
Orchestrator + Dashboard backend (один FastAPI-процесс):

  POST /api/task  — постановка задачи (единственный HTTP-вход в систему)
  WS   /ws        — трансляция событий из Redis Stream в браузер как есть
                    (та же схема, что читает телеграм-бот)
  GET  /          — статика 3D-дашборда (команда роботов-агентов)
  GET  /2d/       — прежняя 2D-сцена (архив), /3d/ — интерактивная котельная
"""

import asyncio
import json
import os
import uuid

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from common.events import EventBus
from pipeline import LEVELS_KEY, Pipeline, load_agents
from tools import WORKSPACE, list_files

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
STREAM = os.environ.get("EVENTS_STREAM", "machinarium:events")
STATIC = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(WORKSPACE, exist_ok=True)  # папка мастерской агентов

app = FastAPI(title="Machinarium Orchestrator")
bus = EventBus(REDIS_URL, STREAM)
pipeline = Pipeline(bus)


class TaskIn(BaseModel):
    prompt: str
    chat_id: int | None = None  # телеграм-чат для ответа (если задача от бота)


@app.post("/api/task")
async def create_task(task: TaskIn):
    """Принять задачу и запустить пайплайн в фоне."""
    task_id = str(uuid.uuid4())
    asyncio.create_task(pipeline.run_task(task_id, task.prompt, task.chat_id))
    return {"task_id": task_id}


@app.get("/api/agents")
async def api_agents():
    """Список ролей (для внешних клиентов/отладки)."""
    return {"agents": load_agents()}


@app.get("/api/files/{task_id}")
async def api_files(task_id: str):
    """Список файлов, созданных агентами по задаче."""
    return {"task_id": task_id, "files": list_files(task_id)}


@app.websocket("/ws")
async def ws_events(ws: WebSocket):
    """Мост Redis Stream → браузер. При подключении шлём hello-снапшот:
    список агентов (для построения станций) и их текущие уровни."""
    await ws.accept()
    levels = await bus.redis.hgetall(LEVELS_KEY)
    await ws.send_text(json.dumps({
        "type": "hello",
        "agents": load_agents(),
        "levels": {k: int(v) for k, v in levels.items()},
    }, ensure_ascii=False))
    try:
        async for _id, event in bus.subscribe(last_id="$"):
            await ws.send_text(json.dumps(event, ensure_ascii=False))
    except (WebSocketDisconnect, RuntimeError):
        pass


# Файлы, созданные агентами (сгенерированный лендинг открывается в браузере).
# Монтируем ДО корня, чтобы /files не перекрылся общей статикой.
app.mount("/files", StaticFiles(directory=WORKSPACE, html=True), name="files")

# Статика дашборда на корне. Монтируем последним, чтобы не перекрыть /api и /ws.
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
