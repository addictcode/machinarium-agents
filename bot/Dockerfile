# Telegram-бот. Контекст сборки — корень репо (нужен common/).
FROM python:3.12-slim

WORKDIR /app
COPY bot/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY common /app/common
COPY bot /app/bot

ENV PYTHONPATH=/app
CMD ["python", "bot/bot.py"]
