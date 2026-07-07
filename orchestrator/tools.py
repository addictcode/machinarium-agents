"""
Инструменты агентов: веб-поиск (DuckDuckGo, без ключа),
экстрактивная суммаризация (работает без LLM) и файловая мастерская
(агенты создают реальные файлы в общей папке workspace).
"""

import asyncio
import os
import re
from collections import Counter

from ddgs import DDGS

# ==================== Файловая мастерская агентов ====================
# Общая папка, смонтированная на хост (docker-compose): файлы агентов
# появляются у пользователя на диске и раздаются по HTTP на /files/.

WORKSPACE = os.environ.get("WORKSPACE_DIR", "/app/workspace")

_UNSAFE = re.compile(r"[^A-Za-z0-9._/-]")


def _safe_name(name: str) -> str:
    """Обезопасить имя файла: без абсолютных путей и выхода за пределы папки."""
    name = (name or "").strip().replace("\\", "/").lstrip("/")
    name = _UNSAFE.sub("_", name)
    parts = [p for p in name.split("/") if p not in ("", ".", "..")]
    return "/".join(parts) or "file.txt"


def _guess_name(content: str) -> str:
    """Угадать имя файла по содержимому, если модель не указала."""
    head = content.lstrip()[:200].lower()
    if head.startswith("<!doctype") or head.startswith("<html"):
        return "index.html"
    if "import " in head or "def " in head or head.startswith("#!"):
        return "main.py"
    if head.startswith("{") or head.startswith("["):
        return "data.json"
    return "artifact.md"


def task_dir(task_id: str) -> str:
    d = os.path.join(WORKSPACE, _safe_name(task_id))
    os.makedirs(d, exist_ok=True)
    return d


def write_file(task_id: str, name: str, content: str) -> dict:
    """Записать файл в папку задачи. Возвращает {name, size}."""
    safe = _safe_name(name)
    path = os.path.join(task_dir(task_id), safe)
    if os.path.dirname(safe):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return {"name": safe, "size": len(content)}


def list_files(task_id: str) -> list[dict]:
    """Перечислить файлы задачи (рекурсивно)."""
    d = os.path.join(WORKSPACE, _safe_name(task_id))
    out = []
    for root, _dirs, files in os.walk(d):
        for fn in sorted(files):
            full = os.path.join(root, fn)
            out.append({"name": os.path.relpath(full, d),
                        "size": os.path.getsize(full)})
    return sorted(out, key=lambda x: x["name"])


_FILE_MARK = re.compile(r"^\s*===\s*FILE:\s*(.+?)\s*===\s*$", re.M)


def _strip_fence(body: str) -> str:
    """Снять обрамляющий markdown-кодоблок, если он охватывает весь текст."""
    m = re.match(r"^```[A-Za-z0-9]*\s*\n(.*)\n```\s*$", body, re.S)
    return m.group(1) if m else body


def parse_artifacts(text: str) -> list[tuple[str, str]]:
    """Разобрать ответ разработчика на файлы.

    Формат: блоки, начинающиеся со строки `===FILE: имя===`. Если разметки
    нет — весь ответ идёт одним файлом с угаданным именем."""
    marks = list(_FILE_MARK.finditer(text))
    files: list[tuple[str, str]] = []
    if marks:
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            body = text[m.end():end]
            body = re.sub(r"\n?\s*===\s*END\s*===\s*$", "", body).strip()
            body = _strip_fence(body).strip()
            if body:
                files.append((m.group(1), body))
    if not files:
        files.append((_guess_name(text), text.strip()))
    return files

# Стоп-слова для ранжирования предложений (минимальный набор ru+en)
_STOP = set("""и в во не что он на я с со как а то все она так его но да ты к у же
вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну
ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя
чем это этот эта при об для the a an of to in and or is are was were be been by
on at as it its from that this with which their there has have had not can will
would about more most other some such no nor too very""".split())


async def web_search(query: str, max_results: int = 6) -> list[dict]:
    """Поиск в DuckDuckGo. Возвращает [{title, href, body}]. Блокирующую
    библиотеку уводим в thread-pool, чтобы не стопорить event loop."""
    def _search():
        with DDGS() as ddgs:
            return list(ddgs.text(query, max_results=max_results))
    try:
        return await asyncio.to_thread(_search)
    except Exception:
        return []  # поиск недоступен — вернём пусто, пайплайн решит, что делать


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[а-яёa-z0-9]+", text.lower()) if w not in _STOP]


def extract_key_points(texts: list[str], top_n: int = 8) -> list[str]:
    """Экстрактивная суммаризация: ранжируем предложения по частоте значимых
    слов корпуса. Простая замена LLM для режима LLM_PROVIDER=none."""
    corpus = " ".join(texts)
    freq = Counter(_words(corpus))
    sentences = [s.strip() for s in re.split(r"(?<=[.!?…])\s+", corpus)
                 if 40 < len(s.strip()) < 300]
    seen, scored = set(), []
    for s in sentences:
        key = " ".join(_words(s))[:80]
        if key in seen:
            continue  # дубль
        seen.add(key)
        ws = _words(s)
        if ws:
            scored.append((sum(freq[w] for w in ws) / len(ws), s))
    scored.sort(reverse=True)
    return [s for _score, s in scored[:top_n]]
