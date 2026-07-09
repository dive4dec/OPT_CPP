import { OptLite, combineDefaults } from './global'

// C++ execution worker — mirrors pyodide/runner.ts but uses xeus-cpp
const cppWorker = new Worker(new URL("./cppworker.js", import.meta.url));
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
      cppWorker.postMessage({
        id,
        ...OptLite
      });
    });
  }
})();
let init = initWorker();

// handle results from worker — both user messages and kernel iopub messages
cppWorker.onmessage = async (event) => {
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
          // segments[0] = output before first trace step (should be empty)
          // segments[1] = output between step 0 and step 1
          // segments[N] = output between step N-1 and step N
          // segments[N+1] = output after last trace step (should be empty)
          let cumulative = '';
          for (let i = 0; i < parsed.trace.length; i++) {
            // Output produced BEFORE this trace step's sentinel
            if (i < segments.length) {
              cumulative += segments[i];
            }
            parsed.trace[i].stdout = cumulative;
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
        callbacks[id] = (data) => {
          if (data.error) reject(new Error(data.error));
          else resolve(data);
        };
        cppWorker.postMessage({
          ...options,
          script: script,
          rawInputLst: rawInputLst,
          id,
        });
      }).catch(reject);
    });
  };
})();

export { asyncRun };
