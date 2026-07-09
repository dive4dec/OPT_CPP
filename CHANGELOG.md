# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-09

### Changed
- **Default C++ standard is C++20** (`__cplusplus = 202002`). The xeus-cpp WASM build (clang 19.1.7) ignores the `-std=` flag passed via `xkernel` argv, so the dropdown selector was removed. C++20 language features work; library features (e.g. `<format>`) are unavailable in the emscripten-forge libc++ WASM build.

### Fixed
- **GitHub Pages deployment** now includes xeus-cpp WASM files (`.js`, `.wasm`, `.so`). The GH Actions workflow was only deploying the webpack bundle, not the WASM assets fetched from `repo.mamba.pm/emscripten-forge`.
- **Console spam from xcpp.js** — clang/LLVM diagnostic output (version info, include paths, "ignoring nonexistent directory" warnings) flooded the console on every execution. Fixed by overriding `Module.print` and `Module.printErr` in `cppworker.js`.
- **Duplicate element IDs in live.html** — 12 IDs (`legendDiv`, `executionSlider`, `vcrControls`, `jmpFirstInstr`, `jmpStepBack`, `jmpStepFwd`, `jmpLastInstr`, `curInstr`, `rawUserInputDiv`, `userInputPromptStr`, `prevLegendArrowSVG`, `curLegendArrowSVG`) duplicated the ExecutionVisualizer's generated navHTML. Renamed static IDs with `_live` suffix and updated all references in `opt-live.ts`.
- **Arrow SVG size regression** — renaming `prevLegendArrowSVG` / `curLegendArrowSVG` to `_live` variants broke the CSS rule constraining them to 18×10px, causing arrows to render at SVG default size (300×150px). Added `_live` variants to the CSS selector in `opt-live.css`.
- **Ace editor textarea** — added `name="ace_code_input"` attribute to satisfy browser autofill audit (textarea had neither `id` nor `name`).
- **Dead debug handler** — removed leftover `id === -999` debug message handler from `runner.ts`.

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
