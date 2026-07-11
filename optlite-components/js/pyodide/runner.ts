import { OptLite, combineDefaults } from './global'

// C++ execution worker — mirrors pyodide/runner.ts but uses xeus-cpp
// In emscripten 4.x, the WASM module cannot be reinstantiated, so we
// terminate and recreate the worker for each execution to get a clean state.
let cppWorker: Worker | null = null;
const callbacks: Record<number, (data: any) => void> = {};

// Kernel output collector — iopub messages from the C++ runtime arrive here
// via self.postMessage() inside the worker (which posts to the main thread)
let kernelOutput: string[] = [];

// Track whether the kernel reported an error
let kernelHasError = false;
let kernelErrorText = '';

// ask worker to initialize xeus-cpp based on the configuration
// in a global OptLite object predefined before loading.
const initWorker = (() => {
  let id = -1; // use -ve job id for initialization
  combineDefaults(OptLite, {
    xeusCpp: '',
    packages: [],
  });

  if (!OptLite.xeusCpp) {
    OptLite.xeusCpp = new URL('./xeus-cpp/', window.location.href).href;
  } else {
    OptLite.xeusCpp = new URL(OptLite.xeusCpp, window.location.href).href;
  }

  return () => {
    return new Promise((resolve, reject) => {
      callbacks[id] = (data) => {
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      cppWorker!.postMessage({
        id,
        ...OptLite
      });
    });
  }
})();
// Create a fresh worker (used for both initial init and recreation)
function createWorker(): Worker {
  const w = new Worker(new URL("./cppworker.js", import.meta.url));
  w.onmessage = handleWorkerMessage;
  w.onerror = handleWorkerError;
  return w;
}

// Create the initial worker BEFORE calling initWorker
cppWorker = createWorker();

let init = initWorker();

// handle results from worker — both user messages and kernel iopub messages
async function handleWorkerMessage(event: MessageEvent) {
  const msg = event.data;
  const { id, ...data } = msg;

  // ── Flush signal from worker (reset output after kernel recreation) ──
  if (msg && msg.type === 'flush') {
    kernelOutput = [];
    kernelHasError = false;
    kernelErrorText = '';
    return;
  }

  // ── Kernel iopub messages (from xserver_emscripten's self.postMessage) ──
  // These have header.msg_type but no numeric id
  if (msg && msg.header && msg.header.msg_type && typeof id !== 'number') {
    if (msg.header.msg_type === 'stream' && msg.content) {
      const streamName = msg.content.name || '';
      const streamText = msg.content.text || '';
      if (streamName === 'stderr') {
        // Only treat as error if it contains "error:" — clang warnings/diagnostics
        // are also sent via stderr but don't indicate failure
        if (streamText.includes('error:')) {
          kernelHasError = true;
        }
        kernelErrorText += streamText;
      } else {
        kernelOutput.push(streamText);
      }
    } else if (msg.header.msg_type === 'error') {
      kernelHasError = true;
      kernelErrorText += msg.content?.evalue || 'Unknown error';
    }
    return;
  }

  const cb = callbacks[id];
  if (cb) {
    delete callbacks[id];

    if (data.results && typeof data.results === 'string') {
      try {
        const parsed = JSON.parse(data.results);

        if (kernelHasError) {
          // ── Error path: return a single-entry trace with uncaught_exception ──
          let errorLine = 1;
          
          // Try multiple patterns for error line extraction:
          // 1. user_code.cpp:line:col: error: (from #line directives)
          // 2. input_line_N:line:col: error:
          // 3. <unknown>:line:col: error:
          // 4. line:col: error:
          const patterns = [
            /user_code\.cpp:(\d+):(\d+:)?\s*error:/,
            /input_line_\d+:(\d+):(\d+:)?\s*error:/,
            /<unknown>:(\d+):(\d+:)?\s*error:/,
            /^(\d+):(\d+:)?\s*error:/,
            /:(\d+):(\d+:)?\s*error:/,
          ];
          for (const p of patterns) {
            const m = kernelErrorText.match(p);
            if (m) { errorLine = parseInt(m[1]); break; }
          }
          
          // If we still don't have a line, try to find it from the error message
          // by searching for the error token in the source code
          let errorMsg = kernelErrorText.split('\n')
            .find(l => l.includes('error:')) || 'Compilation error';
          errorMsg = errorMsg.replace(/^input_line_\d+:\d+:\d+:\s*/, '').trim();
          errorMsg = errorMsg.replace(/^.*?error:\s*/, 'error: ');
          
          // If errorLine is still 1 (default) or too large (line in full code),
          // try to find the error line by searching the user's source code.
          // The kernel error text may contain identifiers from the error message
          // that we can search for in the source.
          // Also, if errorLine > 100, it's probably a line in the full code
          // (header + instrumented), not the user's source.
          
          // If no line found from patterns, try to search the user's source code
          // for the error. The kernel often strips line numbers from error messages.
          // We extract identifiers from the error message and search for them.
          if (errorLine === 1 && parsed.code) {
            // Extract potential identifiers from the error message
            // e.g., "no member named 'cut'" → search for "cut"
            const memberMatch = errorMsg.match(/no member named '([^']+)'/);
            const undeclaredMatch = errorMsg.match(/undeclared identifier '([^']+)'/);
            const useOfUndeclared = errorMsg.match(/use of undeclared identifier '([^']+)'/);
            const identifier = (memberMatch || undeclaredMatch || useOfUndeclared)?.[1];
            if (identifier) {
              const codeLines = parsed.code.split('\n');
              for (let i = 0; i < codeLines.length; i++) {
                // Search for the identifier as a whole word
                const regex = new RegExp('\\b' + identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
                if (regex.test(codeLines[i]) && !codeLines[i].trim().startsWith('//')) {
                  errorLine = i + 1;
                  break;
                }
              }
            }
          }
          
          parsed.trace = [{
            line: errorLine,
            event: 'uncaught_exception',
            func_name: 'main',
            globals: {},
            ordered_globals: [],
            stack_to_render: [{
              func_name: 'main',
              frame_id: 1,
              encoded_locals: {},
              ordered_varnames: [],
              unique_hash: 'f1',
              is_parent: false,
              parent_frame_id: [],
              is_zombie: false,
            }],
            heap: {},
            stdout: '',
            exception_msg: errorMsg,
          }];
        }
        // Per-step stdout reconstruction via sentinel markers.
        // opt_trace.h emits "\x00__OPT_STEP__\x00" to std::cout after each
        // trace step. The kernel's iopub stream captures all stdout including
        // these sentinels. We split on the sentinel to get the user's actual
        // output between each pair of trace steps, then build cumulative stdout.
        if (!kernelHasError && parsed.trace && parsed.trace.length > 0) {
          const rawStdout = kernelOutput.join('');
          const SENTINEL = '\x01\x02__OPT_STEP__\x02\x01';
          const segments = rawStdout.split(SENTINEL);
          let cumulative = '';
          for (let i = 0; i < parsed.trace.length; i++) {
            if (i < segments.length) {
              cumulative += segments[i];
            }
            parsed.trace[i].stdout = cumulative;
          }
          if (segments.length > parsed.trace.length) {
            parsed.trace[parsed.trace.length - 1].stdout += segments[parsed.trace.length];
          }
        }

        // Move global variables from main's encoded_locals to globals section
        // so they appear in the "Global variables" frame like Python Tutor
        if (parsed.global_vars && parsed.trace) {
          const gvarNames: string[] = parsed.global_vars;
          for (const entry of parsed.trace) {
            if (!entry.stack_to_render || entry.stack_to_render.length === 0) continue;
            // Find the main frame (first frame or the one with func_name 'main')
            const mainFrame = entry.stack_to_render.find(f => f.func_name === 'main');
            if (!mainFrame || !mainFrame.encoded_locals || !mainFrame.ordered_varnames) continue;
            const newGlobals = {};
            const newOrderedGlobals: string[] = [];
            const newLocals = {};
            const newOrderedLocals: string[] = [];
            for (const varname of mainFrame.ordered_varnames) {
              if (gvarNames.includes(varname)) {
                newGlobals[varname] = mainFrame.encoded_locals[varname];
                newOrderedGlobals.push(varname);
              } else {
                newLocals[varname] = mainFrame.encoded_locals[varname];
                newOrderedLocals.push(varname);
              }
            }
            entry.globals = newGlobals;
            entry.ordered_globals = newOrderedGlobals;
            mainFrame.encoded_locals = newLocals;
            mainFrame.ordered_varnames = newOrderedLocals;
          }
          // Remove global_vars so the frontend doesn't see it
          delete parsed.global_vars;
        }

        // Extract __heap__ entries from all frames' encoded_locals and build heap
        if (parsed.trace) {
          for (const entry of parsed.trace) {
            if (!entry.stack_to_render) continue;
            const heap: any = {};
            for (const frame of entry.stack_to_render) {
              if (!frame.encoded_locals || !frame.ordered_varnames) continue;
              const newLocals: any = {};
              const newVarnames: string[] = [];
              for (const varname of frame.ordered_varnames) {
                if (varname === '__heap__') {
                  // Extract heap data: value is "HEAP:escaped_json"
                  const heapVal = frame.encoded_locals[varname];
                  if (typeof heapVal === 'string' && heapVal.startsWith('HEAP:')) {
                    const heapEntry = heapVal.substring(5);
                    try {
                      const parsed = JSON.parse('{' + heapEntry + '}');
                      Object.assign(heap, parsed);
                    } catch (e) {}
                  }
                } else {
                  newLocals[varname] = frame.encoded_locals[varname];
                  newVarnames.push(varname);
                }
              }
              frame.encoded_locals = newLocals;
              frame.ordered_varnames = newVarnames;
            }
            entry.heap = heap;
          }
        }

        data.results = JSON.stringify(parsed);
      } catch (e) {
        // Not valid JSON, leave as-is
      }
    }
    cb(data);
  }
};

