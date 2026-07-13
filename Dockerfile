FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY static ./static
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DATA_DIR=/data \
    PYTHONUNBUFFERED=1
# PYTHONUNBUFFERED matters more than it looks: the invite code is printed to
# stdout on startup, and without it that line can sit in a buffer instead of
# appearing in `docker logs` when a new user goes looking for it.

VOLUME ["/data"]

EXPOSE 8000

# Marks the container healthy only once the server actually answers -- lets
# `depends_on: condition: service_healthy`, restart policies, and dashboards
# like Portainer/Uptime Kuma see real status instead of just "running".
# Uses Python's stdlib so no curl/wget needs to be installed for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

# Root only inside the entrypoint, which fixes /data ownership and then
# drops to an unprivileged user before uvicorn starts. See entrypoint.sh.
ENTRYPOINT ["/entrypoint.sh"]
