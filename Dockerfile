# Resolve and retain immutable image IDs with pin-images.sh before release.
ARG NODE_IMAGE=node@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34
FROM ${NODE_IMAGE} AS build
RUN printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20250601T000000Z bookworm main\n' > /etc/apt/sources.list && rm -f /etc/apt/sources.list.d/* && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime/package*.json ./
RUN npm_config_build_from_source=true npm ci --omit=dev && node -e "require('better-sqlite3')(':memory:').close()"
COPY runtime/ ./
RUN chmod -R a+rX /app
FROM ${NODE_IMAGE}
RUN printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20250601T000000Z bookworm main\n' > /etc/apt/sources.list && rm -f /etc/apt/sources.list.d/* && apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY ops.py /app/ops.py
USER 1000:1000
ENTRYPOINT ["python3","/app/ops.py"]
CMD ["serve"]
