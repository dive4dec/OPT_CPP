// ============================================================================
// cpp-completion.ts — static C++ completion source for the OPT_CPP editor.
//
// WHY STATIC (and not the xeus-cpp compiler)?
//   We spiked `Cpp::CodeComplete` against the deployed xeus-cpp 0.10.0 in a real
//   browser worker (2026-09-17). It is an early-stage implementation: it only
//   resolves members of plain non-template std classes (e.g. `std::string`),
//   and returns NOTHING for the two cases that matter most in a C++ teaching
//   tool — template containers (`std::vector`/`map`/`list`) and the student's
//   own `struct`/`class` — plus no prefix filtering, no `->`, and it crashed
//   the kernel when interleaved with execution. A static source handles all of
//   those, is instant, mobile-friendly, and needs zero worker-lifecycle change.
//   See skill: wasm-browser-kernels → references/xeus-cpp-completion-feasibility.md
//
// WHAT IT COMPLETES
//   1. `myObj.` / `myObj->`   → members, resolved by scanning the document for
//                               `myObj`'s declaration to learn its type:
//                                 - STL container type → members from a static
//                                   member table (this is exactly what the
//                                   compiler *couldn't* do).
//                                 - user struct/class  → members parsed from the
//                                   type's definition body in the buffer.
//   2. `std::`                 → standard library class + free-function names
//                                from a static table.
//   3. bare identifier         → returned by `completeAnyWord` (wired in by the
//                                editor, not here) — "recall a name I typed".
//
// It is pure/functional over the document text + cursor; no WASM, no async, no
// per-keystroke cost beyond one regex pass. Safe to run on every keystroke.
// ============================================================================

