// C++ execution worker — loads xeus-cpp (clang-repl WASM) and executes C++ code
//
// Option 3: Before each execution, try to recreate the xkernel (delete old +
// create new) to get a clean REPL state. This fixes redefinition of ALL
// functions, not just main(). The WASM module itself is NOT recreated (that's
// impossible in emscripten 4.x within the same worker).
//
// If xkernel.delete() hangs (as reported in earlier attempts), the main thread
// (runner.ts) has a 15s timeout — it terminates this worker and creates a fresh
// one (Option 1 fallback).
//
// Code instrumentation: user code is instrumented with __opt_trace__() calls
// that capture variable state at each step, producing a Python Tutor-compatible
// trace with globals, stack frames, heap, and stdout.

// Load the code instrumenter (cache-busted to ensure latest version)
importScripts('./instrument.js?v=' + Date.now());

// Capture stderr from iopub stream messages so we can include the real
// compiler error in the error message when the WASM aborts.
let workerStderr = '';
const _origPostMessage = self.postMessage.bind(self);
self.postMessage = function(msg) {
  // Intercept iopub stream messages to capture stderr
  if (msg && msg.header && msg.header.msg_type === 'stream' && msg.content) {
    if ((msg.content.name || '') === 'stderr') {
      workerStderr += msg.content.text || '';
    }
  }
  return _origPostMessage(msg);
};

let initResolve, initReject;
const initPromise = new Promise((res, rej) => { initResolve = res; initReject = rej; });

// ── Load opt_trace.h content ──
let optTraceHeader = null;
async function loadTraceHeader() {
  if (optTraceHeader) return optTraceHeader;
  try {
    const resp = await fetch(new URL('./opt_trace.h?v=' + Date.now(), self.location.href).href);
    optTraceHeader = await resp.text();
  } catch (e) {
    console.error('[cppworker] Failed to load opt_trace.h:', e);
    optTraceHeader = '';
  }
  return optTraceHeader;
}

// ── Create a fresh kernel from a clean module ──
async function createKernel(XEUS_CPP_BASE, waitForDeps = false) {
  const M = self.xeusModule;

  // Wait for all run dependencies (dynamic library loading) to complete.
  // Only needed on first init — the WASM module auto-loads .so files.
  if (waitForDeps) {
    await new Promise(resolve => {
      M.monitorRunDependencies = n => { if (n === 0) resolve(); };
      M.addRunDependency('dummy');
      M.removeRunDependency('dummy');
    });
  }

  // Create and start a fresh kernel with C++23 standard
  // argv matches the xeus-cpp 0.10.0 kernel spec for xcpp23
  const argv = [
    'xcpp',
    '-resource-dir', '/lib/clang/21',
    '-Xclang', '-iwithsysroot/include/compat',
    '-std=c++23',
    '-fwasm-exceptions', '-mllvm', '-wasm-enable-sjlj', '-msimd128'
  ];
  let xkernel;
  try {
    xkernel = new M.xkernel(argv);
  } catch (e) {
    console.error('[cppworker] xkernel(argv) failed, trying default:', e);
    xkernel = new M.xkernel();
  }
  const xserver = xkernel.get_server();
  xkernel.start();

  return { xkernel, xserver };
}

