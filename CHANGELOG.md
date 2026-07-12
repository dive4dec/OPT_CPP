# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.11] - 2026-07-12

### Fixed
- **Multiple `main` frames in for-loop visualization** — `__opt_ensure_frame__()` incorrectly detected "recursion" when a for-loop went back to an earlier line (the `for` statement) on each iteration. The condition `if(line < st.call_stack.back().line)` triggered a new frame push, creating duplicate `main` frames. Removed the flawed backward-line recursion detection: same function name at top of stack is always a continuation of the same frame.

## [0.3.10] - 2026-07-12

### Fixed
- **`auto` type variables** — `auto x=1uLL` produced `__opt_cap_int__("x", x)` which failed with `no matching function for call to '__opt_cap_int__'` because the actual type is `unsigned long long`, not `int`. Replaced all JS-side type-guessed `__opt_cap_*__` functions with C++ overloaded `__opt_cap__` functions so the compiler selects the correct overload based on the actual argument type. No JS type guessing needed.
- **Array variables** — `int arr[3]`, `int matrix[2][3]`, and `char str[]` all failed because the instrumenter generated `__opt_cap_int__("arr", arr)` but `arr` decays to `int*`, not `int`. Added `__opt_cap_array__` functions for int and char arrays, and updated `genCaptures()` to detect arrays and use the correct function.
- **Unsized arrays** (`char str[] = "hello"`) — `parseDeclaration()` now matches `[]` (empty brackets) in addition to `[N]`. Unsized `char[]` arrays are captured as `std::string` for readable display; unsized non-char arrays use pointer decay.

### Changed
- **`opt_trace.h`** — replaced 8 separate `__opt_cap_int__`, `__opt_cap_double__`, etc. functions with overloaded `__opt_cap__(const char*, T)` for: `int`, `unsigned`, `long`, `unsigned long`, `long long`, `unsigned long long`, `double`, `float`, `bool`, `char`, `const std::string&`, `int*`, `char*`. Added `__opt_cap_array__` for `int*` and `char*` with element count.
- **`instrument.js`** — `genCaptures()` now generates `__opt_cap__("name", var)` for all non-array types (compiler selects overload), `__opt_cap_array__("name", arr, size)` for sized arrays, and `std::string()` wrapping for unsized `char[]` arrays. Removed all JS-side type-to-function-name mapping.

### Known Limitations
- Same as v0.3.9: local class types, struct field capture, and `this` pointer not yet supported with the new overload pattern.

## [0.3.9] - 2026-07-12

### Fixed
- **Variable capture in trace visualization** — `cap<T>()` template calls inside lambdas failed silently in clang-repl's incremental compilation mode (WASM). The `try/catch` in `__opt_trace_fn_impl__` swallowed the runtime exception, producing trace steps with empty `encoded_locals` and `ordered_varnames` — variables were never shown. Replaced all template-based `cap<T>()` calls with non-template global function overloads: `__opt_cap_int__`, `__opt_cap_double__`, `__opt_cap_float__`, `__opt_cap_bool__`, `__opt_cap_char__`, `__opt_cap_string__`, `__opt_cap_long__`, `__opt_cap_int_ptr__`. No template instantiation is required, eliminating the failure mode entirely.
- **Lambda elimination in trace instrumentation** — replaced the `[&](__opt_tracer__& __t__) { ... }` lambda pattern with a three-step global-tracer pattern: `__opt_trace_fn__()` creates a heap-allocated tracer, `__opt_cap__*()` functions add variables to it via a global `__opt_current_tracer__` pointer, and `__opt_trace_end__()` finalizes the step. This avoids per-lambda template instantiation in clang-repl entirely.
- **Function redefinition on re-runs (all functions)** — previous fix only renamed `main()` to `__opt_main_<timestamp>()`. Other user-defined functions still caused redefinition errors on re-runs. Switched from persistent worker to fresh-worker-per-execution, giving a clean clang-repl kernel state every time. No `main` renaming needed.
- **Missing `__opt_trace_end__()` calls** — some instrumenter code paths generated `__opt_trace_fn__()` without a matching `__opt_trace_end__()`, causing those trace steps to be silently lost when the next `__opt_trace_fn__()` deleted the unfinalized tracer. All `__opt_trace_fn__()` calls now have matching `__opt_trace_end__()` calls.

