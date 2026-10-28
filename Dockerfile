# Patched supported Node22/Debian13 baseline; retain resolved inventories with releases.
ARG NODE_IMAGE=node@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
FROM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime/package*.json ./
# v13 includes upstream prebuilds; explicitly compile and remove them for source provenance.
RUN npm ci --omit=dev --ignore-scripts && cd node_modules/better-sqlite3 && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release --force_build=1 --nodedir=/usr/local && rm -rf prebuilds
# Python operations use the same patched public-domain amalgamation as the Node addon.
RUN mkdir -p /opt/sqlite/lib && cc -O2 -fPIC -shared -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE -Wl,-soname,libsqlite3.so.0 node_modules/better-sqlite3/deps/sqlite3/sqlite3.c -o /opt/sqlite/lib/libsqlite3.so.0 -lm -ldl -lpthread
COPY runtime/ ./
RUN chmod -R a+rX /app
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY --from=build /opt/sqlite /opt/sqlite
COPY ops.py /app/ops.py
# Service/CLI execution requires Node only; package managers remain in the build stage.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Operations use Node, SQLite and filesystem APIs. Remove unused vulnerable CLIs
# while retaining Debian package metadata for honest package-based scanning.
RUN rm -f /usr/bin/mount /usr/bin/umount /usr/bin/nsenter /usr/bin/infocmp \
    && test ! -e /bin/mount && test ! -e /bin/umount \
    && test ! -e /usr/bin/nsenter && test ! -e /usr/bin/infocmp
ENV LD_LIBRARY_PATH=/opt/sqlite/lib
RUN chmod 0444 /app/ops.py && chmod -R a+rX /opt/sqlite
USER 1000:1000
RUN python3 -c "import os,sqlite3; from pathlib import Path; assert os.getuid()==1000; p=Path('/app/ops.py'); compile(p.read_text(), str(p), 'exec'); assert sqlite3.sqlite_version_info >= (3,53,2), sqlite3.sqlite_version"
RUN node -e "const D=require('better-sqlite3');const d=new D(':memory:');if(d.prepare('select sqlite_version() v').get().v!=='3.53.4')throw Error('Patched SQLite required');d.close()"
ENTRYPOINT ["python3","/app/ops.py"]
CMD ["serve"]
