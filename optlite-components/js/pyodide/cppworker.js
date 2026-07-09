// C++ execution Web Worker — loads xeus-cpp (clang-repl WASM) and executes C++ code
//
// The kernel is recreated before each execution to ensure a clean REPL state,
// avoiding "redefinition of 'main'" errors when the user re-runs code.

let initResolve, initReject;
const initPromise = new Promise((res, rej) => { initResolve = res; initReject = rej; });

// Cached .so data (fetched once, reused for every kernel recreation)
let cachedSoData = null;

// ── Create a fresh kernel from a clean module ──
async function createKernel(XEUS_CPP_BASE) {
  const M = self.xeusModule;

  // Write the .so into the FS (may already exist from a previous kernel)
  try {
    M.FS_createPath('/', 'lib', true, true);
    M.FS.writeFile('/lib/libclangCppInterOp.so', cachedSoData);
  } catch (e) {
    // already exists
  }

  // Ensure symbols are globally available
  try {
    M.loadDynamicLibrary('/lib/libclangCppInterOp.so', { global: true, nodelete: true });
  } catch (e) {
    // may already be loaded
  }

  // Create and start a fresh kernel
  let xkernel;
  try {
    xkernel = new M.xkernel(["xcpp"]);
  } catch (e) {
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

  for (const key of Object.keys(context)) {
    self[key] = context[key];
  }

  const XEUS_CPP_BASE = self.xeusCpp ||
    new URL('./xeus-cpp/', self.location.href).href;

  try {
    let results;
    if (id < 0) {
      // ── Initialize worker (one-time setup) ──
      importScripts(XEUS_CPP_BASE + 'xcpp.js');

      // Fetch the .so once and cache it
      const soUrl = XEUS_CPP_BASE + 'libclangCppInterOp.so';
      const soResponse = await fetch(soUrl);
      const soArrayBuffer = await soResponse.arrayBuffer();
      cachedSoData = new Uint8Array(soArrayBuffer);

      const Module = {
        locateFile: (file) => XEUS_CPP_BASE + file,

        preRun: [
          function() {
            const M = self.xeusModule || Module;
            try {
              M.FS_createPath('/', 'lib', true, true);
              M.FS.writeFile('/lib/libclangCppInterOp.so', cachedSoData);
            } catch (e) { /* may already exist */ }
          }
        ],
      };

      self.xeusModule = await createXeusModule(Module);

      // Create initial kernel
      const { xkernel, xserver } = await createKernel(XEUS_CPP_BASE);
      self.xkernel = xkernel;
      self.xserver = xserver;

      initResolve();
      results = { status: 'ready' };
    } else {
      // ── Execute user code ──
      await initPromise;

      const code = self.script;
      const lines = code.split('\n');

      // Recreate the kernel for a clean REPL state — avoids redefinition errors
      try {
        if (self.xkernel && typeof self.xkernel.delete === 'function') {
          self.xkernel.delete();
        }
      } catch (e) {
        // delete() may not exist; just drop the reference
      }

      const { xkernel, xserver } = await createKernel(XEUS_CPP_BASE);
      self.xkernel = xkernel;
      self.xserver = xserver;

      // Tell the main thread to flush any output from kernel init (e.g. "Core instantiated")
      self.postMessage({ type: 'flush' });

      // If the code defines int main(), append a call to main() at the end.
      // xeus-cpp is a REPL (clang-repl) — it compiles function definitions
      // but does NOT execute them. We need to explicitly call main().
      let execCode = code;
      if (/\bint\s+main\s*\(\s*\)/.test(code) || /\bvoid\s+main\s*\(\s*\)/.test(code)) {
        execCode = code + '\nmain();';
      }

      // Send ALL code in a single execute_request
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

      self.xserver.notify_listener(executeRequest);

      // Wait for iopub messages to be processed on the main thread
      await new Promise(r => setTimeout(r, 200));

      // Build trace — one entry per non-empty line
      const trace = [];
      let lastNonEmptyLine = 1;

      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        if (lines[i].trim() === '') continue;
        lastNonEmptyLine = lineNum;
        trace.push({
          line: lineNum,
          event: 'step_line',
          func_name: 'main',
          globals: {},
          ordered_globals: [],
          stack_to_render: [],
          heap: {},
          stdout: '',
        });
      }

      if (trace.length > 0) {
        trace[trace.length - 1].line = lastNonEmptyLine;
      }

      results = JSON.stringify({
        code: self.script,
        trace: trace,
      });
    }
    self.postMessage({ results, id });
  } catch (error) {
    self.postMessage({ error: 'Failed to run code: ' + error.message, id });
  }
};
