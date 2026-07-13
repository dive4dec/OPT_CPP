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

// Timeout for kernel recreation (Option 3). If xkernel.delete() hangs,
// we terminate the worker and create a fresh one.
let kernelRecreatingTimeout: ReturnType<typeof setTimeout> | null = null;

// ask worker to initialize xeus-cpp based on the configuration
// in a global OptLite object predefined before loading.
const initWorker = (() => {
  let id = -1; // use -ve job id for initialization
  let configDone = false;

  return () => {
    // Only set up OptLite config once, not on every worker recreation
    if (!configDone) {
      combineDefaults(OptLite, {
        xeusCpp: '',
        packages: [],
      });

      if (!OptLite.xeusCpp) {
        OptLite.xeusCpp = new URL('./xeus-cpp/', window.location.href).href;
      } else {
        OptLite.xeusCpp = new URL(OptLite.xeusCpp, window.location.href).href;
      }
      configDone = true;
    }

    return new Promise((resolve, reject) => {
      // Timeout: if the worker doesn't init within 60s, reject (WASM may have crashed)
      const timeout = setTimeout(() => {
        reject(new Error('Worker initialization timed out (WASM may have crashed)'));
      }, 60000);

      callbacks[id] = (data) => {
        clearTimeout(timeout);
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

  // ── Kernel recreation messages (from cppworker.js) ──
  // Not used in Option 1 — worker recreation is handled entirely by
  // asyncRun() below, which terminates and recreates the worker before
  // each execution.
  if (msg && msg.kernel_recreating || msg && msg.kernel_recreated || msg && msg.kernel_recreate_failed) {
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
        // Also move static local variables from ALL frames to globals section
        if ((parsed.global_vars || parsed.static_vars) && parsed.trace) {
          const gvarNames: string[] = parsed.global_vars || [];
          const svarNames: string[] = parsed.static_vars || [];
          for (const entry of parsed.trace) {
            if (!entry.stack_to_render || entry.stack_to_render.length === 0) continue;
            const newGlobals = entry.globals || {};
            const newOrderedGlobals: string[] = entry.ordered_globals || [];
            for (const frame of entry.stack_to_render) {
              if (!frame.encoded_locals || !frame.ordered_varnames) continue;
              const newLocals = {};
              const newOrderedLocals = [];
              for (const varname of frame.ordered_varnames) {
                if (gvarNames.includes(varname) && frame.func_name === 'main') {
                  newGlobals[varname] = frame.encoded_locals[varname];
                  if (!newOrderedGlobals.includes(varname)) newOrderedGlobals.push(varname);
                } else if (svarNames.includes(varname)) {
                  // Static locals go to globals regardless of which frame they're in
                  newGlobals[varname] = frame.encoded_locals[varname];
                  if (!newOrderedGlobals.includes(varname)) newOrderedGlobals.push(varname);
                } else {
                  newLocals[varname] = frame.encoded_locals[varname];
                  newOrderedLocals.push(varname);
                }
              }
              frame.encoded_locals = newLocals;
              frame.ordered_varnames = newOrderedLocals;
            }
            entry.globals = newGlobals;
            entry.ordered_globals = newOrderedGlobals;
          }
          delete parsed.global_vars;
          delete parsed.static_vars;
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

  // ── Pre-execution syntax check ──
  // Catch obvious C++ syntax errors before sending to the WASM compiler,
  // which may hang or take very long on malformed input.
  // This mirrors what g++ does instantly (e.g. Python Tutor's server-side check).
  function checkSyntax(code: string): string | null {
    const lines = code.split('\n');
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const lineNum = i + 1;

      // Handle block comments: remove content inside /* ... */ (can span lines)
      if (inBlockComment) {
        const endIdx = line.indexOf('*/');
        if (endIdx >= 0) {
          line = line.substring(endIdx + 2);
          inBlockComment = false;
        } else {
          continue; // entire line is inside a block comment
        }
      }
      // Check for block comment start on this line
      const blockStart = line.indexOf('/*');
      const blockEnd = line.indexOf('*/');
      if (blockStart >= 0 && (blockEnd < 0 || blockEnd < blockStart)) {
        line = line.substring(0, blockStart);
        inBlockComment = true;
      }

      // Skip preprocessor directives and single-line comments
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('//')) continue;

      // Skip raw string literals R"(...)" — they can span multiple lines
      // Simple heuristic: if the line contains R" and doesn't close it,
      // skip the quote check for this line
      if (/R"\(/.test(line) || /R"\[/.test(line) || /R"\{/.test(line)) {
        continue;
      }

      // Check for unterminated string literals (literal newline inside "...")
      // Remove escaped quotes and single-line comments first
      const cleaned = line
        .replace(/\\"/g, '')       // remove escaped double quotes
        .replace(/\\'/g, '')       // remove escaped single quotes
        .replace(/\/\/.*$/, '');   // remove single-line comments
      const dquotes = (cleaned.match(/"/g) || []).length;
      if (dquotes % 2 !== 0) {
        return `Line ${lineNum}: error: missing terminating " character`;
      }
    }
    return null;
  }

  return (script: string, rawInputLst: string[], options: any) => {
    id = (id + 1) % Number.MAX_SAFE_INTEGER;
    return new Promise((resolve, reject) => {

      // ── Pre-execution syntax check ──
      const syntaxError = checkSyntax(script);
      if (syntaxError) {
        reject(new Error(syntaxError));
        return;
      }

      init.then(() => {
        // Reset kernel output collector
        kernelOutput = [];
        kernelHasError = false;
        kernelErrorText = '';

        // ── Option 1: Fresh worker per execution ──
        // Terminate the current worker and create a fresh one to get a clean
        // clang-repl kernel state. This fixes redefinition of ALL functions
        // (not just main) and eliminates accumulated REPL state.
        // The WASM binary is cached by the browser, so worker creation is fast
        // after the first run (~2-3s for WASM instantiation).
        if (cppWorker) {
          cppWorker.terminate();
        }
        cppWorker = createWorker();
        init = initWorker();

        // Execution timeout: if the WASM compiler hangs during heavy template
        // instantiation, the worker's event loop is blocked and no result
        // message arrives. This timeout fires on the main thread.
        const execTimeout = setTimeout(() => {
          if (callbacks[id]) {
            delete callbacks[id];
            reject(new Error(
              'Compilation timed out. The code may be too complex for ' +
              'the browser-based compiler.'
            ));
          }
        }, 300000); // 5 minutes — <format> compilation can take a while

        // Wait for the new worker to initialize, then send the execution request
        init.then(() => {
          callbacks[id] = (data) => {
            clearTimeout(execTimeout);
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
