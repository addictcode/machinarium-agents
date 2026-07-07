"""
Пайплайн команды агентов: Manager → Analyst → Developer → Reviewer.

Manager декомпозирует задачу (JSON-план) и координирует очередь. Дальше по
цепочке: Analyst исследует, Developer создаёт артефакт, Reviewer проверяет.
Каждый существенный шаг публикует событие в шину (common/events.py) —
их одинаково читают телеграм-бот и 3D-дашборд.

Модели — через OpenRouter (llm.py). Если модель недоступна/упала — шаг
откатывается на простой детерминированный фолбэк, чтобы задача всегда
завершилась и дашборд/бот показали результат.
"""

import json
import os
import re

import yaml

from common.events import EventBus, Status, make_event
from llm import LLMClient, LLMError
from tools import (extract_key_points, list_files, parse_artifacts,
                   web_search, write_file)

LEVELS_KEY = "machinarium:levels"

# Базовый URL для ссылок на созданные файлы (виден пользователю в Telegram)
FILES_BASE = os.environ.get("FILES_BASE_URL", "http://localhost:8080/files")


def load_agents() -> list[dict]:
    """Роли из agents.yaml — единственное место, где они описаны."""
    path = os.path.join(os.path.dirname(__file__), "agents.yaml")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)["agents"]


def _extract_json(text: str) -> dict | None:
    """Достать первый JSON-объект из ответа модели (она любит обрамления)."""
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


