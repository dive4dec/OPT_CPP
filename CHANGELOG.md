# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-09

### Added
- **Serverless C++ code visualizer** using xeus-cpp (clang-repl WASM) in a Web Worker.
- **Multi-stage Dockerfile** — node:22-slim builder → nginx:1.29-alpine static server.
- **Helm chart** (`opt-cpp/chart/`) with Deployment, Service, Ingress, ServiceAccount, HPA.
- **Makefile targets**: `opt-cpp`, `opt-cpp.main`, `opt-cpp-push`, `test-opt-cpp.main`, `uninstall-opt-cpp.main`.
- **webpack config** with `PUBLIC_PATH` support for sub-path deployment (`/OPT_CPP/`).
- **nginx.conf** with SPA fallback, favicon 204, static asset caching.
- **HTML templates** configured for C++ mode (ace `mode-c_cpp`, title "Visualize C++ Code Execution").
- **cppworker.js** — Web Worker that loads xeus-cpp WASM from CDN.
- **runner.ts** — Worker lifecycle management, mirrors pyodide/runner.ts pattern.
- **C++ tracer preamble** (v1) — captures stdout at each execution step; variable capture planned for v2.
- This `CHANGELOG.md` and `VERSION`.

### Known Limitations
- **C++ tracer is v1** — captures stdout only, no variable/stack/heap visualization yet.
- **xeus-cpp CDN URL** — placeholder version; needs confirmation from research.
- **Code instrumentation** — simple line-by-line; v2 will use clang AST for precision.
