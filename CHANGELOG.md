# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.4] - 2026-07-10

### Added
- **Function call stepping** — stepping into user-defined functions now works. When a function is called from `main` (or another function), a new stack frame is pushed with the function name and parameters. The visualization shows the call stack with parent-child relationships, matching Python Tutor's behavior. Tested with simple function calls (`add(3, 4)`) and recursive calls (`factorial(5)` — 5 nested frames appear correctly).

### Fixed
- **Recursive call frames** — `__opt_ensure_frame__` now detects recursive calls by checking if the line number went backwards to the function entry line. Previously, recursive calls were treated as continuations of the same frame, so only one frame appeared regardless of recursion depth. Now each recursive call pushes a new frame.

## [0.2.3] - 2026-07-10

### Fixed
- **Visualization one step ahead** — the trace now follows Python Tutor's pre-statement convention: each trace entry's `line` is the line *about to execute* (red arrow) and variables reflect the state *before* that line runs. The green arrow (line that just executed) points to the previous step's line. Previously, trace calls were injected *after* each statement, causing variables to appear one step too early and the final step to show the wrong line as "just executed". Now `sum` appears at the correct step, and the last step shows `std::cout << sum` (line 8) as the line that just executed with stdout `60`.
- **Error line not reported** — compile errors (e.g., `std::cut` instead of `std::cout`) now highlight the correct source line with a red annotation in both `visualize.html` and `live.html`. The kernel strips line numbers from error messages, so an identifier-based source code search extracts the offending token (e.g., `cut` from "no member named 'cut'") and searches the user's code to find the error line.
- **Struct visualization crash** — removed `std::is_class_v` / `std::is_pointer_v` checks from `cap()` that caused "UNSUPPORTED FEATURES" compile errors in clang-repl WASM. Structs now fall through to `__opt_encode_data__` which encodes them as `C_DATA` with type `object`.
- **Multi-parameter function parsing** — `instrument.js` now correctly splits function parameters by comma (e.g., `int a, int b` → two separate declarations). Previously, `parseDeclaration` only captured the first parameter.

### Changed
- **Pre-statement instrumentation** — `instrument.js` now injects trace calls *before* each statement instead of after, matching Python Tutor's trace format. For-loop headers get a pre-header trace (without the loop variable) and a post-header trace (with the loop variable initialized). `cout`/`printf` statements get a post-execution trace so the final step shows the output and the correct "line that just executed". `return` statements get a post-execution trace showing final state.
- **Stdout mapping** — `runner.ts` updated for pre-statement convention: segment `N` = output produced by statement `N-1`, and any remaining output after the last sentinel is added to the final trace entry.
- **Function call stack mechanism** — replaced `__opt_push_frame__` (which does not execute inside function bodies in clang-repl) with `__opt_trace_fn__(funcName, line, ...)` which calls `__opt_ensure_frame__` at trace time to push/pop frames.
- **`runner.ts` error handling** — identifier-based source code search as a fallback when the kernel error text lacks line numbers. `#line` directives were removed because they cause "Decl inserted into wrong lexical context" assertion failures in clang-repl.

### Known Limitations
- **C_STRUCT fields** — struct fields are not visualized (C++ lacks reflection). Structs appear as `object <type>` with value `<unknown>`.
- **Function call stepping** — `__opt_trace_fn__` calls inside user-defined function bodies may not execute in clang-repl, so called functions' local variables may not appear in separate stack frames. The `main` frame and its variables work correctly.
- **Heap objects** — pointers are encoded as `C_DATA` with type `pointer` and the target address, but no heap entries are created.

## [0.2.2] - 2026-07-09

### Added
- **C_STRUCT visualization** — user-defined structs/classes are now encoded as `C_STRUCT` entries in the trace. The struct appears in the stack frame with its type name (e.g., `object Point`). Fields are empty (C++ lacks reflection; future versions may support an opt-in `__opt_cap__` method).
- **Function call stack** — user-defined functions are instrumented with `__opt_push_frame__` calls. When a function is called from `main()`, a new stack frame is pushed with the function name and parameters. The frontend renders multiple frames with parent-child relationships (`is_parent`, `parent_frame_id_list`).
- **Heap object support** — pointers (`int* p = &x`) are now encoded with their pointee address. Non-null pointers create heap entries in the trace's `heap` field. The frontend renders heap objects in the Heap section.

### Changed
- **`opt_trace.h`** — `__opt_state__` now tracks `heap_entries` (address → JSON) and `call_stack` (vector of `frame_info` with `func_name`, `frame_id`, `line`, `locals`, `names`). `finish()` builds `stack_to_render` from the call stack and `heap` from `heap_entries`. The top frame uses the current tracer's locals/names; parent frames use their last-updated values.
- **`instrument.js`** — detects all function definitions (not just `main`), pushes/pops trace frames, parses function parameters. `return` statements now have trace calls injected BEFORE the return (code after `return` is unreachable).

### Known Limitations
- **C_STRUCT fields** — struct fields are empty because C++ lacks reflection. An opt-in `__opt_cap__` method would allow structs to self-report their fields.
- **Function frame popping** — frames are pushed when functions are called but not explicitly popped when they return. The `add` frame persists in the stack after the function returns. This is a cosmetic issue (the frame shows but with stale data).
- **Parameter parsing** — `parseDeclaration("int a, int b")` only parses the first parameter. Multi-parameter functions will have some parameters missing from the trace.

