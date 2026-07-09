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

# ── Stage 2: Download xeus-cpp WASM files from conda ──
FROM node:22-slim AS xeus-cpp-fetcher
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/xeus-cpp
# xeus-cpp 0.6.0 from emscripten-forge (contains xcpp.js, xcpp.wasm, xcpp.data)
RUN curl -fsSL "https://repo.mamba.pm/emscripten-forge/emscripten-wasm32/xeus-cpp-0.6.0-h18da88b_1.tar.bz2" -o xcpp.tar.bz2 \
    && tar xf xcpp.tar.bz2 \
    && find . -name "xcpp.js" -o -name "xcpp.wasm" -o -name "xcpp.data" | head -10
# CppInterOp 1.5.0 — provides libclangCppInterOp.so (WASM side module, ~54MB)
# Version 1.5.0 h18da88b_3 was built 2025-01-20, matching xeus-cpp 0.6.0 h18da88b_1 (built 2025-01-23)
# Required by xcpp.wasm's dylink section — provides __clang_Interpreter_SetValueNoAlloc
RUN curl -fsSL "https://repo.mamba.pm/emscripten-forge/emscripten-wasm32/cppinterop-1.5.0-h18da88b_3.tar.bz2" -o cppinterop.tar.bz2 \
    && tar xf cppinterop.tar.bz2 lib/libclangCppInterOp.so \
    && ls -la lib/libclangCppInterOp.so
# Copy all WASM files to a known location
RUN mkdir -p /xeus-cpp \
    && find . -name "xcpp.js" -exec cp {} /xeus-cpp/ \; \
    && find . -name "xcpp.wasm" -exec cp {} /xeus-cpp/ \; \
    && find . -name "xcpp.data" -exec cp {} /xeus-cpp/ \; \
    && cp lib/libclangCppInterOp.so /xeus-cpp/libclangCppInterOp.so \
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
    && test -f build/live.html

# ── Stage 4: nginx serving static files + xeus-cpp WASM ──
FROM nginx:1.29-alpine3.23
COPY --from=optlite-builder /app/opt-cpp/optlite-components/build/ /usr/share/nginx/html/
COPY --from=xeus-cpp-fetcher /xeus-cpp/ /usr/share/nginx/html/xeus-cpp/
EXPOSE 8000
COPY optlite-components/nginx.conf /etc/nginx/conf.d/default.conf
CMD ["nginx", "-g", "daemon off;"]