// Handle worker errors (e.g., uncaught WASM abort that kills the worker)
function handleWorkerError(event: ErrorEvent) {
  // If we have pending callbacks, reject them with the kernel error if available
  for (const id of Object.keys(callbacks)) {
    const cb = callbacks[id];
    delete callbacks[id];
    if (kernelHasError && kernelErrorText) {
      let errorMsg = kernelErrorText.split('\n')
        .find(l => l.includes('error:')) || 'Compilation error';
      errorMsg = errorMsg.replace(/^input_line_\d+:\d+:\d+:\s*/, '').trim();
      errorMsg = errorMsg.replace(/^.*?error:\s*/, 'error: ');
      cb({ error: errorMsg });
    } else {
      cb({ error: 'Compilation error (WASM aborted). Check your code for syntax errors.' });
    }
  }
};

const asyncRun = (() => {
  let id = 0;
  return (script: string, rawInputLst: string[], options: any) => {
    id = (id + 1) % Number.MAX_SAFE_INTEGER;
    return new Promise((resolve, reject) => {
      init.then(() => {
        // Reset kernel output collector
        kernelOutput = [];
        kernelHasError = false;
        kernelErrorText = '';

        // Terminate the old worker and create a fresh one for each execution.
        // In emscripten 4.x, the WASM module cannot be reinstantiated within
        // the same worker, so we need a new worker to get a clean kernel state.
        if (cppWorker) {
          cppWorker.terminate();
        }
        cppWorker = createWorker();

        // Re-initialize the new worker before sending the execution request
        init = initWorker();
        init.then(() => {
          callbacks[id] = (data) => {
            if (data.error) {
              // The WASM abort may have sent compiler errors via iopub stderr
              // messages that haven't been processed yet. Wait briefly for them.
              setTimeout(() => {
                if (kernelHasError && kernelErrorText) {
                  let errorMsg = kernelErrorText.split('\n')
                    .find(l => l.includes('error:')) || 'Compilation error';
                  errorMsg = errorMsg.replace(/^input_line_\d+:\d+:\d+:\s*/, '').trim();
                  errorMsg = errorMsg.replace(/^.*?error:\s*/, 'error: ');
                  reject(new Error(errorMsg));
                } else {
                  reject(new Error(data.error));
                }
              }, 500);
            } else resolve(data);
          };
          cppWorker!.postMessage({
            ...options,
            script: script,
            rawInputLst: rawInputLst,
            id,
          });
        }).catch(reject);
      }).catch(reject);
    });
  };
})();

export { asyncRun };