### Changed
- **Fresh worker per execution** — `runner.ts` terminates and recreates the Web Worker before each execution. This is the same approach as v0.3.5/v0.3.6 and provides a clean clang-repl kernel, fixing redefinition of all functions. Tradeoff: ~3-5s initialization cost per execution (WASM module reload).
- **Removed `main` renaming** — no longer needed with fresh worker per execution.
- **Removed debug logging** — temporary `debug_trace` interceptor in `runner.ts` and `TRACE_PARSED`/`TRACE_FILE_READ` logging in `cppworker.js` removed.
- **Removed `xkernel.delete()` approach (Option 3)** — tested and confirmed it throws `WebAssembly.Exception` in the WASM environment. The kernel destructor attempts operations not supported by the WASM runtime.
- **`opt_trace.h`** — added `#include <functional>`; added global `__opt_current_tracer__` pointer; added `__opt_trace_end__()` finalizer; added 8 non-template `__opt_cap__*` overload functions; converted `__opt_trace_impl__` and `__opt_trace_fn_impl__` to no-lambda overloads (heap-allocated tracer); kept old `std::function`-based overloads for backward compatibility (unused by instrumenter).
- **`instrument.js`** — `genCaptures()` now generates non-template `__opt_cap__*` calls instead of `__t__.cap<T>()` calls; all `__opt_trace_fn__` call sites updated to split pattern (`__opt_trace_fn__()` + captures + `__opt_trace_end__()`); struct field capture and local class type capture disabled (requires templates, will be addressed in future version).

### Known Limitations
- **Local class types** (e.g., `Counter` class defined inside `main`) — variables of local class types are not captured in the visualization. Template instantiation of `cap<T>` for local class types fails in clang-repl, and the non-template overloads don't support arbitrary class types. The variable exists in scope but won't be shown.
- **Struct field capture** — struct variables with known field definitions are not expanded to show individual fields. The previous template-based `cap_struct<T>` approach is disabled. Will be addressed with non-template struct capture in a future version.
- **`this` pointer capture** — `this` is handled by `__opt_trace_fn_this__()` but not yet integrated with the new global-tracer pattern for member functions.
- **~3-5s init time** per execution due to fresh worker (WASM module reload). This is the tradeoff for clean kernel state on every run.

## [0.3.8] - 2026-07-11

### Fixed
- **WASM memory mismatch (LinkError)** — `INITIAL_MEMORY` was 67108864 (64MB = 1024 pages) but xeus-cpp 0.10.0's wasm binary requires 2048 pages (128MB). Increased to 134217728 (128MB). This was the root cause of `Aborted(LinkError: WebAssembly.instantiate(): Import #467 "env" "memory": memory import has 1024 pages which is smaller than the declared initial of 2048)` on both the live site and GitHub Pages.
- **`#include <format>` crash** — compiling the full `<format>` header exhausted WASM memory and caused an abort. Since `std::format` is already available in clang-repl's preamble without the include, `#include <format>` is now stripped from user code before execution. Code with `#include <format>` and `std::format` works and gets full step-by-step visualization.
- **GitHub Pages serving xeus-cpp 0.6.0** — the GitHub Actions workflow was still downloading xeus-cpp 0.6.0 from the old `emscripten-forge` channel. Updated to fetch 0.10.0 from `emscripten-forge-4x`, matching the Dockerfile. Also added `libxeus.so` (required by xcpp.wasm 0.10.0 but was missing).

### Changed
- **Simplified code paths** — removed the separate "heavy header" raw execution path. All code now goes through the single instrumented path. `#include <format>` is transparently stripped, so `std::format` code gets full visualization like any other code.

## [0.3.7] - 2026-07-11

