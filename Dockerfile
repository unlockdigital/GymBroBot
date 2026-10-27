# Resolve and retain immutable image IDs with pin-images.sh before release.
ARG NODE_IMAGE=node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
FROM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime/package*.json ./
RUN npm_config_build_from_source=true npm ci --omit=dev && node -e "require('better-sqlite3')(':memory:').close()"
COPY runtime/ ./
RUN chmod -R a+rX /app
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY ops.py /app/ops.py
# Release archives can retain private source modes; this file contains public code.
RUN chmod 0444 /app/ops.py
USER 1000:1000
# Check the actual runtime identity can read/parse operations and load native SQLite.
RUN python3 -c "import os; from pathlib import Path; assert os.getuid()==1000; p=Path('/app/ops.py'); compile(p.read_text(), str(p), 'exec')"
RUN node -e "require('better-sqlite3')(':memory:').close()"
ENTRYPOINT ["python3","/app/ops.py"]
CMD ["serve"]