import type { CompletionSource, Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

// --- static std:: name table ------------------------------------------------
// Standard library classes + the most-used free functions a CS1-level student
// writes. Labels are inserted as-is after `std::`. `type` drives grouping/icon.
const STD_NAMES: Completion[] = (() => {
  const cls = ["vector","list","deque","map","multimap","set","multiset",
    "unordered_map","unordered_set","array","stack","queue","priority_queue",
    "string","wstring","string_view","pair","tuple","size_t","size_t",
    "cout","cin","cerr","clog","endl","ends"];
  const fn = ["sort","stable_sort","partial_sort","min","max","minmax","swap",
    "abs","fabs","to_string","stoi","stoul","stol","stod","stof",
    "accumulate","fill","copy","reverse","unique","find","count","count_if",
    "for_each","transform","iota","size","begin","end","cbegin","cend",
    "crbegin","crend","make_pair","make_tuple","get","distance","iter_swap"];
  return [
    ...cls.map((n) => ({ label: n, type: "class" as const, detail: "std" })),
    ...fn.map((n) => ({ label: n, type: "function" as const, detail: "std" })),
  ];
})();

// --- static STL member tables -----------------------------------------------
// Curated to the members a student actually uses (the tail is dropped to keep
// the list focused). This is the "finite stdlib symbol table" — general,
// offline, and covers the template containers the compiler backend cannot.
const STL_MEMBERS: Record<string, string[]> = {
  string: ["size","length","empty","at","operator[]","c_str","data","substr","find","rfind","find_first_of","replace","erase","push_back","append","insert","clear","assign","compare","copy","resize","reserve","capacity","max_size","begin","end","rbegin","rend","front","back","swap","operator<","operator=="],
  vector: ["size","empty","at","operator[]","front","back","begin","end","rbegin","rend","push_back","emplace_back","pop_back","insert","erase","clear","assign","resize","reserve","capacity","data","max_size","shrink_to_fit","swap","operator<","operator=="],
  list:   ["size","empty","front","back","begin","end","push_front","pop_front","push_back","pop_back","insert","erase","clear","splice","sort","reverse","swap","emplace_front","emplace_back","assign"],
  deque:  ["size","empty","front","back","at","begin","end","push_front","pop_front","push_back","pop_back","insert","erase","clear","assign","resize","reserve","max_size","swap"],
  map:    ["size","empty","at","operator[]","begin","end","rbegin","rend","insert","emplace","find","count","lower_bound","upper_bound","erase","clear","swap","key_comp","value_comp","max_size","operator<","operator=="],
  multimap: ["size","empty","begin","end","insert","emplace","find","count","lower_bound","upper_bound","erase","clear","swap"],
  set:    ["size","empty","begin","end","rbegin","rend","find","count","lower_bound","upper_bound","insert","emplace","erase","clear","swap","operator<","operator=="],
  multiset: ["size","empty","begin","end","insert","emplace","find","count","lower_bound","upper_bound","erase","clear","swap"],
  array:  ["size","empty","at","operator[]","front","back","begin","end","rbegin","rend","fill","swap","data","operator<","operator=="],
  stack:  ["empty","size","top","push","pop"],
  queue:  ["empty","size","front","back","push","pop"],
  priority_queue: ["empty","size","top","push","pop"],
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const IDENT = /[A-Za-z_]\w*/;
const IDENT_CHARS = /[A-Za-z_0-9]/;
const KEYWORDS = new Set(["return","if","else","while","for","switch","case",
  "sizeof","default","break","continue","new","delete","int","void","auto"]);

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Normalize a declared type token to its base name: "std::vector<int>" -> "vector".
function baseType(t: string): string {
  let x = t.replace(/\s+/g, "");
  x = x.replace(/^const&?/, "");
  x = x.replace(/^(?:std::)?/, "");
  const lt = x.indexOf("<");
  if (lt > 0) x = x.slice(0, lt);
  return x;
}

// Find the declared type of a variable by name, scanning the document.
// Matches `TYPE name ;|=|{|,`  (a definition, not a call site).
function findDeclaredType(doc: string, name: string): string | null {
  const re = new RegExp(
    "((?:std::)?[A-Za-z_]\\w*(?:\\s*<[^>;{=]*>)?)\\s*(?:\\*\\s*)?" +
    escapeRe(name) + "\\s*(?:;|=|\\{|,)");
  const m = re.exec(doc);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, "");
  if (KEYWORDS.has(baseType(t))) return null;   // "return v;", "sizeof x"…
  return t;
}

// Parse data-member names out of a `struct`/`class` body (brace-matched).
// Splits the body into statements at top-level `;` or `}`, skips any statement
// containing a method body (`{`), and takes each statement's LAST identifier as
// the member name (rejecting methods, whose last identifier is followed by `(`).
// Handles `int x;`, `int x = 5;`, `int arr[3];`, `std::vector<int> v;`.
function parseUserMembers(doc: string, typeName: string): string[] {
  const re = new RegExp("(?:struct|class)\\s+" + escapeRe(typeName) + "\\s*(?:[^{]*\\{)");
  const m = re.exec(doc);
  if (!m) return [];
  const openIdx = m.index + m[0].length - 1;   // index of the opening '{'
  let depth = 0, i = openIdx;
  for (; i < doc.length; i++) {                // brace-match to the matching '}'
    const c = doc[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  const body = doc.slice(openIdx + 1, i);

  // Split into statements at top-level ';' or '}'.
  const stmts: string[] = [];
  let d = 0, start = 0;
  for (let q = 0; q < body.length; q++) {
    const c = body[q];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) { stmts.push(body.slice(start, q + 1)); start = q + 1; } }
    else if (c === ";" && d === 0) { stmts.push(body.slice(start, q + 1)); start = q + 1; }
  }
  if (start < body.length) stmts.push(body.slice(start));

  const out: string[] = [];
  for (const st of stmts) {
    if (st.includes("{")) continue;            // method definition → skip
    const ids = st.match(/[A-Za-z_]\w*/g) || [];
    if (ids.length < 2) continue;              // need `type name`
    const name = ids[ids.length - 1];
    const idRe = /[A-Za-z_]\w*/g; let mm: RegExpExecArray | null, end = 0;
    while ((mm = idRe.exec(st)) !== null) end = mm.index + mm[0].length;
    // reject methods (name immediately followed by '('); allow 'int x = ..;','int arr[..];'
    if (!KEYWORDS.has(name) && !/^\s*\(/.test(st.slice(end))) out.push(name);
  }
  return [...new Set(out)];
}

// Should we skip completing here (cursor inside a comment / string literal)?
// Text-based (not lezer) so it's reliable and version-agnostic. Docs are small
// student code, so a scan back from the cursor is cheap.
function inNonCode(doc: string, pos: number): boolean {
  let i = pos;
  while (i > 0) {
    const c = doc[i - 1];
    if (c === "\n") break;                       // line comment scope ends at EOL
    if (c === "/" && i >= 2 && doc[i - 2] === "/") return true;   // `//`
    if (c === '"') {                             // toggle string (handle escape)
      let back = i - 2; let escaped = false;
      while (back >= 0 && doc[back] === "\\") { escaped = !escaped; back--; }
      if (!escaped) i -= 2;                      // skip this paired quote region
    }
    i--;
  }
  return false;
}

function makeOptions(names: string[], type: string, detail?: string): Completion[] {
  return names.map((label) => ({ label, type, ...(detail ? { detail } : {}) }));
}

// ---------------------------------------------------------------------------
// the completion source
// ---------------------------------------------------------------------------
export const cppStaticCompletion: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const { state } = context;
  const pos = context.pos;
  const doc = state.doc.toString();

  if (inNonCode(doc, pos)) return null;

  // ── Case 1: `std::` prefix (after the std library "standard" names) ───────
  const stdTok = context.matchBefore(/\bstd::\w*$/);
  if (stdTok) {
    const from = stdTok.from + "std::".length;   // right after `std::`
    return { from, options: STD_NAMES, validFor: /\bstd::\w*$/ };
  }

  // ── Case 2: member access  `recv.` / `recv->`  (receiver is a plain id) ──
  const partial = context.matchBefore(/\w*$/);            // identifier being typed (may be "")
  const pFrom = partial ? partial.from : pos;
  const before = doc.slice(Math.max(0, pFrom - 3), pFrom);
  const isArrow = before.endsWith("->");
  const isDot = !isArrow && before.endsWith(".");
  if (isDot || isArrow) {
    const recvEnd = pFrom - (isArrow ? 2 : 1);
    let recvStart = recvEnd;
    while (recvStart > 0 && IDENT_CHARS.test(doc[recvStart - 1])) recvStart--;
    const recvName = doc.slice(recvStart, recvEnd);
    if (recvName && IDENT.test(recvName)) {
      const declared = findDeclaredType(doc, recvName);
      if (declared) {
        const base = baseType(declared);
        // (a) STL container → static member table
        const stl = STL_MEMBERS[base];
        if (stl) return { from: pFrom, options: makeOptions(stl, "property", base), validFor: /\w*$/ };
        // (b) user struct/class → parse its body
        const user = parseUserMembers(doc, base);
        if (user.length) return { from: pFrom, options: makeOptions(user, "property", base), validFor: /\w*$/ };
      }
      // (c) type not resolvable → let completeAnyWord offer typed identifiers
    }
  }

  // bare identifier / anything else → null (completeAnyWord handles it)
  return null;
};