### Fixed
- **Redefinition of `main` on re-runs** — the persistent clang-repl kernel retains all previous declarations, so editing and re-executing code in `live.html` caused "redefinition of 'main'" errors. Each execution now renames `main()` to a unique `__opt_main_<timestamp>()` function, so hundreds of re-runs work without redefinition. The unique function names are lightweight symbol table entries; standard library includes stay cached via clang-repl's include guards, so re-runs remain fast.
- **Redefinition of trace structs on re-runs** — `opt_trace.h` now has include guards (`#ifndef OPT_TRACE_H` / `#define OPT_TRACE_H` / `#endif`) so the trace runtime (singleton, tracer, capture functions) is not redefined on subsequent executions in the persistent kernel.
- **Heavy header crashes** — removed `checkHeavyHeaders()` blocking logic. Code using `#include <format>` now executes through a raw path (no trace header, no instrumentation) that produces stdout output without step-by-step visualization. `std::format` is also available without `#include <format>` since clang-repl's preamble provides it.

### Changed
- **Persistent worker (no per-execution kernel recreation)** — the worker stays alive across executions for fast re-runs. Re-runs reuse cached clang-repl state (includes, standard library templates). Only `main()` is renamed per execution to avoid redefinition.
- **Init timeout** reduced from 120s to 60s (pre-compilation of trace header removed).
- **Execution timeout** is 120s.
- **`opt_trace.h`** — removed pre-compilation during worker init; the header is compiled fresh on each execution (its include guard makes subsequent compilations instant).
- **`cppworker.js`** — removed `xkernel.delete()`/recreate approach (hung indefinitely); removed `.undo` meta-command approach (not supported by `Cpp::Process()`); removed pre-compilation of `opt_trace.h` during init; removed skip-trace-header logic for `<format>` code.
- **`runner.ts`** — removed `checkHeavyHeaders()` function and call site; removed `checkSyntax()` retained; init timeout 60s; execution timeout 120s.

### Known Limitations
- Code using `#include <format>` runs without step-by-step visualization (trace header + instrumentation skipped to avoid WASM memory exhaustion from combined compilation).
- Unique `__opt_main_<timestamp>` function definitions accumulate in clang-repl's AST across hundreds of re-runs. These are lightweight symbol table entries and do not affect performance, but the kernel state grows slowly.
- `set_count` body statements (brace-less `if`/`else`) do not receive per-statement traces — pre-existing limitation carried over from v0.3.5.

## [0.3.6] - 2026-07-11