### Added
- **Array visualization** — 1-D arrays (`int arr[3] = {10,20,30}`) render as `C_ARRAY` with index headers and element values. 2-D arrays (`int matrix[2][3]`) render as `C_MULTIDIMENSIONAL_ARRAY` with row,column headers.
- **`for` loop variable capture** — `instrument.js` now extracts variable declarations from `for` loop headers (e.g., `int i` from `for (int i = 0; ...)`) and injects trace calls inside the loop body, enabling step-by-step loop iteration visualization.
- **`char` array support** — `char str[] = "hello"` renders as a `C_ARRAY` of `char` elements, including the null terminator.

### Fixed
- **Char encoding with null bytes** — `__opt_encode_data__` for `char` type now uses `std::string` with `__opt_esc__` instead of `snprintf` into a `char[]` buffer, preventing null byte corruption in trace JSON.
- **SFINAE overload resolution for arrays** — replaced multiple `cap()` template overloads (scalar, 1-D array, 2-D array, 3-D array) with a single `cap()` template using nested `if constexpr` and `std::extent_v` / `std::remove_extent_t` for dimension detection. This fixes ambiguous overload errors and ensures `char[6]` arrays are correctly handled.
- **Print output stale/freeze across runs** — `std::cout.rdbuf()` redirect used for per-step stdout capture worked on the first run but failed after kernel recreation (which resets `std::cout` to its default WASM streambuf), causing stale stdout from a previous run to leak into the current trace. Replaced with a **sentinel-based approach**: `opt_trace.h` emits a unique sentinel string (`\x01\x02__OPT_STEP__\x02\x01`) to `std::cout` after each trace step. `runner.ts` splits the kernel's iopub stream output on this sentinel to reconstruct per-step cumulative stdout. This works reliably across kernel recreations because the iopub stream is always available, regardless of `std::cout`'s internal state.

## [0.2.1] - 2026-07-09

### Added
- **Variable visualization via code instrumentation** — `instrument.js` parses C++ source, finds variable declarations, and injects `__opt_trace__()` calls after each statement. `opt_trace.h` (C++ runtime header) captures variables by type using `if constexpr` dispatch (bool, char, string, arithmetic, pointer) and serializes them as `C_DATA` entries in Python Tutor trace format. Per-step stdout is captured via `std::cout` redirect. Trace JSON is written to the WASM filesystem (`/tmp/opt_trace.json`) and read back by `cppworker.js`.
- **Service worker (`sw.js`)** for GitHub Pages COOP/COEP support — GitHub Pages doesn't set `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers required for `SharedArrayBuffer` (xeus-cpp WASM). The service worker intercepts all same-origin GET responses and injects these headers. Registered in both `live.html` and `visualize.html`; auto-reloads on first visit after activation.
- **GitHub Actions workflow** now copies `instrument.js`, `opt_trace.h`, and `sw.js` to the build output alongside the webpack bundle.

### Changed
- **Trace format matches pythontutor.com** — `C_DATA` entries now have 5 elements: `["C_DATA", address, typeName, value, {"bytes": N}]`. Numeric values are unquoted JSON numbers. Stack frames use string `frame_id` (memory address), `unique_hash` as `"main_0xFFF000BE0"`, `is_highlighted: true`, `parent_frame_id_list`, and `line` inside the frame. `globals` is empty (locals go in `stack_to_render`).
- **Dockerfile** copies `instrument.js`, `opt_trace.h`, and `sw.js` to the build output with `chmod 644`.
- **nginx.conf** added `.h` to allowed static asset extensions.
- **`runner.ts`** only treats stderr as an error if it contains `"error:"` — clang warnings/diagnostics also use stderr but don't indicate failure.

### Fixed
- **`auto` type variables not visualized** — `auto` was incorrectly listed in `skipKeywords` in `instrument.js`, causing `auto x = 1;` to be skipped. Removed it; the runtime correctly captures the deduced type via `typeid(v).name()`.
- **Empty trace crash** — code with no executable statements (e.g., just `#include <iostream>`) produced `{"trace":[]}`, causing the frontend to throw `Cannot read properties of undefined (reading 'length')`. Now falls back to a synthetic trace.
- **Trace state lost across REPL statements** — file-scope `static` variables in `opt_trace.h` were re-initialized for each top-level statement in clang-repl, causing only the last trace entry to survive. Fixed by using a Meyers singleton (function-local `static`) which persists across REPL statements.
- **Ambiguous `cap()` overload** — multiple template overloads matched `int`, causing `call to member function 'cap' is ambiguous`. Replaced all overloads with a single `if constexpr`-based template.
- **Undeclared `__t__` identifier** — `__opt_cap__` macro expanded to `__t__.cap()` but `__t__` wasn't visible at the macro expansion site. Removed the macro; `instrument.js` now generates `__t__.cap(...)` directly inside a lambda `[&](auto& __t__)`.
- **Browser caching of `instrument.js`** — old cached version was loaded via `importScripts`. Fixed with cache-busting `?v=Date.now()` on `importScripts` and `fetch` calls.
- **403 Forbidden on `instrument.js` / `opt_trace.h`** — file permissions were `-rw-------` in the container. Fixed with `chmod 644` in Dockerfile.

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
