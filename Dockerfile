# ── Stage 1: Build webllm-components (rollup → lib/index.js) ──
FROM node:22-slim AS webllm-builder
WORKDIR /app/opt-cpp/webllm-components
COPY webllm-components/package.json webllm-components/package-lock.json ./
RUN npm ci --ignore-scripts
COPY webllm-components/ .
ENV HUSKY=0
ENV HUSKY_SKIP_HOOKS=1
RUN chmod +x cleanup-index-js.sh \
    && npx rollup -c rollup.config.cjs \
    && ./cleanup-index-js.sh \
    && test -f lib/index.js

# ── Stage 2: Download xeus-cpp WASM files from emscripten-forge-4x ──
FROM node:22-slim AS xeus-cpp-fetcher
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/xeus-cpp
# xeus-cpp 0.10.0 from emscripten-forge-4x (clang 21.1.8, C++23 support, <format> library)
# Contains xcpp.js, xcpp.wasm, xcpp.data with C++23 stdlib headers including <format>
RUN curl -fsSL "https://prefix.dev/emscripten-forge-4x/emscripten-wasm32/xeus-cpp-0.10.0-h0b0027f_0.tar.bz2" -o xcpp.tar.bz2 \
    && tar xf xcpp.tar.bz2 \
    && find . -name "xcpp.js" -o -name "xcpp.wasm" -o -name "xcpp.data" | head -10
# CppInterOp 1.9.0 — provides libclangCppInterOp.so (WASM side module)
# Required by xeus-cpp 0.10.0 (depends on cppinterop >=1.9.0,<1.10.0)
# Note: .so is a symlink to .so.21.1, must extract both
RUN curl -fsSL "https://prefix.dev/emscripten-forge-4x/emscripten-wasm32/cppinterop-1.9.0-h0b0027f_0.tar.bz2" -o cppinterop.tar.bz2 \
    && tar xf cppinterop.tar.bz2 lib/libclangCppInterOp.so lib/libclangCppInterOp.so.21.1 \
    && ls -la lib/libclangCppInterOp.so lib/libclangCppInterOp.so.21.1
# xeus 6.0.5 — provides libxeus.so (WASM side module, required by xcpp.wasm)
RUN curl -fsSL "https://prefix.dev/emscripten-forge-4x/emscripten-wasm32/xeus-6.0.5-h0b0027f_0.tar.bz2" -o xeus.tar.bz2 \
    && tar xf xeus.tar.bz2 lib/libxeus.so \
    && ls -la lib/libxeus.so
# Copy all WASM files to a known location
# Use cp -L to dereference the .so symlink and copy the real file
RUN mkdir -p /xeus-cpp \
    && find . -name "xcpp.js" -exec cp {} /xeus-cpp/ \; \
    && find . -name "xcpp.wasm" -exec cp {} /xeus-cpp/ \; \
    && find . -name "xcpp.data" -exec cp {} /xeus-cpp/ \; \
    && cp -L lib/libclangCppInterOp.so /xeus-cpp/libclangCppInterOp.so \
    && cp -L lib/libxeus.so /xeus-cpp/libxeus.so \
    && ls -la /xeus-cpp/

# ── Stage 3: Build optlite-components (webpack → build/) ──
FROM node:22-slim AS optlite-builder
WORKDIR /app/opt-cpp/optlite-components
COPY optlite-components/package.json optlite-components/package-lock.json ./
RUN npm ci
COPY optlite-components/ .
COPY --from=webllm-builder /app/opt-cpp/webllm-components/lib ../webllm-components/lib
COPY webllm-components/package.json ../webllm-components/

# Build-time configuration
ARG PUBLIC_PATH=""
ENV PUBLIC_PATH=${PUBLIC_PATH}
ENV INJECT_API_CONFIG=true
ENV API_INJECT_TARGET=define
ARG API_BASE_URL=""
ARG API_KEY=""
ARG API_MODEL=""
ARG SINGLE_MODE=""
ENV API_BASE_URL=${API_BASE_URL}
ENV API_KEY=${API_KEY}
ENV API_MODEL=${API_MODEL}
ENV SINGLE_MODE=${SINGLE_MODE}

RUN npm run build:prod \
    && test -f build/index.html \
    && test -f build/live.html \
    && cp js/pyodide/instrument.js build/ \
    && cp js/pyodide/opt_trace.h build/ \
    && cp sw.js build/ \
    && chmod 644 build/instrument.js build/opt_trace.h build/sw.js

# ── Stage 4: nginx serving static files + xeus-cpp WASM ──
FROM nginx:1.29-alpine3.23
COPY --from=optlite-builder /app/opt-cpp/optlite-components/build/ /usr/share/nginx/html/
COPY --from=xeus-cpp-fetcher /xeus-cpp/ /usr/share/nginx/html/xeus-cpp/
EXPOSE 8000
COPY optlite-components/nginx.conf /etc/nginx/templates/default.conf.template
# envsubst processes ${VAR} in the template at container start.
# API_PROXY_TARGET = upstream API base URL (without trailing slash)
# API_PROXY_KEY   = API key injected server-side (never sent to browser)
# Default to a dead-end port so unset proxy just returns 502.
ENV API_PROXY_TARGET="http://127.0.0.1:1"
ENV API_PROXY_KEY=""
