# Throwaway sandbox image used by run_python / run_shell when SANDBOX_MODE=docker.
#   docker build -t sol-sandbox:latest ./sandbox
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl git jq ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir requests numpy pandas matplotlib pillow
WORKDIR /work
