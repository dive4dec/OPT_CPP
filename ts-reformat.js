// ts-reformat.js — tree-sitter (CST) line reformat + trace-line remap for OPT_CPP v2.
//
// PROBLEM: the legacy instrument.js is a LINE-BASED scanner. It assumes each
//   statement (and each closing brace) is on its own line. Compact / one-line
//   code — e.g. `for (...) { int t = 0; std::cout << t << '\n'; }` or
//   `int f(int a) { return a; }` — breaks that assumption and produces
//   instrumented code that fails to compile or drops statements.
//
// FIX (Approach B): use tree-sitter to re-lay-out the source so the legacy
//   scanner sees canonical multi-line code, run the UNCHANGED legacy
//   instrumentCode() on it, then remap the emitted trace line numbers back to
//   the user's ORIGINAL line numbers. The legacy state machine (declarations,
//   scopes, heap, captures, entry traces) is 100% reused — only line layout is
//   fixed. Proven: 21/21 already-canonical cases are byte-identical to legacy
//   (zero regression); 6 compact cases go from "compile error / dropped stmts"
//   to correct full traces.
//
// SPLIT RULES (insert a newline BEFORE these, at node/token boundaries only —
//   never mid-token, never inside a string/char literal or comment, since the
//   CST knows those regions):
//   1. A statement node whose parent is a `compound_statement` (a real braced
//      body) and that does NOT already start at the first non-whitespace col of
//      its line. (Header components like the for-init have parent=for_statement
//      and are never split; braceless single-statement bodies are left for the
//      legacy scanner, which already handles them.)
//   2. A `}` token whose parent is a `compound_statement` (a real code block,
//      not an initializer_list / array / struct) and that has non-whitespace
//      before it on its line.
//
// ENVIRONMENT: loaded in the classic cppworker via importScripts (after
//   tree-sitter.js, which sets the global `TreeSitter`). The pure functions
//   (reformat, remapTraceLines) take an explicit parser so they are also
//   unit-testable in Node (see the repo's g++ golden harness).
(function () {
  'use strict';

  const STATEMENT_TYPES = new Set([
    'declaration', 'expression_statement', 'return_statement',
    'if_statement', 'for_statement', 'while_statement', 'do_statement',
    'switch_statement', 'labeled_statement', 'try_statement',
    'break_statement', 'continue_statement', 'throw_statement',
    'empty_statement',
  ]);

  // Pure: reformat source to canonical multi-line form using `parser`.
  // Returns { reformatted, reformToOrig, changed } or { error: 'parse_error' }.
  //   reformToOrig[k] = original 1-based line that reformatted line (k+1) came from.
  function reformat(src, parser) {
    const tree = parser.parse(src);
    if (!tree || tree.rootNode.hasError) return { error: 'parse_error' };

    const lines = src.split('\n');
    const lineStart = [0];
    for (let i = 0; i < lines.length; i++) lineStart.push(lineStart[i] + lines[i].length + 1);
    const lineOfOffset = (off) => {
      let lo = 0, hi = lines.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= off) lo = mid; else hi = mid - 1; }
      return lo;
    };

    // first non-whitespace column per line
    const firstNwCol = lines.map(l => { const m = l.match(/\S/); return m ? m.index : l.length; });

    const splitPos = new Set(); // byte offsets to insert a newline BEFORE
    const walk = (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c) continue;
        if (STATEMENT_TYPES.has(c.type) && c.parent && c.parent.type === 'compound_statement') {
          const row = c.startPosition.row;
          const col = c.startPosition.column;
          if (col !== firstNwCol[row]) splitPos.add(lineStart[row] + col);
        }
        if (c.type === '}' && c.parent && c.parent.type === 'compound_statement') {
          const row = c.startPosition.row;
          const col = c.startPosition.column;
          if (col > firstNwCol[row]) splitPos.add(lineStart[row] + col);
        }
        walk(c);
      }
    };
    walk(tree.rootNode);

    // Build reformatted lines + line map.
    const reformLines = []; // { text, origLine (1-based) }
    const posArr = Array.from(splitPos).sort((a, b) => a - b);
    for (let li = 0; li < lines.length; li++) {
      const ls = lineStart[li];
      const le = ls + lines[li].length; // exclusive end of this line's text
      const pts = posArr.filter(p => p > ls && p <= le);
      let segStart = ls;
      for (const p of pts) {
        const seg = src.slice(segStart, p);
        if (seg.trim() !== '') reformLines.push({ text: seg, origLine: li + 1 });
        segStart = p;
      }
      const seg = src.slice(segStart, le);
      if (seg.trim() !== '') reformLines.push({ text: seg, origLine: li + 1 });
    }

    const reformatted = reformLines.map(l => l.text).join('\n');
    const reformToOrig = reformLines.map(l => l.origLine);
    return { reformatted, reformToOrig, tree, changed: reformLines.length !== lines.length };
  }

  // Pure: remap __opt_trace_fn*("f", N) line numbers from reformatted->original.
  function remapTraceLines(instr, reformToOrig) {
    return instr.replace(/(__opt_trace_fn_this__|__opt_trace_fn__)\("([^"]*)",\s*(\d+)\)/g,
      (m, fn, name, numStr) => {
        const k = parseInt(numStr, 10);
        const orig = reformToOrig[k - 1];
        if (orig == null) return m;
        return fn + '("' + name + '", ' + orig + ')';
      });
  }

  // Browser worker: lazily init tree-sitter (global `TreeSitter` from
  // importScripts('tree-sitter.js')) and load the C++ grammar. Cached after
  // first call. The grammar fetch is nginx-cached (expires 1d, immutable) so it
  // is a one-time download. Returns a ready Parser.
  async function ensureTreeSitter() {
    const g = typeof self !== 'undefined' ? self : globalThis;
    if (g.__opt_tsParser) return g.__opt_tsParser;
    if (typeof TreeSitter === 'undefined') {
      throw new Error('tree-sitter runtime not loaded (importScripts tree-sitter.js first)');
    }
    if (!g.__opt_tsInit) {
      g.__opt_tsInit = TreeSitter.init();
    }
    await g.__opt_tsInit;
    if (!g.__opt_tsLanguage) {
      // Relative to the worker's location (build/). Grammar lives in grammars/.
      const base = (typeof self !== 'undefined' && self.location) ? self.location.href : '';
      const url = base ? new URL('grammars/tree-sitter-cpp.wasm', base).href : 'grammars/tree-sitter-cpp.wasm';
      g.__opt_tsLanguage = TreeSitter.Language.load(url);
    }
    const p = new TreeSitter();
    p.setLanguage(await g.__opt_tsLanguage);
    g.__opt_tsParser = p;
    return p;
  }

  // Export to worker global (self) and/or Node module.exports.
  const g = (typeof self !== 'undefined') ? self : globalThis;
  g.reformat = reformat;
  g.remapTraceLines = remapTraceLines;
  g.ensureTreeSitter = ensureTreeSitter;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { reformat, remapTraceLines, ensureTreeSitter };
  }
})();