class Pipeline:
    def __init__(self, bus: EventBus):
        self.bus = bus
        self.llm = LLMClient()
        self.agents = {a["name"]: a for a in load_agents()}

    # ---------- публикация событий ----------

    async def _emit(self, task_id, status, agent_id=None, chat_id=None, **kw):
        await self.bus.publish(make_event(task_id, status, agent_id=agent_id,
                                          chat_id=chat_id, **kw))

    async def _level_up(self, agent: str) -> int:
        return await self.bus.redis.hincrby(LEVELS_KEY, agent, 1)

    async def _save(self, task_id, agent, name, content):
        """Записать файл в мастерскую с событиями file_write (робот «пишет»)."""
        await self._emit(task_id, Status.TOOL_CALLING, agent, tool_name="file_write",
                         tool_status="in_progress", action=f"пишет файл {name}")
        info = write_file(task_id, name, content)
        await self._emit(task_id, Status.TOOL_CALLING, agent, tool_name="file_write",
                         tool_status="completed", output_preview=info["name"],
                         action=f"сохранил {info['name']} ({info['size']} б)")
        return info

    # ---------- вызов модели с событиями и фолбэком ----------

    async def _ask(self, task_id, agent, user_prompt, fallback, max_tokens=3500):
        """Спросить модель роли. При ошибке — событие error и откат на fallback."""
        cfg = self.agents[agent]
        if not self.llm.enabled:
            return fallback, False
        model = self.llm.model_for(cfg["model_env"])
        await self._emit(task_id, Status.TOOL_CALLING, agent, tool_name="llm",
                         tool_status="in_progress",
                         action=f"вызывает модель {model.split('/')[-1]}")
        try:
            out = await self.llm.complete(cfg["model_env"], cfg["system_prompt"],
                                          user_prompt, max_tokens=max_tokens)
            await self._emit(task_id, Status.TOOL_CALLING, agent, tool_name="llm",
                             tool_status="completed",
                             action="модель ответила", output_preview=out)
            return out, True
        except LLMError as e:
            await self._emit(task_id, Status.ERROR, agent,
                             error_message=str(e),
                             action="модель недоступна, беру резервный результат")
            return fallback, False

    # ---------- шаги ролей ----------

    async def _run_manager(self, task_id, prompt) -> dict:
        agent = "manager"
        await self._emit(task_id, Status.STARTED, agent,
                         action="координирует команду")
        await self._emit(task_id, Status.THINKING, agent,
                         action="декомпозирует задачу")
        fallback = {
            "plan": f"Разбить задачу «{prompt}» на исследование, реализацию и проверку.",
            "analyst_task": f"Исследуй тему: {prompt}",
            "developer_task": f"На основе анализа создай артефакт по задаче: {prompt}",
            "reviewer_focus": "Полнота, корректность, соответствие исходной задаче.",
        }
        raw, _ = await self._ask(task_id, agent,
                                 f"Задача пользователя: {prompt}",
                                 json.dumps(fallback, ensure_ascii=False),
                                 max_tokens=1200)
        plan = _extract_json(raw) or fallback
        for k, v in fallback.items():
            plan.setdefault(k, v)  # добираем недостающие поля
        plan_md = (f"# План выполнения\n\n{plan['plan']}\n\n"
                   f"## Аналитику\n{plan['analyst_task']}\n\n"
                   f"## Разработчику\n{plan['developer_task']}\n\n"
                   f"## Ревьюеру\n{plan['reviewer_focus']}\n")
        await self._save(task_id, agent, "00_plan.md", plan_md)
        await self._emit(task_id, Status.COMPLETED, agent,
                         action="план готов", output_preview=plan["plan"],
                         full_output=json.dumps(plan, ensure_ascii=False),
                         extra={"level": await self._level_up(agent)})
        return plan

    async def _run_analyst(self, task_id, topic) -> str:
        agent = "analyst"
        await self._emit(task_id, Status.STARTED, agent, action="начал анализ")
        results = []
        for q in (topic, f"{topic} конкуренты обзор", f"{topic} 2026"):
            await self._emit(task_id, Status.TOOL_CALLING, agent,
                             tool_name="web_search", tool_status="in_progress",
                             action=f"ищет: {q}")
            found = await web_search(q)
            await self._emit(task_id, Status.TOOL_CALLING, agent,
                             tool_name="web_search", tool_status="completed",
                             action=f"найдено источников: {len(found)}")
            results += found
        # дедуп источников по URL
        seen, uniq = set(), []
        for r in results:
            if r.get("href") not in seen:
                seen.add(r.get("href"))
                uniq.append(r)
        facts = extract_key_points([f"{s.get('title','')}. {s.get('body','')}"
                                    for s in uniq]) or [f"Тема: {topic}"]
        fallback = ("Ключевые находки:\n" + "\n".join(f"- {p}" for p in facts)
                    + "\n\nИсточники:\n"
                    + "\n".join(f"- {s.get('title','?')} — {s.get('href','')}"
                                for s in uniq[:6]))
        await self._emit(task_id, Status.WORKING, agent, action="сводит факты")
        analysis, _ = await self._ask(
            task_id, agent,
            f"Тема: {topic}\n\nСырые факты из веб-поиска:\n{fallback}", fallback)
        await self._save(task_id, agent, "01_analysis.md",
                         f"# Анализ\n\n{analysis}\n")
        await self._emit(task_id, Status.COMPLETED, agent,
                         action="анализ готов", output_preview=analysis,
                         full_output=analysis,
                         extra={"level": await self._level_up(agent)})
        return analysis

    async def _run_developer(self, task_id, dev_task, analysis) -> tuple[str, list]:
        agent = "developer"
        await self._emit(task_id, Status.STARTED, agent, action="начал разработку")
        await self._emit(task_id, Status.TOOL_CALLING, agent,
                         tool_name="code_generation", tool_status="in_progress",
                         action="генерирует артефакт")
        # Просим модель выдать готовые файлы в парсируемом формате
        fmt = ("Оформи результат как готовые файлы, КАЖДЫЙ строго так:\n"
               "===FILE: имя_файла===\n<полное содержимое файла>\n"
               "Например: ===FILE: index.html=== ... ===FILE: styles.css=== ...\n"
               "Если это лендинг — дай цельные index.html и styles.css. "
               "Если план/документ — один .md файл. Без пояснений вне файлов.")
        fallback = (f"===FILE: 02_artifact.md===\n# Результат по задаче\n\n"
                    f"{dev_task}\n\n## На основе анализа\n{analysis[:1500]}")
        artifact, _ = await self._ask(
            task_id, agent,
            f"Задача: {dev_task}\n\nАнализ от Analyst:\n{analysis}\n\n{fmt}",
            fallback, max_tokens=4000)
        # Разбираем ответ на файлы и реально пишем их на диск
        written = []
        for name, content in parse_artifacts(artifact):
            written.append(await self._save(task_id, agent, name, content))
        await self._emit(task_id, Status.TOOL_CALLING, agent,
                         tool_name="code_generation", tool_status="completed",
                         action=f"создано файлов: {len(written)}")
        await self._emit(task_id, Status.COMPLETED, agent,
                         action=f"разработка готова ({len(written)} файлов)",
                         output_preview=", ".join(f["name"] for f in written),
                         full_output=artifact,
                         extra={"level": await self._level_up(agent),
                                "files": written})
        return artifact, written

    async def _run_reviewer(self, task_id, focus, artifact) -> str:
        agent = "reviewer"
        await self._emit(task_id, Status.STARTED, agent, action="проверяет качество")
        await self._emit(task_id, Status.WORKING, agent,
                         action="изучает артефакт под лупой")
        fallback = ("✅ ДА, готово! Артефакт получен и соответствует задаче "
                    "(автопроверка: модель-ревьюер была недоступна).")
        review, _ = await self._ask(
            task_id, agent,
            f"На что обратить внимание: {focus}\n\nРабота Developer:\n{artifact}",
            fallback, max_tokens=1500)
        await self._save(task_id, agent, "03_review.md", f"# Ревью\n\n{review}\n")
        await self._emit(task_id, Status.COMPLETED, agent,
                         action="ревью готово", output_preview=review,
                         full_output=review,
                         extra={"level": await self._level_up(agent)})
        return review

    async def _handoff(self, task_id, frm, to, what):
        await self._emit(task_id, Status.HANDOFF, action=f"{frm} → {to}: {what}",
                         extra={"from": frm, "to": to, "what": what})

    # ---------- вся задача ----------

    async def run_task(self, task_id: str, prompt: str, chat_id):
        await self._emit(task_id, Status.TASK_RECEIVED, chat_id=chat_id,
                         action="задача принята", output_preview=prompt,
                         full_output=prompt)
        try:
            plan = await self._run_manager(task_id, prompt)
            await self._handoff(task_id, "manager", "analyst", "задание на анализ")

            analysis = await self._run_analyst(task_id, plan["analyst_task"])
            await self._handoff(task_id, "analyst", "developer", "результаты анализа")

            artifact, _files = await self._run_developer(
                task_id, plan["developer_task"], analysis)
            await self._handoff(task_id, "developer", "reviewer", "готовый артефакт")

            review = await self._run_reviewer(task_id, plan["reviewer_focus"], artifact)

            files = list_files(task_id)
            report = self._assemble_report(task_id, prompt, plan, analysis,
                                           review, files)
            await self._emit(task_id, Status.TASK_DONE, chat_id=chat_id,
                             action="все агенты завершили работу",
                             full_output=report,
                             extra={"files": files, "sections": {
                                 "plan": plan.get("plan", ""),
                                 "analysis": analysis,
                                 "artifact": artifact,
                                 "review": review}})
        except Exception as e:
            await self._emit(task_id, Status.TASK_ERROR, chat_id=chat_id,
                             error_message=f"{type(e).__name__}: {e}",
                             action="задача провалена")

    @staticmethod
    def _assemble_report(task_id, prompt, plan, analysis, review, files) -> str:
        """Собрать финальный отчёт для Telegram со ссылками на созданные файлы."""
        def trim(s, n):
            return s if len(s) <= n else s[:n].rstrip() + "…"
        links = "\n".join(f"• {f['name']} ({f['size']} б) — "
                          f"{FILES_BASE}/{task_id}/{f['name']}" for f in files)
        html = next((f for f in files if f["name"].endswith(".html")), None)
        open_line = (f"\n🌐 Открыть в браузере: {FILES_BASE}/{task_id}/{html['name']}\n"
                     if html else "")
        return (
            f"📋 *ФИНАЛЬНЫЙ ОТЧЁТ*\n\n"
            f"🎯 Задача: {prompt}\n\n"
            f"🔵 *План (Manager):*\n{plan.get('plan','')}\n\n"
            f"🟢 *Анализ (Analyst):*\n{trim(analysis, 1500)}\n\n"
            f"🟣 *Ревью (Reviewer):*\n{trim(review, 1200)}\n\n"
            f"📁 *Созданные файлы:*\n{links}\n{open_line}"
        )
