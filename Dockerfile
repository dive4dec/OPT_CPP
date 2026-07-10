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

# ── Stage 2: Copy pre-built xeus-cpp WASM files (patched for std::format) ──
FROM node:22-slim AS xeus-cpp-fetcher
# The WASM files in xeus-cpp-wasm/ are patched: __availability header has
# _LIBCPP_AVAILABILITY_DISABLE_FTM___cpp_lib_format commented out.
# This enables std::format even with the default C++20 standard.
# See: make xeus-cpp-patch (in dive-deploy Makefile) to rebuild from upstream.
COPY xeus-cpp-wasm/ /xeus-cpp/
RUN ls -la /xeus-cpp/

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
COPY optlite-components/nginx.conf /etc/nginx/conf.d/default.conf
CMD ["nginx", "-g", "daemon off;"]
