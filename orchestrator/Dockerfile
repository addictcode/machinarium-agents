# Orchestrator + Dashboard. Контекст сборки — корень репо (нужен common/).
FROM python:3.12-slim

WORKDIR /app
COPY orchestrator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY common /app/common
COPY orchestrator /app/orchestrator

ENV PYTHONPATH=/app:/app/orchestrator
WORKDIR /app/orchestrator
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
