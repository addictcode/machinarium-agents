"""
Telegram-бот Машинариума (long polling, без вебхуков).

Сообщение пользователя → задача в оркестратор. Дальше бот слушает Redis-шину
и ведёт ОДНО живое сообщение на задачу, обновляя его через edit_message_text
(чтобы не спамить). По завершении — красивый финальный отчёт частями.
"""

import asyncio
import logging
import os
import time

import httpx
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import (Application, CommandHandler, ContextTypes,
                          MessageHandler, filters)

from common.events import EventBus, Status

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("bot")

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ORCHESTRATOR_URL = os.environ.get("ORCHESTRATOR_URL", "http://orchestrator:8080")
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
STREAM = os.environ.get("EVENTS_STREAM", "machinarium:events")

# Метаданные ролей (emoji/title) подтягиваем из оркестратора при старте
AGENTS: dict[str, dict] = {}
# Живое состояние по задачам: task_id -> {chat_id, message_id, lines, order, last_edit}
TASKS: dict[str, dict] = {}
EDIT_INTERVAL = 1.4  # сек между правками одного сообщения (лимит Telegram)

START_TEXT = (
    "⚙️ *Машинариум* — команда роботов-агентов к твоим услугам.\n\n"
    "Напиши задачу одним сообщением — например:\n"
    "_«Проанализируй конкурентов в нише SaaS-отслеживания, напиши план "
    "маркетинга и прототип лендинга с код-ревью»_\n\n"
    "Над задачей работают 4 агента: 🔵 Менеджер → 🟢 Аналитик → "
    "🔴 Разработчик → 🟣 Ревьюер.\n"
    "Следи за ними вживую в браузере: http://localhost:8080"
)

# Человекочитаемая фраза статуса для строки агента
STATUS_PHRASE = {
    Status.STARTED: "приступил к работе",
    Status.THINKING: "думает…",
    Status.WORKING: "работает",
    Status.COMPLETED: "готово ✅",
    Status.ERROR: "сбой ⚡",
}


# ------------------------------------------------------------ команды
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(START_TEXT, parse_mode=ParseMode.MARKDOWN,
                                    disable_web_page_preview=True)


