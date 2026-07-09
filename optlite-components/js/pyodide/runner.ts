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
        // Compiler errors come through as stderr streams
        kernelHasError = true;
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
          const lineMatch = kernelErrorText.match(/input_line_\d+:(\d+):/);
          if (lineMatch) {
            errorLine = parseInt(lineMatch[1]);
          }
          let errorMsg = kernelErrorText.split('\n')
            .find(l => l.includes('error:')) || 'Compilation error';
          errorMsg = errorMsg.replace(/^input_line_\d+:\d+:\d+:\s*/, '').trim();

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
        // Note: success path no longer needs stdout injection — the trace
        // runtime (opt_trace.h) captures stdout per-step automatically.

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