self.onmessage = async (event) => {
  const msg = event.data;

  // ── User message ──
  const { id, ...context } = msg;

  // Reset stderr capture for this execution
  workerStderr = '';

  for (const key of Object.keys(context)) {
    self[key] = context[key];
  }

  const XEUS_CPP_BASE = self.xeusCpp ||
    new URL('./xeus-cpp/', self.location.href).href;

  try {
    let results;
    if (id < 0) {
      // ── Initialize worker (one-time setup) ──
      // Cache-bust xcpp.js to ensure we get the version matching this build
      importScripts(XEUS_CPP_BASE + 'xcpp.js?v=0.10.0');

      // Track whether user code execution has started (first sentinel seen).
      // Before that, stdout is clang compiler diagnostics which we suppress.
      // Reset for each execution.
      self._userExecutionStarted = false;
      const SENTINEL = '\x01\x02__OPT_STEP__\x02\x01';

      const Module = {
        locateFile: (file) => XEUS_CPP_BASE + file + '?v=0.10.0',

        INITIAL_MEMORY: 134217728, // 128MB (2048 pages) — xeus-cpp 0.10.0 wasm binary requires 2048 pages minimum

        // Route stdout through iopub stream so runner.ts can capture it.
        // Suppress clang compiler diagnostics (emitted before user code runs)
        // by only forwarding after the first sentinel marker is seen.
        print: (text) => {
          const str = text !== undefined ? String(text) : '';
          if (str.includes(SENTINEL)) {
            self._userExecutionStarted = true;
          }
          if (self._userExecutionStarted) {
            _origPostMessage({
              header: { msg_type: 'stream' },
              content: { name: 'stdout', text: str + '\n' }
            });
          }
        },
        printErr: (text) => {
          workerStderr += (text !== undefined ? text : '') + '\n';
        },
        onAbort: (reason) => {
          // Try to send the abort reason + any captured stderr back to main thread
          // before the worker dies. Use _origPostMessage to bypass our interceptor.
          const abortMsg = typeof reason === 'string' ? reason : 'WASM aborted';
          _origPostMessage({
            header: { msg_type: 'stream' },
            content: { name: 'stderr', text: workerStderr + '\nerror: ' + abortMsg }
          });
        },
      };

      self.xeusModule = await createXeusModule(Module);

      // Create initial kernel (wait for dynamic library loading on first init)
      const { xkernel, xserver } = await createKernel(XEUS_CPP_BASE, true);
      self.xkernel = xkernel;
      self.xserver = xserver;

      // Pre-load the trace header (but don't pre-compile it — pre-compilation
      // consumes WASM memory that is then unavailable for user code like
      // <format>)
      await loadTraceHeader();

      initResolve();
      results = { status: 'ready' };
    } else {
      // ── Execute user code ──
      await initPromise;

      const code = self.script;

      // Reset stdout filtering for this execution
      self._userExecutionStarted = false;

      // ── Option 1: Fresh worker per execution ──
      // runner.ts terminates and recreates this worker before each execution,
      // so we always have a clean clang-repl kernel. No need to delete/recreate
      // xkernel here (Option 3 doesn't work — throws WebAssembly.Exception).
      // No main() renaming needed — fresh kernel has no previous declarations.

      // ── Instrument the user code ──
      // No main() renaming needed — fresh kernel has no previous declarations
      const header = optTraceHeader || '';
      let instrumentedCode;
      let globalVarNames = [];

      // Strip #include <format> — std::format is available without it
      // in clang-repl's preamble, and compiling the full <format> header
      // exhausts WASM memory and causes an abort.
      const cleanedCode = code.replace(/#include\s*[<"]format[>"]\s*\n?/gi, '');

      try {
        const result = self.instrumentCode(cleanedCode);
        if (typeof result === 'string') {
          instrumentedCode = result;
        } else {
          instrumentedCode = result.code;
          globalVarNames = result.globalVars || [];
        }
      } catch (e) {
        // If instrumentation fails, use original code (no visualization)
        instrumentedCode = cleanedCode;
      }

      // Build the full code to execute:
      // 1. Trace header (opt_trace.h) — defines singleton, tracer, etc.
      // 2. Reset trace state + start stdout redirect
      // 3. Instrumented user code (main() NOT renamed — fresh kernel)
      // 4. Call main()
      // 5. Finalize: write the trace JSON to temp file
      let execCode = header + '\n';
      execCode += '{ auto& __s__ = __opt_get_state__(); __s__.reset(); }\n';
      execCode += instrumentedCode;

      // If the code defines main(), call it
      if (/\bint\s+main\s*\(\s*\)/.test(code) || /\bvoid\s+main\s*\(\s*\)/.test(code)) {
        execCode += '\nmain();';
      }

      // Finalize: write the trace JSON to a temp file
      execCode += '\n{ FILE* __opt_f__ = fopen("/tmp/opt_trace.json", "w"); fprintf(__opt_f__, "%s", __opt_finalize__().c_str()); fclose(__opt_f__); }';

      // Send execute request
      const msgId = 'opt-' + Date.now();
      const executeRequest = {
        channel: "shell",
        header: {
          msg_id: msgId,
          username: "opt",
          session: "opt-session",
          msg_type: "execute_request",
          date: new Date().toISOString(),
          version: "5.3",
        },
        parent_header: {},
        metadata: {},
        content: {
          code: execCode,
          silent: false,
          store_history: true,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: false,
        },
        buffers: [],
      };

      let execAborted = false;
      try {
        self.xserver.notify_listener(executeRequest);
      } catch (e) {
        execAborted = true;
        await new Promise(r => setTimeout(r, 1000));
      }

      // Wait for execution to complete
      await new Promise(r => setTimeout(r, execAborted ? 0 : 300));

      // If the WASM aborted, extract the real compiler error from stderr
      if (execAborted) {
        let errorMsg = '';
        const allStderr = workerStderr;
        if (allStderr && allStderr.includes('error:')) {
          const errorLine = allStderr.split('\n')
            .find(l => l.includes('error:')) || '';
          errorMsg = errorLine.replace(/^input_line_\d+:\d+:\d+:\s*/, '').trim()
            .replace(/^.*?error:\s*/, 'error: ');
        }
        if (!errorMsg) {
          errorMsg = 'Compilation error (WASM aborted). Check your code for syntax errors.';
        }
        throw new Error(errorMsg);
      }

      await new Promise(r => setTimeout(r, 300));

      // ── Read trace JSON from WASM filesystem ──
      const M = self.xeusModule;
      let traceJson = null;
      try {
        const data = M.FS.readFile('/tmp/opt_trace.json', { encoding: 'utf8' });
        traceJson = typeof data === 'string' ? data : new TextDecoder().decode(data);
      } catch (e) {
        // File doesn't exist — fall back
      }

      if (traceJson) {
        try {
          const parsed = JSON.parse(traceJson);
          parsed.code = self.script;
          if (globalVarNames.length > 0) {
            parsed.global_vars = globalVarNames;
          }
          if (!parsed.trace || parsed.trace.length === 0) {
            results = JSON.stringify({ code: self.script, trace: buildFallbackTrace(code) });
          } else {
            results = JSON.stringify(parsed);
          }
        } catch (e) {
          results = JSON.stringify({ code: self.script, trace: buildFallbackTrace(code) });
        }
      } else {
        results = JSON.stringify({ code: self.script, trace: buildFallbackTrace(code) });
      }
    }
    self.postMessage({ results, id });
  } catch (error) {
    let errorMsg = error.message;
    if (workerStderr && workerStderr.includes('error:')) {
      const errorLine = workerStderr.split('\n')
        .find(l => l.includes('error:')) || '';
      errorMsg = errorLine.replace(/^input_line_\d+:\d+:\d+:\s*/, '').trim()
        .replace(/^.*?error:\s*/, 'error: ');
    }
    _origPostMessage({ error: errorMsg, id });
  }
};

// ── Fallback trace builder (when instrumentation fails or no trace is generated) ──
function buildFallbackTrace(code) {
  const lines = code.split('\n');
  const trace = [];
  const fid = "0xFFF000BE0";
  const fhash = "main_" + fid;
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    if (lines[i].trim() === '') continue;
    trace.push({
      line: lineNum,
      event: 'step_line',
      func_name: 'main',
      globals: {},
      ordered_globals: [],
      stack_to_render: [{
        frame_id: fid,
        func_name: 'main',
        is_highlighted: true,
        is_parent: false,
        is_zombie: false,
        line: lineNum,
        ordered_varnames: [],
        parent_frame_id_list: [],
        unique_hash: fhash,
        encoded_locals: {},
      }],
      heap: {},
      stdout: '',
    });
  }
  return trace;
}