async def on_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Любой текст = новая задача для команды агентов."""
    prompt = (update.message.text or "").strip()
    if not prompt:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(f"{ORCHESTRATOR_URL}/api/task", json={
                "prompt": prompt, "chat_id": update.effective_chat.id})
            resp.raise_for_status()
    except Exception as e:
        await update.message.reply_text(f"⚠️ Оркестратор недоступен: {e}")
        return
    await update.message.reply_text(
        "🏭 Задача принята! Роботы просыпаются…\n"
        "Смотри за ними: http://localhost:8080",
        disable_web_page_preview=True)


# --------------------------------------------------- рендер живого сообщения
def render(task: dict) -> str:
    """Собрать текст живого сообщения из строк по агентам (в порядке ролей)."""
    head = "🏭 *Команда агентов за работой*\n\n"
    body = []
    for aid in task["order"]:
        line = task["lines"].get(aid)
        if line:
            body.append(line)
    tail = task.get("tail", "")
    return head + "\n".join(body) + ("\n\n" + tail if tail else "")


def agent_label(aid: str) -> str:
    a = AGENTS.get(aid, {})
    return f"{a.get('emoji','⚙️')} {a.get('title', aid).upper()}"


def update_line(task: dict, ev: dict):
    """Обновить строку конкретного агента по событию."""
    aid = ev.get("agent_id")
    if not aid:
        return
    label = agent_label(aid)
    status = ev.get("status")
    action = ev.get("action", "")
    if status == Status.TOOL_CALLING:
        tool = ev.get("tool_name", "инструмент")
        mark = "⏳" if ev.get("tool_status") == "in_progress" else "✓"
        task["lines"][aid] = f"{label} — {mark} {action}"
    elif status in STATUS_PHRASE:
        task["lines"][aid] = f"{label} — {STATUS_PHRASE[status]}"
    else:
        task["lines"][aid] = f"{label} — {action}"


def chunks(text: str, size: int = 3900):
    """Порезать длинный отчёт на части по границам абзацев."""
    parts, cur = [], ""
    for para in text.split("\n\n"):
        if len(cur) + len(para) + 2 > size:
            if cur:
                parts.append(cur)
            cur = para
        else:
            cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        parts.append(cur)
    return parts


# ----------------------------------------------------- слушатель шины
async def flush(app: Application, task: dict, force=False):
    """Перерисовать живое сообщение с учётом лимита частоты правок."""
    now = time.time()
    if not force and now - task.get("last_edit", 0) < EDIT_INTERVAL:
        task["dirty"] = True
        return
    task["last_edit"] = now
    task["dirty"] = False
    try:
        await app.bot.edit_message_text(
            render(task), chat_id=task["chat_id"], message_id=task["message_id"],
            parse_mode=ParseMode.MARKDOWN, disable_web_page_preview=True)
    except Exception as e:
        if "not modified" not in str(e).lower():
            log.debug("edit failed: %s", e)


async def send_report(app: Application, chat_id: int, report: str):
    for part in chunks(report):
        try:
            await app.bot.send_message(chat_id, part, parse_mode=ParseMode.MARKDOWN,
                                       disable_web_page_preview=True)
        except Exception:
            await app.bot.send_message(chat_id, part, disable_web_page_preview=True)
        await asyncio.sleep(0.3)


async def relay_events(app: Application):
    """Фоновая подписка на шину: ведёт живое сообщение и шлёт финал."""
    bus = EventBus(REDIS_URL, STREAM)
    log.info("подписан на шину %s", STREAM)
    async for _id, ev in bus.subscribe(last_id="$"):
        tid = ev.get("task_id")
        status = ev.get("status")
        try:
            if status == Status.TASK_RECEIVED and ev.get("chat_id"):
                chat_id = ev["chat_id"]
                msg = await app.bot.send_message(chat_id, "🏭 Роботы просыпаются…")
                TASKS[tid] = {
                    "chat_id": chat_id, "message_id": msg.message_id,
                    "order": [a["name"] for a in AGENTS_ORDER],
                    "lines": {}, "last_edit": 0, "tail": "",
                }
                continue

            task = TASKS.get(tid)
            if not task:
                continue  # событие задачи, начатой не через бота

            if status in (Status.STARTED, Status.THINKING, Status.WORKING,
                          Status.TOOL_CALLING, Status.COMPLETED, Status.ERROR):
                update_line(task, ev)
                await flush(app, task, force=(status == Status.COMPLETED))
            elif status == Status.HANDOFF:
                task["tail"] = f"📦 {ev.get('action','')}"
                await flush(app, task)
            elif status == Status.TASK_DONE:
                task["tail"] = "✅ ВСЕ АГЕНТЫ ЗАВЕРШИЛИ РАБОТУ"
                await flush(app, task, force=True)
                report = ev.get("full_output") or "Готово."
                await send_report(app, task["chat_id"], report)
                TASKS.pop(tid, None)
            elif status == Status.TASK_ERROR:
                task["tail"] = f"💥 Задача упала: {ev.get('error_message','')}"
                await flush(app, task, force=True)
                TASKS.pop(tid, None)
        except Exception:
            log.exception("ошибка обработки события")


# фиксированный порядок агентов для строк сообщения
AGENTS_ORDER: list[dict] = []


async def post_init(app: Application):
    """Подтянуть метаданные ролей из оркестратора и запустить слушатель шины."""
    global AGENTS_ORDER
    for _ in range(30):  # ждём, пока оркестратор поднимется
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                data = (await client.get(f"{ORCHESTRATOR_URL}/api/agents")).json()
            AGENTS_ORDER = data["agents"]
            AGENTS.update({a["name"]: a for a in AGENTS_ORDER})
            log.info("роли загружены: %s", ", ".join(AGENTS))
            break
        except Exception:
            await asyncio.sleep(2)
    asyncio.create_task(relay_events(app))


def main():
    app = Application.builder().token(TOKEN).post_init(post_init).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))
    log.info("запускаю long polling")
    app.run_polling(allowed_updates=["message"])


if __name__ == "__main__":
    main()