### Changed
- Upgraded xeus-cpp from 0.6.0 (clang 17, C++17) to 0.10.0 (clang 21.1.8, C++23). C++23 features including `std::format` are now available in the live code editor.
- Switched WASM package source from `emscripten-forge` to `emscripten-forge-4x` (emscripten-abi 4.0.8) to get pre-built clang 21 WASM binaries.
- Upgraded CppInterOp from 1.5.0 to 1.9.0 and added `xeus 6.0.5` package (provides `libxeus.so` required by the new WASM binary's dylink section).

### Fixed
- Worker initialization (`cppworker.js`) updated for emscripten 4.x / xeus-cpp 0.10.0 API: dynamic libraries (`libxeus.so`, `libclangCppInterOp.so`) are now auto-loaded by the WASM module's `loadDylibs()` instead of being manually written to the filesystem; `waitRunDependencies` is called on first init to ensure dynamic library loading completes before kernel creation.
- Full kernel argv now passed to `xkernel()` constructor: `-resource-dir /lib/clang/21`, `-Xclang -iwithsysroot/include/compat`, `-std=c++23`, `-fwasm-exceptions`, `-mllvm -wasm-enable-sjlj`, `-msimd128` — matching the xeus-cpp 0.10.0 `xcpp23` kernel spec.
- `runner.ts` restructured to terminate and recreate the Web Worker for each execution, since emscripten 4.x does not allow reinstantiating the WASM module within the same worker. This follows the same pattern used by `jupyterlite-xeus`.
- Cache-busting `?v=0.10.0` added to `importScripts`, `locateFile`, and `.so` fetch URLs to prevent stale cached 0.6.0 binaries from being served alongside the new 0.10.0 `xcpp.js`.
- Removed dead code: `cachedSoData` variable, stale design-note comment block (28 lines), debug `console.log` statements, and dead `flush` message handler in `runner.ts`.
- `OptLite` config setup (`combineDefaults`) now runs once instead of on every worker recreation.
- Worker init timeout (60s) added to prevent silent hangs if WASM crashes during initialization.
- Stdout routing: `Module.print` now forwards to iopub stream messages (instead of suppressing with `() => {}`), with clang compiler diagnostics filtered out by only forwarding after the first trace sentinel is seen.

### Known Limitations
- `set_count` body statements (brace-less `if`/`else`) do not receive per-statement traces — pre-existing `pendingBracelessBody` limitation carried over from v0.3.5.
- Static state from previous executions is not reset (the WASM module cannot be reinstantiated in emscripten 4.x); each execution gets a fresh Web Worker instead, which provides a clean kernel state but with a small initialization cost per run.

## [0.3.5] - 2026-07-11

### Added
- Member functions inside local classes (e.g. `class Counter` defined in `main()`) are now instrumented, producing separate visualization steps that step into the function body. Previously only global struct member functions were instrumented; local class member functions were passed through with no trace injection.
- Reference return types like `int& operator++()` are now matched by the member function detection regex.
- Production helm values file (`values-live.yaml`) for the opt-cpp chart, with API proxy env vars and ingress config.

### Fixed
- `currentFunc` is now tracked via a push/pop stack instead of being derived from line numbers, which was stuck at the last member function name for all subsequent lines.
- Member function scope close detection now uses `memberFunctionScopeDepth` instead of a hardcoded `scopeStack.length <= 1` check that failed for local classes inside `main()`.
- Helm chart ingress path corrected from `/OPT_Mentor` to `/OPT_CPP` with proper `socratic.cs.cityu.edu.hk` host (was copied from OPT_Mentor chart).
- `API_PROXY_TARGET` and `API_PROXY_KEY` env vars are now properly set in the helm deployment, fixing 502 errors on the "Ask AI" button.

## [0.3.4] - 2026-07-11

### Added
- Brace-less single-line for-loops (`for(...) body;`) are now instrumented with per-iteration trace calls, producing multiple visualization steps instead of a single step. Previously only braced for-loops (`for(...) {`) were instrumented.

## [0.3.3] - 2026-07-11

### Fixed
- For-loop second trace injection now properly handles structs, deleted pointers, and `this` (was missing these cases).

### Changed
- Removed 138 lines of dead code across opt_trace.h, instrument.js, and pytutor.ts.
- Eliminated O(n) `getBraceDepth` scan that ran on every function entry but whose result was never used.

## [0.3.2] - 2026-07-11

### Fixed
- **Local class instances showing `<unknown>`** — locally-defined classes (inside `main()`) now display as `object main::Counter` instead of `<unknown>`. Local structs with public fields also show their field values (e.g., `object Point` with `x: 3, y: 4`).

## [0.3.1] - 2026-07-11

### Removed
- **Test cases feature** — deleted `opt-testcases.ts`, `opt-testcases.css`, `SyntaxErrorSurveyBubble`, `OptFrontendWithTestcases` class, `testCasesParent` div from `visualize.html`, `testCasesLst` query param parsing, `runTestCaseCallback` branching, and `#testCasesPane` CSS (net -925 lines).

## [0.3.0] - 2026-07-10

### Added
- **nginx reverse proxy for API key hiding** — the LLM API key is now injected server-side by nginx, never visible in the browser. The browser calls same-origin `/ai-proxy/chat/completions`; nginx forwards to the upstream API with `Authorization: Bearer ***` injected from a Kubernetes secret. GitHub Pages deployments continue using WebLLM (no proxy, no key).
  - `nginx.conf` — new `/ai-proxy/` location block with `proxy_pass`, `Authorization` header injection, SSE streaming support
  - `Dockerfile` — uses nginx `envsubst` template (`/etc/nginx/templates/default.conf.template`) for runtime env var substitution (`API_PROXY_TARGET`, `API_PROXY_KEY`)
  - `webllm.ts` — `callOpenAIAPI` skips sending `Authorization` header from client when using the proxy
  - `runner.ts` — `cppWorker.onerror` handler rejects pending callbacks with `kernelErrorText` if available, or a meaningful fallback, when the worker dies from an uncaught WASM abort

### Fixed
- **Error messages on WASM abort** — when clang-repl's internal assertion triggers a WASM abort (e.g., undeclared identifier inside a function body), the error message was a raw `Aborted(). Build with -sASSERTIONS for more info.` Now shows `error: Compilation error (WASM aborted). Check your code for syntax errors.` instead. The specific compiler error cannot be recovered because the abort kills the WASM module before the error can be reported through any channel (iopub, `printErr`, or `onAbort`).
  - `cppworker.js` — `onAbort` callback posts the abort reason as an iopub stderr message before the worker dies; `printErr` captures Emscripten-level stderr in both initial and recreated WASM modules; `notify_listener` wrapped in try-catch to detect synchronous aborts
  - `runner.ts` — error callback delayed by 500ms to allow iopub messages to arrive before rejecting
  - `opt-live.ts` — `setFronendError` for compiler errors uses `ignoreLog=true` to suppress misleading `(UNSUPPORTED FEATURES)` suffix

## [0.2.11] - 2026-07-10

### Fixed
- **Local classes inside function bodies** — `class`/`struct` definitions inside `main()` or other functions (e.g., `class Counter { ... }` inside `main()`) were not recognized. Member functions inside them were detected as regular functions, causing trace injection inside class bodies and WASM aborts. Added `inLocalClassBody` tracking that detects local class definitions and skips instrumentation until the closing `};`.
- **Brace-less `for`/`while`/`if` loops** — the for-loop handler injected trace calls between the loop header and body, making the trace function the loop body and causing WASM aborts. Fixed by: (1) requiring `{` in the for-loop regex, and (2) adding `pendingBracelessBody` tracking — the line after a brace-less `for`/`while`/`if` is output without trace injection.
- **`final` keyword in class definitions** — `class Printer final { ... }` was not detected as a struct body because the `final` keyword between the class name and `{` broke the regex. Updated all three struct/class regex patterns to accept `final` after the class name. Private member variables (`sep_`, `end_`) were leaking into `main()` scope as a result.
- **`vcrControls_live` not shown on error in live mode** — in `opt-live.ts`, the error path (compile error or runtime exception) never called `finishSuccessfulExecution()`, so VCR controls stayed `display: none`. Now always creates an `ExecutionVisualizer` and shows VCR controls (wrapped in try-catch), so users can step through execution even when errors occur.
- **Ask AI button shown during code execution** — the `MutationObserver` in `webllm.ts` showed the Ask AI button whenever `frontendErrorOutput` had any text, including the transient "Running your code ..." message. The initial `startsWith('Running your code')` check failed because `htmlspecialchars` converts spaces to `&nbsp;` (non-breaking spaces, U+00A0). Fixed by using regex `/^Running\s+your\s+code/` which matches non-breaking spaces via `\s`.

### Added
- **Instrumentation of more member function patterns** — the member function detection regex now supports:
  - Ref-qualified return types: `const static Printer &get_print()`
  - Ref-qualifiers after `const`: `Printer sep(...) const & { ... }`
  - Rvalue ref-qualifiers: `Printer &sep(...) && { ... }`
  - `operator()` overloads: `void operator()(...) const { ... }`
  - `const` prefix in return types: `const static Printer &get_print()`
- **Static member function support** — added `memberFunctionIsStatic` flag to avoid injecting `(void*)this` in static member functions (which have no `this` pointer), preventing the `invalid use of 'this' outside of a non-static member function` error.

## [0.2.10] - 2026-07-10

### Fixed
- **Static variables not reset between runs** — C++ `static` variables persisted across executions because they live in the WASM module's linear memory, not in the clang-repl kernel's JIT state. Recreating the kernel was not enough. Fixed by recreating the entire WASM module (`createXeusModule()`) on each execution, which resets all linear memory including static variables. The WASM binary is cached by the browser's HTTP cache, so re-creation is fast after the first run.
  - Test case: `static int count; return ++count;` called 10 times → outputs `1 2 3 4 5 6 7 8 9 10`. Previously, the second run would output `11 12 13 14 15 16 17 18 19 20`. Now correctly outputs `1 2 3 4 5 6 7 8 9 10` on every run.

### Changed
- **`cppworker.js`** — The WASM module (`self.xeusModule`) is now recreated on each execution instead of just recreating the kernel. This ensures all state is clean: static variables, global variables, JIT-compiled code, and REPL history.

## [0.2.9] - 2026-07-10

### Added
- **Step into constructors and methods** — member function bodies (constructors, destructors, methods, operators) inside `struct`/`class` definitions are now instrumented with trace calls. When `Point p1(3, 4)` is executed, a `Point` frame appears on the call stack. When `p1.getX()` is called, a `getX` frame appears with the `this` pointer visible. This matches Python Tutor's behavior.
- **`this` pointer visualization** — inside member functions, the `this` pointer is captured and displayed as a `C_DATA` pointer with the object's memory address. Uses `cap_this()` method in `opt_trace.h` which takes `void* thisPtr` (since `this` is a prvalue and `&this` is invalid in C++).
- **Empty-body constructor instrumentation** — constructors with empty bodies (e.g., `Point(int x, int y) : x(x), y(y) {}`) are split open to inject a trace call inside the body, so the constructor frame still appears on the call stack.

### Fixed
- **Trace calls placed at class scope** — `__opt_trace_fn__` calls for empty-body constructors were placed AFTER the `}` of the constructor body but BEFORE `};` of the class, which is invalid C++ (function call at class scope). Fixed by splitting the constructor line to inject the trace INSIDE the body: `Point(...) {` + trace + `}`.
- **`this` pointer leaking into `main()`** — `this` was added to `knownVars` when entering a member function but not removed when the function ended, causing `cap("this", this)` to appear in `main()` traces. Root cause: `inStructBody` block ran before the closing brace handler when `inFunctionBody` was true, preventing scope cleanup. Fixed by adding `!inFunctionBody` condition to the `inStructBody` block.
- **Extra scope pushed for struct/class bodies** — `class Point {` triggered the generic `{` scope push in addition to struct body tracking, causing `scopeStack.length` to be 2 instead of 1 when a member function ended. Fixed by skipping scope push for `struct`/`class` lines.
- **`cap_this` used wrong `this`** — `cap_this()` was a method of `__opt_tracer__`, so `this` inside it referred to the tracer object, not the user's `Point`. Fixed by passing the user's `this` pointer as a `void*` parameter.

### Changed
- **`instrument.js`** — `inStructBody` block now skips when `inFunctionBody` is true (member function body is being processed). Member function detection uses regex `^([\w:~]+\s+~?\w+|~?\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]*)?\{` to match constructors, destructors, and methods. `inMemberFunction` flag tracks member function context. Closing brace handler returns to `inStructBody` mode when a member function ends. `genCaptures()` uses `cap_this()` for the `this` variable. `parseDeclaration` no longer pushes scope for `struct`/`class` lines. Member function body traces use `__opt_trace_fn_this__()` (non-lambda) instead of `__opt_trace_fn__()` with lambda, because template lambdas inside member function bodies do not execute in clang-repl.
- **`opt_trace.h`** — `cap_this(const std::string& typeName, void* thisPtr)` method encodes `this` as a `C_DATA` pointer with the object's address. `__opt_trace_fn_this__()` global function captures `this` without a lambda. `__opt_trace_fn_struct__()` and `__opt_trace_fn_this_struct__()` variants for struct captures in member functions.

### Known Limitations
- **`return 0;` step may be missing** — when `main()` contains complex expressions (e.g., `cout << p1.getX() << endl;`), the trace for the final `return 0;` statement may not create a visible step. This is a clang-repl timing issue where the `return` exits `main()` before the trace is fully flushed. The constructor and method stepping still work correctly.
- **Lambda traces inside member functions** — template lambdas (`[&](auto& __t__) { ... }`) inside member function bodies defined inside class/struct definitions do not execute in clang-repl. Workaround: use `__opt_trace_fn_this__()` (a regular function call, no lambda) which captures `this` without needing a lambda.

## [0.2.8] - 2026-07-10

### Added
- **`class` keyword support** — `class` definitions are now tracked the same as `struct`. The instrumenter detects `class Name {` at file scope, tracks the body, and collects public field declarations for visualization. Classes with public fields render as `C_STRUCT` with visible field values; classes with only private/protected fields fall back to `object TypeName <unknown>`.
- **Access control tracking** — `public:`, `private:`, and `protected:` specifiers inside class/struct bodies are recognized. Only `public` fields are collected for visualization (private/protected fields cannot be accessed from outside the class in clang-repl). Default access is `public` for `struct`, `private` for `class`.
- **Constructor-call syntax parsing** — `parseDeclaration` now recognizes `Type name(args)` syntax (e.g., `Point p1(3, 4)`, `String s1("hello")`) in addition to `Type name = value`. Previously, constructor calls were mistaken for function definitions and skipped.

### Fixed
- **Struct body `};` not ending struct tracking** — the `};` line matched an early `continue` before the `structBraceDepth <= 0` check, leaving `inStructBody` true forever. This caused all subsequent code (including `int main() {`) to be treated as struct body content with no trace injections. Fixed by checking `structBraceDepth <= 0` first, before any `continue` statements.
- **Member function definitions inside class body** — `Point(int x, int y) : x(x), y(y) {}` and `int getX() { return x; }` were being treated as top-level function definitions, triggering `inFunctionBody = true` and trace injections inside the class body. Fixed by skipping lines with `(` and `{` inside struct bodies.
- **Access specifiers triggering trace injections** — `public:`, `private:`, `protected:` lines were being processed as statements. Fixed by detecting and skipping them in both `parseDeclaration` and the struct body handler.
- **`operator=` parsed as field name** — `String& operator=(const String& o)` was parsed by `parseDeclaration` as a field named `operator`, generating invalid `__opt_field__("operator", s2.operator)`. Fixed by skipping lines containing `operator` keyword.
- **Constructor/destructor definitions parsed as declarations** — `Point(int x, int y) {` and `~Point() {` were being parsed as variable declarations. Fixed by adding regex checks to skip constructor/destructor patterns.

### Changed
- **`instrument.js`** — `genCaptures()` helper now used for all capture generation blocks. Struct body handling moved before function detection to prevent member functions from triggering `inFunctionBody`. `parseDeclaration` has new regex checks for operator overloads, access specifiers, constructor/destructor definitions, and closing braces. Constructor-call syntax (`name(args)`) is now recognized as a valid declaration form.
- **`parseDeclaration`** — function definition check now requires `{` on the same line (was `\{|\s*$` which matched constructor calls after semicolon removal).

### Known Limitations
- **Private/protected fields not visible** — C++ access control prevents accessing private/protected members from outside the class. Python Tutor can show all fields because it uses gdb/compiler internals. Our clang-repl approach can only access public fields. Classes with only private fields show as `object TypeName <unknown>`.
- **Member functions not stepped into** — calling `p1.getX()` does not create a separate stack frame for `getX()`. This is a clang-repl limitation (trace injections inside member function bodies may not execute).

## [0.2.7] - 2026-07-10

### Added
- **Custom class/struct visualization** — `struct` and `class` instances now render as `C_STRUCT` with visible field names and values, matching Python Tutor's behavior. The instrumenter tracks struct definitions (field names and types) and generates `cap_struct()` calls that encode each field individually. Example: `struct Point { int x; int y; };` renders as `object Point` with fields `x: int <value>` and `y: int <value>` inline in the stack frame.

### Fixed
- **Struct field declarations treated as variables** — `int x;` and `int y;` inside `struct Point {}` were being parsed as global variable declarations and added to `knownVars`, causing "use of undeclared identifier" errors when `cap("x", x)` was generated. Fixed by tracking struct/class body brace depth and skipping all declarations inside struct bodies.
- **Struct member assignments treated as declarations** — `p1.x = 3;` was being parsed by `parseDeclaration` as a new variable declaration. Added regex checks to skip struct member assignments (`obj.field = value`) and array element assignments (`arr[i] = value`).

### Changed
- **`instrument.js`** — tracks struct/class definitions (`structDefs` map: type name → field list). Uses `genCaptures()` helper for all capture generation blocks (main, for-loop, function entry). Detects `struct Name {` and `class Name {` at file scope, collects field declarations, and skips them from `globalVars`.
- **`opt_trace.h`** — `cap_struct()` template method builds `C_STRUCT` JSON from pre-encoded fields. `__opt_field__()` helper encodes a single field as `["fieldName", C_DATA_value]`.

## [0.2.6] - 2026-07-10

### Added
- **Heap memory visualization** — `int* p = new int(42)` and `int* arr = new int[3]` now render heap objects with pointer arrows from the stack to the heap, matching Python Tutor's behavior. `cap_ptr()` in `opt_trace.h` captures heap-allocated pointers and embeds heap data as a `C_ARRAY` in the trace. `instrument.js` detects `new T(value)` and `new T[size]` allocations and routes them through `cap_ptr()` instead of `cap()`. `runner.ts` extracts the `__heap__` pseudo-variable from `encoded_locals` and builds the `heap` object for the frontend.
- **Heap removal after `delete`/`delete[]`** — `instrument.js` detects `delete ptr;` and `delete[] ptr;` statements and marks the pointer as freed. Subsequent trace steps use `cap_deleted_ptr()` which sets the pointer address to `0x0` (NULL), preventing the frontend's `isHeapRef()` from matching and rendering a stale heap object.

### Fixed
- **Assertion error popups** — the frontend's `assert()` function called `alert("Assertion Failure")` which showed a popup box on every step that triggered an assertion. Made `assert()` non-fatal (logs to console, no `alert`, no `throw`). Replaced hard asserts in `renderPrimitiveObject` and `renderNestedObject` with graceful fallback rendering for unknown object types. Made duplicate jsPlumb connection endpoint registrations non-fatal (C array elements share address-based IDs). Made `heapObj` undefined check non-fatal in `precomputeCurTraceLayouts` (handles pointers referencing freed addresses).
- **C_DATA pointer type label** — changed from `"pointer to int"` to `"pointer"` to match the frontend's `isHeapRef()` check (`obj[2] === 'pointer'`). The previous label caused heap objects to never be rendered.
- **C_ARRAY format** — removed the size array (`[size]`) from the C_ARRAY JSON. The frontend's `renderCStructArray()` skips indices 0–1 and treats indices 2+ as elements; the size array was being rendered as element 0. Format is now `["C_ARRAY", "addr", elem1, elem2, ...]`.

### Changed
- **`opt_trace.h`** — `cap_ptr()` stores heap data as a fake `__heap__` variable in `locals` (via `add()`), which is the only `std::string` member that can be modified in clang-repl WASM and read back later. `cap_deleted_ptr()` shows the pointer on the stack as NULL with no heap entry. `__opt_encode_data__` for pointers now uses type label `"pointer"` (was `"pointer to <type>"`).
- **`runner.ts`** — post-processes each trace entry: scans all frames' `encoded_locals` for `__heap__` entries, parses the `HEAP:` prefix, builds the `heap` object via `JSON.parse`, and removes `__heap__` from `encoded_locals` and `ordered_varnames`.
- **`pytutor.ts`** — `assert()` is now non-fatal (logs only, no alert/throw). Unknown object types in `renderPrimitiveObject` and `renderNestedObject` render as strings instead of asserting. Duplicate connection endpoint IDs are silently overwritten instead of asserting.

## [0.2.5] - 2026-07-10

### Fixed
- **Duplicate `main` frames** — the recursion detection heuristic used `line <=` (non-strict), which triggered on same-line trace calls (e.g., post-cout traces) and pushed a duplicate `main` frame. Changed to `line <` (strict) so same-line traces are treated as continuations, not recursive calls.
- **Missing `add` frame when global variables present** — the global variable check was placed before the function definition check in the instrumenter, causing function definitions like `int add(int a, int b) {` to be output without instrumentation. Reordered: function definition detection runs first.
- **Step synchronization / premature stdout** — removed post-cout and post-return trace calls that caused stdout to appear before the corresponding line was highlighted as "next to execute". The last step now correctly shows the `std::cout` line as "just executed" with the output.

### Added
- **Global variable visualization** — file-scope variable declarations (e.g., `int x = 10;`) are now displayed in a separate "Global variables" frame, matching Python Tutor's behavior. The instrumenter returns global variable names alongside the instrumented code; the runner moves them from `main`'s `encoded_locals` to the `globals`/`ordered_globals` trace fields so the frontend renders them in the globals area.

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
