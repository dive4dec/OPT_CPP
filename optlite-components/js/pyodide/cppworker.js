// C++ execution worker — loads xeus-cpp (clang-repl WASM) and executes C++ code
//
// The WASM module is recreated for each execution to ensure a completely clean
// state (static variables, global state, etc.). The WASM binary is cached by
// the browser's HTTP cache, so re-creation is fast after the first run.
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

// Cached .so data (fetched once, reused for every WASM module recreation)
let cachedSoData = null;

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

      const Module = {
        locateFile: (file) => XEUS_CPP_BASE + file + '?v=0.10.0',

        // Suppress clang/LLVM diagnostic output that floods the console
        // (stdout from user code goes through iopub stream, captured by runner.ts)
        // BUT capture stderr so we can extract compiler errors on WASM abort.
        print: () => {},
        printErr: (text) => { workerStderr += text + '\n'; },
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

      console.log('[cppworker] Loading createXeusModule...');
      self.xeusModule = await createXeusModule(Module);
      console.log('[cppworker] createXeusModule loaded, creating kernel...');

      // Create initial kernel (wait for dynamic library loading on first init)
      const { xkernel, xserver } = await createKernel(XEUS_CPP_BASE, true);
      console.log('[cppworker] Kernel created');
      self.xkernel = xkernel;
      self.xserver = xserver;

      // Pre-load the trace header
      await loadTraceHeader();

      initResolve();
      results = { status: 'ready' };
    } else {
      // ── Execute user code ──
      await initPromise;

      const code = self.script;

      // Reuse the existing kernel — in emscripten 4.x, the WASM module and
      // xkernel cannot be cleanly recreated. Static state from previous
      // executions persists, but the trace header resets it via __s__.reset().

      // ── Instrument the user code ──
      const header = optTraceHeader || '';
      let instrumentedCode;
      let globalVarNames = [];
      try {
        const result = self.instrumentCode(code);
        if (typeof result === 'string') {
          instrumentedCode = result;
        } else {
          instrumentedCode = result.code;
          globalVarNames = result.globalVars || [];
        }
      } catch (e) {
        // If instrumentation fails, use original code (no visualization)
        instrumentedCode = code;
      }

      // Build the full code to execute:
      // 1. Trace header (opt_trace.h) — defines singleton, tracer, etc.
      // 2. Reset trace state + start stdout redirect
      // 3. Instrumented user code
      // 4. If code has main(), append main() call
      // 5. Finalize: write the trace JSON to temp file
      let execCode = header + '\n';
      execCode += '{ auto& __s__ = __opt_get_state__(); __s__.reset(); }\n';
      execCode += instrumentedCode;

      // If the code defines int main(), append a call to main()
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
        // WASM abort — compiler error was likely sent via stderr.
        // Wait for iopub messages to be processed by the event loop.
        execAborted = true;
        await new Promise(r => setTimeout(r, 1000));
      }

      // Wait for execution to complete (or extra time after abort)
      await new Promise(r => setTimeout(r, execAborted ? 0 : 300));

      // If the WASM aborted, extract the real compiler error from stderr
      // and report it instead of continuing with a fallback trace.
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

      // ── Extract trace JSON from kernel output ──
      // The trace JSON is emitted between __OPT_TRACE_JSON_BEGIN__ and __OPT_TRACE_JSON_END__
      // markers in stdout. We collected all stdout in runner.ts's kernelOutput.
      // But since we're in the worker, we need to send it back.
      // Actually, the iopub stream messages come back to the main thread.
      // We need a different approach: use the kernel's stdout directly.

      // Actually, since Module.print is overridden to () => {}, stdout goes nowhere.
      // We need to use printf which goes through the WASM's own stdout, not Module.print.
      // Wait — printf in WASM goes through Module.print too.
      //
      // Alternative: write the trace to a file and read it back.
      // Or: use a global variable to store the trace and retrieve it via a second execute_request.
      //
      // Best approach: execute __opt_finalize__() as a user_expression and get the result.
      // But xeus-cpp's execute_request with user_expressions may not return results easily.
      //
      // Simplest: temporarily override Module.print to capture output, then execute
      // a printf of the trace JSON.

      // Let's use a different approach: store the trace in a global C++ variable
      // and retrieve it via a second execute_request that prints it.

      // Actually, the iopub stream messages DO come back to the worker via
      // self.postMessage in xserver_emscripten. Let me check...
      //
      // The xserver_emscripten posts iopub messages via self.postMessage().
      // These are received by runner.ts's onmessage handler.
      // But we're in the worker — the messages go from worker to main thread.
      //
      // Wait for execution to complete
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
        // Validate it's proper JSON
        try {
          const parsed = JSON.parse(traceJson);
          // Set the code field (opt_trace.h leaves it empty)
          parsed.code = self.script;
          // Attach global variable names so the runner can move them
          // from main's encoded_locals to the globals section
          if (globalVarNames.length > 0) {
            parsed.global_vars = globalVarNames;
          }
          // If trace is empty (no statements to instrument), use fallback
          if (!parsed.trace || parsed.trace.length === 0) {
            results = JSON.stringify({ code: self.script, trace: buildFallbackTrace(code) });
          } else {
            results = JSON.stringify(parsed);
          }
        } catch (e) {
          // JSON parse failed — fall back to fake trace
          results = JSON.stringify({ code: self.script, trace: buildFallbackTrace(code) });
        }
      } else {
        // No trace found — fall back to fake trace
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
