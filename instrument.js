// C++ code instrumenter — transforms user code to inject trace calls
// after each statement, enabling variable/stack/heap visualization.
//
// Strategy:
// 1. Parse C++ source to find variable declarations and their types
// 2. After each statement (line ending with ;), inject a trace call that
//    captures the current state of all known variables
// 3. The trace runtime (opt_trace.h, prepended to the code) serializes
//    variables to JSON in the Python Tutor trace format

// ── Helpers ──

// Strip comments and strings to avoid false matches when scanning for patterns
function stripCommentsAndStrings(code) {
  let result = '';
  let i = 0;
  while (i < code.length) {
    // Line comment
    if (code[i] === '/' && code[i+1] === '/') {
      while (i < code.length && code[i] !== '\n') { result += ' '; i++; }
      continue;
    }
    // Block comment
    if (code[i] === '/' && code[i+1] === '*') {
      result += '  ';
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i+1] === '/')) {
        result += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < code.length) { result += '  '; i += 2; }
      continue;
    }
    // String literal
    if (code[i] === '"') {
      result += '""';
      i++;
      while (i < code.length && code[i] !== '"') {
        if (code[i] === '\\' && i+1 < code.length) { i += 2; }
        else { i++; }
      }
      if (i < code.length) { i++; }
      continue;
    }
    // Char literal
    if (code[i] === "'") {
      result += "''";
      i++;
      while (i < code.length && code[i] !== "'") {
        if (code[i] === '\\' && i+1 < code.length) { i += 2; }
        else { i++; }
      }
      if (i < code.length) { i++; }
      continue;
    }
    // Preprocessor directive — keep the line but mark it
    if (code[i] === '#') {
      let lineStart = i;
      while (i < code.length && code[i] !== '\n') {
        // Handle line continuation
        if (code[i] === '\\' && i+1 < code.length && code[i+1] === '\n') {
          i += 2; continue;
        }
        i++;
      }
      // Keep the preprocessor line as-is (it shouldn't be instrumented)
      result += code.substring(lineStart, i);
      continue;
    }
    result += code[i];
    i++;
  }
  return result;
}

// Parse a variable declaration to extract type and variable name(s)
// Returns array of { type, name, isArray, arraySize, isPointer, isReference }
function parseDeclaration(line) {
  // Remove leading/trailing whitespace
  line = line.trim();

  // Skip struct member assignments (e.g., "p1.x = 3" or "obj.member = value")
  if (/^\w+\.\w+\s*=/.test(line)) return [];

  // Skip array element assignments (e.g., "arr[0] = 10")
  if (/^\w+\[.+\]\s*=/.test(line)) return [];

  // Skip operator overloads (e.g., "String& operator=(const String& o) { ... }")
  if (/\boperator\b/.test(line)) return [];

  // Skip access specifiers
  if (/^(public|private|protected)\s*:/.test(line)) return [];

  // Skip constructor/destructor definitions (e.g., "Point(int x, int y) {" or "~Point() {")
  if (/^~?\w+\s*\([^)]*\)\s*(\{|:)/.test(line)) return [];

  // Skip lines that are just closing braces
  if (/^[};\s]*$/.test(line)) return [];

  // Remove the trailing semicolon and anything after (e.g., initializer)
  const semiIdx = line.indexOf(';');
  if (semiIdx >= 0) line = line.substring(0, semiIdx).trim();

  // Skip if it's not a declaration (e.g., function call, return, etc.)
  // We look for patterns like: "type name", "type name = value", "type* name", etc.
  // Also skip control structures
  const skipKeywords = ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
                         'break', 'continue', 'return', 'goto', 'throw', 'try', 'catch',
                         'using', 'namespace', 'typedef', 'template', 'class', 'struct',
                         'enum', 'union', 'static_cast', 'dynamic_cast', 'reinterpret_cast',
                         'const_cast', 'sizeof', 'alignof', 'decltype', 'new',
                         'delete', 'operator'];
  // NOTE: 'auto' is NOT in skipKeywords — it's a valid type specifier (auto x = 1;)
  const firstWord = line.split(/[\s<>*&\[\]()=,{]/)[0];
  if (skipKeywords.includes(firstWord)) return [];

  // Skip if it starts with # (preprocessor)
  if (line.startsWith('#')) return [];

  // Skip if it's a function definition (has parentheses with types, followed by {)
  // e.g., "int main() {" or "void foo(int x) {"
  // But NOT constructor calls like "String s1(\"hello\")" or "Point p1(3, 4)"
  if (/\w+\s+\w+\s*\([^)]*\)\s*\{/.test(line) && !line.includes('=')) return [];

  // Parse: [const] type [*|&]* name [= value] [, name [= value]]*
  // We need to handle:
  //   int x = 5;
  //   int x = 5, y = 3;
  //   int* p = &x;
  //   std::string s = "hello";
  //   int arr[10];
  //   int arr[] = {1, 2, 3};

  // Extract the type (everything before the first variable name)
  // Strategy: find the first identifier that's followed by [=,;[] or end
  const tokens = line.match(/^((?:const\s+)?(?:static\s+)?(?:unsigned\s+|signed\s+)?(?:std::)?[\w:]+(?:\s*<[^>]*>)?)\s*([*&]*)\s*(.+)$/);
  if (!tokens) return [];

  let baseType = tokens[1].trim();
  let pointerRef = tokens[2] || '';
  let rest = tokens[3] || '';

  // Strip 'static' keyword from type and track it separately
  let isStatic = false;
  if (baseType.startsWith('static ')) {
    isStatic = true;
    baseType = baseType.replace(/^static\s+/, '');
  }

  // Now parse the variable list: name [= value] [, name [= value]]*
  const vars = [];
  // Split by comma, but not inside <>, (), {}, [], or ""
  let current = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (inStr) {
      current += c;
      if (c === '\\' && i+1 < rest.length) { current += rest[++i]; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; current += c; continue; }
    if (c === '<' || c === '(' || c === '{' || c === '[') depth++;
    if (c === '>' || c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      vars.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim()) vars.push(current.trim());

  const result = [];
  for (let v of vars) {
    // Handle pointer/reference prefix on individual variables:
    // "const char *sep_, *end_" → first var has pointerRef='*', second has '*end_'
    // Strip leading * or & and merge with pointerRef
    let varPointerExtra = '';
    while (v.startsWith('*') || v.startsWith('&')) {
      varPointerExtra += v[0];
      v = v.slice(1).trim();
    }
    // Parse: name [= value] or name[size] or name[] = {...} or name[M][N] = {...}
    //   or name(args) — constructor call (e.g., "s1(\"hello\")" or "p1(3, 4)")
    // Capture multiple array dimensions: name[2][3]
    let nameMatch = v.match(/^(\w+)\s*((?:\[[^\]]*\])*)\s*(=.*)?$/);
    // Also match constructor-call syntax: name(args)
    if (!nameMatch) {
      nameMatch = v.match(/^(\w+)\s*\([^)]*\)$/);
    }
    if (!nameMatch) continue;

    let name = nameMatch[1];
    let arrayPart = nameMatch[2];
    let init = nameMatch[3];

    let isArray = !!arrayPart;
    let arraySize = null;
    let arrayDims = [];
    if (isArray) {
      // Extract all dimensions: [2][3] → [2, 3], [] → [0] (unsized)
      let dimMatches = arrayPart.match(/\[(\d*)\]/g);
      if (dimMatches) {
        arrayDims = dimMatches.map(d => {
          let n = d.match(/\d+/);
          return n ? parseInt(n[0]) : 0;
        });
        arraySize = arrayDims[0];
      }
    }

    let isPointer = pointerRef.includes('*') || baseType.includes('*') || varPointerExtra.includes('*');
    let isReference = pointerRef.includes('&') || baseType.includes('&') || varPointerExtra.includes('&');

    // Clean up baseType (remove trailing * or &)
    let cleanType = baseType.replace(/[*&]/g, '').trim();

    result.push({
      type: cleanType,
      name: name,
      isArray: isArray,
      arraySize: arraySize,
      arrayDims: arrayDims,
      isPointer: isPointer,
      isReference: isReference,
      isStatic: isStatic,
      init: init || null,
    });
  }

  return result;
}

// ── Main instrumentation function ──

// Parse a lambda capture list into a Set of captured names. Returns null when the
// capture is a default ([&], [=], [&x], [=x]) meaning "all outer vars accessible".
function lambdaCaptureSet(captureStr) {
  const s = (captureStr || '').trim();
  if (s === '') return new Set();            // []  nothing captured
  if (/^[\[&=]/.test(s) && (s === '&' || s === '=')) return null; // [&] / [=] all
  if (/^[\[&=][&=]/.test(s) || /&\s*=|\=\s*&/.test(s)) return null; // [&x]/[=x] all
  if (/^[\[&=]/.test(s)) {
    // explicit list: "[a, &b, c = 1]"
    const inner = s.replace(/^\[/, '').replace(/\]$/, '');
    const set = new Set();
    for (let part of inner.split(',')) {
      part = part.trim();
      if (!part) continue;
      const m = part.match(/^&?\s*(\w+)/);
      if (m) set.add(m[1]);
    }
    return set;
  }
  return new Set();
}

// If the current top scope is a LAMBDA body, return the set of names legal to
// reference inside it (its captures + its parameters + variables declared in the
// current scope). Returns null when not inside a lambda (no restriction). A
// default-capture lambda ([&]/[=]) returns null → everything accessible.
// Outer-scope locals that the lambda does NOT capture are correctly EXCLUDED
// (they are not in the current scope's vars, nor in the capture list), so a trace
// injected inside the lambda body will not reference them → no "is not captured".
function lambdaAllowedNames(scopeStack, lambdaStack) {
  if (!lambdaStack || lambdaStack.length === 0) return null;
  const top = lambdaStack[lambdaStack.length - 1];
  const curScope = scopeStack[scopeStack.length - 1];
  if (top.captures === null) return null; // default capture → everything accessible
  const allowed = new Set();
  for (let n of top.captures) allowed.add(n);
  if (top.params) for (let n of top.params) allowed.add(n);
  if (curScope && curScope.vars) for (let n of curScope.vars) allowed.add(n);
  return allowed;
}

// The knownVars map to feed genCaptures at this point: restricted to the
// lambda-capturable names when inside a lambda body, else the full map.
function varsForCaps(scopeStack, lambdaStack, knownVars) {
  const allowed = lambdaAllowedNames(scopeStack, lambdaStack);
  if (!allowed) return knownVars;
  const m = new Map();
  for (let [n, info] of knownVars) if (allowed.has(n)) m.set(n, info);
  return m;
}

// Detect a lambda definition whose body block opens on this line, e.g.
//   `auto l = [](int v) {`        (no capture, params)
//   `auto l = [x, &y](int v) {`   (explicit capture, params)
//   `auto l = [&]() {`            (default capture, no params)
// Returns { captures: <Set|null>, params: <array of names> } or null.
// `captures === null` means a default capture ([&]/[=]) → everything accessible.
function detectLambdaBody(stripped) {
  if (!stripped || stripped.indexOf('[') === -1) return null;
  // The capture list is a [ ... ] region. The last ']' in the line that is
  // followed (ignoring whitespace) by '(' and is followed on this line by '{'
  // is the lambda's capture list. (Lambdas have a parenthesized parameter
  // list, which distinguishes them from array-init / control flow.)
  let i = stripped.length - 1;
  let captureStr = null, cpOpen = -1;
  while (i >= 0) {
    if (stripped[i] === ']') {
      const rest = stripped.slice(i + 1);
      if (/^\s*\(/.test(rest) && rest.indexOf('{') !== -1) {
        // find matching '[' for this ']'
        let d = 0, k = i;
        for (; k >= 0; k--) {
          if (stripped[k] === ']') d++;
          else if (stripped[k] === '[') { d--; if (d === 0) break; }
        }
        if (k >= 0) { captureStr = stripped.slice(k + 1, i); cpOpen = k; break; }
      }
    }
    i--;
  }
  if (captureStr === null) return null;
  // Sanity: the capture list is either empty, a default ([&]/[=]...), or an
  // identifier-ish list. Anything containing ';' / '=' (except init-capture) or
  // control keywords is not a lambda capture.
  const cap = captureStr.trim();
  if (/;/.test(cap) || /\b(if|for|while|switch|return)\b/.test(cap)) return null;
  const captures = lambdaCaptureSet(cap);
  // Parameters: text between the first '(' after cpOpen and its matching ')'.
  let paramNames = [];
  const parenOpen = stripped.indexOf('(', cpOpen + 1);
  if (parenOpen !== -1) {
    let d = 0; let end = -1;
    for (let p = parenOpen; p < stripped.length; p++) {
      if (stripped[p] === '(') d++;
      else if (stripped[p] === ')') { d--; if (d === 0) { end = p; break; } }
    }
    if (end !== -1) {
      const paramsText = stripped.slice(parenOpen + 1, end);
      let dd = 0; const parts = []; let cur = '';
      for (const ch of paramsText) {
        if (ch === '<' || ch === '(' || ch === '[') dd++;
        else if (ch === '>' || ch === ')' || ch === ']') dd--;
        if (ch === ',' && dd === 0) { parts.push(cur); cur = ''; }
        else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      for (let part of parts) {
        let decls = parseDeclaration(part.trim());
        for (let d of decls) paramNames.push(d.name);
      }
    }
  }
  return { captures, params: paramNames };
}

// Build the __opt_field_*__ encoder call list for a struct's fields.
// baseExpr is the expression used to reach each field: `name` for stack
// objects (e.g. `p.a`) or `(*name)` for heap objects behind a pointer
// (e.g. `(*p).a`). Returns [] when no field has a supported encoder.
function buildFieldEncoders(baseExpr, fields) {
  const encoders = [];
  for (const f of fields) {
    if (f.isArray) continue;
    let fieldFn = null;
    const ft = f.type;
    if (f.isPointer) {
      // Pointer fields — const char* overload for char pointers, generic for others
      fieldFn = (ft === 'char' || ft === 'const char') ? '__opt_field_const_char_ptr__' : '__opt_field_ptr__';
    } else if (ft === 'int' || ft === 'short' || ft === 'size_t') {
      fieldFn = '__opt_field_int__';
    } else if (ft === 'unsigned' || ft === 'unsigned int' || ft === 'unsigned short') {
      fieldFn = '__opt_field_unsigned__';
    } else if (ft === 'long' || ft === 'long long') {
      fieldFn = '__opt_field_long__';
    } else if (ft === 'unsigned long' || ft === 'unsigned long long') {
      fieldFn = '__opt_field_ulong__';
    } else if (ft === 'double') {
      fieldFn = '__opt_field_double__';
    } else if (ft === 'float') {
      fieldFn = '__opt_field_float__';
    } else if (ft === 'bool') {
      fieldFn = '__opt_field_bool__';
    } else if (ft === 'char' || ft === 'unsigned char') {
      fieldFn = '__opt_field_char__';
    } else if (ft === 'std::string' || ft === 'string') {
      fieldFn = '__opt_field_string__';
    }
    if (fieldFn) {
      encoders.push(`${fieldFn}("${f.name}", ${baseExpr}.${f.name})`);
    }
  }
  return encoders;
}

// Classify a container type (from parseDeclaration, which strips the
// `vector<...>` wrapper) so genCaptures can emit a safe capture. Returns
// 'vector_ptr' | 'vector_int' | 'vector_other' | 'opaque' | null (not a container).
// isPointer reflects whether the element type ended in `*` (parseDeclaration
// absorbs a pointer-element's `*` into isPointer).
function containerKind(type, isPointer) {
  if (!type) return null;
  const vm = type.match(/^(std::)?(vector|list|deque|array)\s*<(.+)>$/);
  if (vm) {
    const el = vm[3].trim();
    if (isPointer) return 'vector_ptr';
    if (/^(unsigned\s+)?(int|short|size_t|long|long\s+long|unsigned\s+long|unsigned\s+short)$/.test(el)) return 'vector_int';
    return 'vector_other';
  }
  if (/^(std::)?(map|set|multimap|multiset|unordered_map|unordered_set|queue|stack|priority_queue)\s*</.test(type)) return 'opaque';
  return null;
}

// Generate capture calls for all known variables
function genCaptures(knownVars, heapPointers, deletedPointers, structDefs, excludeVars) {
  let captures = [];
  for (let [name, info] of knownVars) {
    if (excludeVars && excludeVars.has(name)) continue;
    if (deletedPointers.has(name)) {
      // Deleted pointer: show actual dangling address (NOT 0x0).
      // delete/delete[] does NOT null the pointer — it still holds the old
      // heap address (dangling pointer). We just don't create a heap entry.
      captures.push(`__opt_cap__("${name}", ${name});`);
    } else if (heapPointers.has(name)) {
      // Heap pointer — use heap capture that creates both stack pointer and heap entry
      let sz = heapPointers.get(name);
      if (info && info.type && info.isPointer && structDefs.has(info.type)) {
        // Heap object of a known class/struct (new Person()):
        // __opt_cap_heap__ only has int* overloads, so a class pointer would
        // fail with "no matching function". Render the allocated object as a
        // C_STRUCT (with its fields when available) via __opt_cap_heap_obj__,
        // which takes const void* by value and therefore works for any type.
        const encoders = buildFieldEncoders(`(*${name})`, structDefs.get(info.type));
        const fieldStr = encoders.join(' + "," + ');
        // Mirror __opt_cap_struct__: the __opt_field_*__ calls return std::string,
        // concatenated then converted with .c_str() — do NOT embed the C++ field
        // expressions inside a string literal (that leaves nested unescaped quotes).
        const fieldArg = fieldStr ? `(${fieldStr}).c_str()` : '""';
        captures.push(`__opt_cap_heap_obj__("${name}", "${info.type}", (const void*)${name}, (const void*)&${name}, ${fieldArg});`);
      } else if (sz > 0) {
        // Heap array: new int[size]
        captures.push(`__opt_cap_heap_arr__("${name}", ${name}, ${sz});`);
      } else {
        // Single heap value: new int(42)
        captures.push(`__opt_cap_heap__("${name}", ${name});`);
      }
    } else if (info && info.isArray && info.arrayDims && info.arrayDims.length >= 1) {
      // Array — use __opt_cap_array__ with element count
      let totalSize = info.arrayDims.reduce((a, b) => a * b, 1);
      if (totalSize === 0) {
        // Unsized array (e.g., char str[] = "hello") — treat char[] as string
        if (info.type === 'char') {
          captures.push(`__opt_cap__("${name}", std::string(${name}));`);
        } else {
          captures.push(`__opt_cap__("${name}", ${name});`);
        }
      } else if (info.type === 'char') {
        captures.push(`__opt_cap_array__("${name}", ${name}, ${totalSize});`);
      } else {
        // For int arrays and other types, cast to int* and use int array cap
        captures.push(`__opt_cap_array__("${name}", (int*)${name}, ${totalSize});`);
      }
    } else if (info && info.type && !info.isPointer && structDefs.has(info.type)) {
      // Struct/class variable: capture as C_STRUCT object with fields
      // Uses non-template __opt_cap_struct__ + __opt_field_*__ overloads
      // to avoid WASM traps from templates/typeid/__cxa_demangle.
      const fieldEncoders = buildFieldEncoders(name, structDefs.get(info.type));
      if (fieldEncoders.length > 0) {
        // Build field JSON by concatenating encoded fields with commas
        const fieldStr = fieldEncoders.join(' + "," + ');
        captures.push(`__opt_cap_struct__("${name}", "${info.type}", (void*)&${name}, (${fieldStr}).c_str());`);
      } else {
        captures.push(`__opt_cap_struct__("${name}", "${info.type}", (void*)&${name}, "");`);
      }
    } else if (info && info.type && containerKind(info.type, !!info.isPointer)) {
      // std::vector<T> / other containers. parseDeclaration strips the
      // `vector<...>` wrapper (type becomes `vector<int>`), and for pointer
      // elements the trailing `*` is absorbed into isPointer. Previously
      // pointer-element containers fell through to `__opt_cap__(name, name)`
      // which no overload accepts → "no matching function" (the WHOLE program
      // failed to compile). We emit a plain .data()/.size() call (NOT the
      // vector by reference, which would need a WASM-fragile template) so the
      // elements render as a C_ARRAY; pointer elements draw arrows via the
      // existing C_DATA-pointer rendering (no frontend change).
      const ck = containerKind(info.type, !!info.isPointer);
      if (ck === 'vector_ptr') {
        captures.push(`__opt_cap_vector_ptr__("${name}", (const void**)${name}.data(), (int)${name}.size());`);
      } else if (ck === 'vector_int') {
        captures.push(`__opt_cap_vector_int__("${name}", (const int*)${name}.data(), (int)${name}.size());`);
      } else {
        const tname = info.type.replace(/^std::/, '');
        captures.push(`__opt_cap_unknown__("${name}", "${tname}", (void*)&${name});`);
      }
    } else if (name === 'this') {
      // 'this' pointer — handled by __opt_trace_fn_this__, skip here
    } else if (info && info.type === 'auto') {
      // auto type — try to infer actual type from initializer expression.
      // Pattern: auto [&]var = ClassName::method() or ClassName constructor
      let inferredType = null;
      if (info.init) {
        // Check for ClassName::method() pattern
        let m = info.init.match(/(\w+)::\w+\(/);
        if (m && structDefs.has(m[1])) {
          inferredType = m[1];
        }
        // Check for ClassName constructor call: ClassName(...)
        if (!inferredType) {
          m = info.init.match(/^=(\w+)\(/);
          if (m && structDefs.has(m[1])) {
            inferredType = m[1];
          }
        }
      }
      if (inferredType && structDefs.has(inferredType)) {
        // Use struct capture with inferred type
        const fields = structDefs.get(inferredType);
        const fieldEncoders = [];
        for (const f of fields) {
          if (f.isArray) continue;
          let fieldFn = null;
          const ft = f.type;
          if (f.isPointer) {
            if (ft === 'char' || ft === 'const char') {
              fieldFn = '__opt_field_const_char_ptr__';
            } else {
              fieldFn = '__opt_field_ptr__';
            }
          } else if (ft === 'int' || ft === 'short' || ft === 'size_t') {
            fieldFn = '__opt_field_int__';
          } else if (ft === 'unsigned' || ft === 'unsigned int' || ft === 'unsigned short') {
            fieldFn = '__opt_field_unsigned__';
          } else if (ft === 'long' || ft === 'long long') {
            fieldFn = '__opt_field_long__';
          } else if (ft === 'unsigned long' || ft === 'unsigned long long') {
            fieldFn = '__opt_field_ulong__';
          } else if (ft === 'double') {
            fieldFn = '__opt_field_double__';
          } else if (ft === 'float') {
            fieldFn = '__opt_field_float__';
          } else if (ft === 'bool') {
            fieldFn = '__opt_field_bool__';
          } else if (ft === 'char' || ft === 'unsigned char') {
            fieldFn = '__opt_field_char__';
          } else if (ft === 'std::string' || ft === 'string') {
            fieldFn = '__opt_field_string__';
          }
          if (fieldFn) {
            fieldEncoders.push(`${fieldFn}("${f.name}", ${name}.${f.name})`);
          }
        }
        if (fieldEncoders.length > 0) {
          const fieldStr = fieldEncoders.join(' + "," + ');
          captures.push(`__opt_cap_struct__("${name}", "${inferredType}", (void*)&${name}, (${fieldStr}).c_str());`);
        } else {
          captures.push(`__opt_cap_struct__("${name}", "${inferredType}", (void*)&${name}, "");`);
        }
      } else if (info.isReference) {
        // Unknown reference type — use __opt_cap_unknown__
        captures.push(`__opt_cap_unknown__("${name}", "auto", (void*)&${name});`);
      } else {
        // Non-reference auto — try to infer simple type from initializer
        // to pick the right __opt_cap__ overload. Fall back to __opt_cap_unknown__
        // for complex types (std::function, lambdas, etc.) that have no overload.
        let inferredSimpleType = null;
        if (info.init) {
          const initStr = info.init.trim();
          // Integer literals with suffixes
          if (/^=-?\d+[uU]?[lL]?[lL]?$/.test(initStr)) {
            if (/[uU]/.test(initStr) && /[lL]/.test(initStr)) inferredSimpleType = 'unsigned long';
            else if (/[lL]{2}/.test(initStr)) inferredSimpleType = 'long long';
            else if (/[uU]/.test(initStr)) inferredSimpleType = 'unsigned';
            else if (/[lL]/.test(initStr)) inferredSimpleType = 'long';
            else inferredSimpleType = 'int';
          }
          // Floating point literals
          else if (/^=-?\d+\.\d*[fF]?$/.test(initStr) || /^=-?\d+[eE][+-]?\d+$/.test(initStr)) {
            if (/[fF]$/.test(initStr)) inferredSimpleType = 'float';
            else inferredSimpleType = 'double';
          }
          // Boolean literals
          else if (/^=(true|false)$/.test(initStr)) {
            inferredSimpleType = 'bool';
          }
          // Character literals
          else if (/^='.'$/.test(initStr) || /^='\\.'$/.test(initStr)) {
            inferredSimpleType = 'char';
          }
          // String literals → const char*
          else if (/^=".*"$/.test(initStr)) {
            inferredSimpleType = 'const char*';
          }
        }
        if (inferredSimpleType) {
          // We know the simple type — cast and use the right overload
          if (inferredSimpleType === 'const char*') {
            captures.push(`__opt_cap__("${name}", ${name});`);
          } else {
            captures.push(`__opt_cap__("${name}", (static_cast<${inferredSimpleType}>(${name})));`);
          }
        } else {
          // Can't determine type (std::function, lambda, etc.) — use fallback
          captures.push(`__opt_cap_unknown__("${name}", "auto", (void*)&${name});`);
        }
      }
    } else if (info && info.type && !info.isPointer && !info.isArray && !structDefs.has(info.type) &&
               info.type !== 'int' && info.type !== 'double' && info.type !== 'float' &&
               info.type !== 'char' && info.type !== 'bool' && info.type !== 'short' &&
               info.type !== 'long' && info.type !== 'unsigned' && info.type !== 'string' &&
               info.type !== 'std::string' && !info.type.endsWith('*') &&
               info.type !== 'size_t') {
      // Unknown class/struct type — skip (can't capture without templates)
    } else {
      // All other types: use overloaded __opt_cap__
      captures.push(`__opt_cap__("${name}", ${name});`);
    }
  }
  return captures;
}

function instrumentCode(sourceCode) {
  const lines = sourceCode.split('\n');

  // Track all declared variables (type info)
  // Map from variable name → type info
  let knownVars = new Map();

  // Track global (file-scope) variables
  let globalVars = [];
  // Track static local variables (visible only in their declaring function,
  // but moved to globals section by runner.ts for visualization)
  let staticVars = new Set();

  // Track heap-allocated pointers: name → arraySize (0 = single value, >0 = array)
  let heapPointers = new Map();
  // Track deleted pointers (after delete/delete[], no heap entry should be created)
  let deletedPointers = new Set();

  // Track current scope (brace depth → list of vars declared at that depth)
  let scopeStack = [{ depth: 0, vars: new Set() }];

  // Output lines
  let output = [];

  // Track if we're inside a function body (to skip instrumentation at file scope)
  let inFunctionBody = false;
  let mainFrameEnsured = false;

  // Track if we're inside a member function (inside a struct/class body)
  let inMemberFunction = false;
  let memberFunctionStructName = '';
  let memberFunctionIsStatic = false;
  let memberFunctionScopeDepth = 0;  // scopeStack.length at entry

  // Track if we're inside a struct/class body (to skip variable declarations)
  let inStructBody = false;
  let structBraceDepth = 0;

  // Track local class/struct bodies inside function bodies
  let inLocalClassBody = false;
  let localClassBraceDepth = 0;
  let localClassName = '';
  let localClassFields = [];
  let localClassAccessLevel = 'public';

  // Track brace-less control flow (for/while/if without {) — next line is the body
  let pendingBracelessBody = false;
  // Track multi-line statement continuation (expression spanning multiple lines
  // without a top-level semicolon, e.g. `std::cout << 1 \n << 2;`)
  let inMultiLineStmt = false;
  // Defer block-opening declarations (e.g. `auto lambda = [...] { ... }`): a
  // variable whose initializer opens a multi-line block must NOT be added to
  // knownVars until that block closes. Adding it immediately would (a) make the
  // next in-block trace emit `(void*)&name` INSIDE name's own `auto` initializer
  // — illegal C++ ("use of 'x' before deduction of 'auto'") — and (b) scope it to
  // the inner block so it vanishes from the outer scope after the `};`. A stack
  // of {depth, decls} so nested lambdas each flush at their own closing brace.
  let pendingBlocks = [];   // entries: { depth: scopeStack.length when opened, decls: [{name,...}] }
  // Stack of lambda bodies currently open: { captures: Set|null, params: [names], scopeDepth }
  // Used to restrict which variables a trace inside a lambda body may capture
  // (only the lambda's captures + params + its own locals; null captures = [&]/[=] → all).
  let lambdaStack = [];
  let currentStructName = '';
  let currentStructFields = [];
  let currentAccessLevel = 'public'; // default for struct

  // Map: struct name → array of {name, type}
  let structDefs = new Map();

  // Track all function definitions: name → {startLine, endLine, params}
  let functionDefs = [];

  // Current function name (for frame management) and a stack for nesting
  let currentFunc = 'main';
  let funcNameStack = ['main'];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let lineNum = i + 1;

    // Strip comments for analysis but keep original for output
    let stripped = stripCommentsAndStrings(line).trim();

    // Flush deferred block-opening declarations whose initializer block has now
    // closed. After a `};` popped its block scope, the owning scope is the
    // current top; any pending decl owned by that scope is now fully initialized
    // (its `auto` type deduced), so register it in knownVars + the owner scope.
    // This makes it visible in the next statement's trace — at a point where
    // `(void*)&name` is legal (we're past the initializer, back in the owner scope).
    if (pendingBlocks.length > 0) {
      const top = scopeStack[scopeStack.length - 1];
      pendingBlocks = pendingBlocks.filter((pb) => {
        if (pb.ownerScope === top) {
          for (let d of pb.decls) {
            knownVars.set(d.name, d);
            top.vars.add(d.name);
            if (d.isStatic) staticVars.add(d.name);
          }
          return false; // consumed
        }
        return true;
      });
    }

    // Skip empty lines and preprocessor directives
    if (stripped === '' || stripped.startsWith('#')) {
      output.push(line);
      continue;
    }

    // Add #line directive to map instrumented code back to user's source
    // NOTE: #line directives cause "Decl inserted into wrong lexical context"
    // assertion in clang-repl, so we DON'T use them inside function bodies.
    // Instead, error line mapping is handled by identifier search in runner.ts.

    // First non-preprocessor line — ensure main frame is pushed
    if (!inFunctionBody && !inStructBody && !mainFrameEnsured) {
      // Push ensure_frame as a separate statement
      output.push('__opt_ensure_frame__("main", 0);');
      mainFrameEnsured = true;
    }

    // Detect local class/struct definition inside a function body
    if (inFunctionBody && !inLocalClassBody) {
      let localClassMatch = stripped.match(/^(struct|class)\s+(\w+)\s*(?:final\s*)?(?::\s*[^{]*)?\{/);
      if (localClassMatch) {
        inLocalClassBody = true;
        localClassBraceDepth = 0;
        localClassName = localClassMatch[2];
        localClassFields = [];
        localClassAccessLevel = (localClassMatch[1] === 'class') ? 'private' : 'public';
        for (let c of stripped) {
          if (c === '{') localClassBraceDepth++;
          if (c === '}') localClassBraceDepth--;
        }
        output.push(line);
        if (localClassBraceDepth <= 0) {
          inLocalClassBody = false;
        }
        continue;
      }
    }

    // If inside a local class/struct body, handle field declarations AND
    // member function instrumentation (mirrors the global struct handler).
    // Skip when inside a member function — those lines are handled by the
    // general function-body instrumentation path below.
    if (inFunctionBody && inLocalClassBody && !inMemberFunction) {
      // Track braces to detect the end of the local class body
      for (let c of stripped) {
        if (c === '{') localClassBraceDepth++;
        if (c === '}') localClassBraceDepth--;
      }
      // Register the local class when its body ends
      if (localClassBraceDepth <= 0) {
        // Always register local classes, even with no public fields.
        // This ensures they show as "object ClassName" instead of <unknown>.
        if (localClassName) {
          structDefs.set(localClassName, localClassFields);
        }
        inLocalClassBody = false;
        output.push(line);
        continue;
      }
      // Skip access specifiers but track the current access level
      let accessMatch = stripped.match(/^(public|private|protected)\s*:/);
      if (accessMatch) {
        localClassAccessLevel = accessMatch[1];
        output.push(line);
        continue;
      }

      // Detect member function definition (same regex as global struct handler)
      let memberFuncMatch = stripped.match(/^(?:(?:virtual|static|inline|explicit|friend|const)\s+)*(?:[\w:~]+[&\s]+)*&?\s*(~?\w+|operator\s*[()]=≠%&|^~]*|operator\s*\+\+|operator\s*--|operator\s*\(\))\s*\(([^)]*)\)\s*(?:(?:const|override|noexcept|final|volatile|&|&&)\s*)*(?::\s*[^{]*)?\{/);
      if (!memberFuncMatch) {
        let opCallMatch = stripped.match(/^(?:(?:virtual|static|inline|explicit|friend|const)\s+)*(?:[\w:~]+[&\s]+)*&?\s*(operator\s*\(\))\s*\(([^)]*)\)\s*(?:(?:const|override|noexcept|final|volatile|&|&&)\s*)*(?::\s*[^{]*)?\{/);
        if (opCallMatch) memberFuncMatch = opCallMatch;
      }
      if (!memberFuncMatch) {
        let opCallMatch2 = stripped.match(/^(?:(?:virtual|static|inline|explicit|friend|const)\s+)*(?:[\w:~]+[&\s]+)*&?\s*(operator\s*\(\))\s*\(((?:[^()]|\([^)]*\))*)\)\s*(?:(?:const|override|noexcept|final|volatile|&|&&)\s*)*(?::\s*[^{]*)?\{/);
        if (opCallMatch2) memberFuncMatch = opCallMatch2;
      }
      if (memberFuncMatch) {
        let rawName = memberFuncMatch[1].trim();
        let funcName = rawName.split(/\s+/).pop();
        let qualifiedName = `${localClassName}::${funcName}`;
        let isStaticMember = stripped.includes('static');
        let params = memberFuncMatch[2].trim();
        // Empty body inline "{}" or "{};"
        if (stripped.match(/\{\s*\}\s*;?$/)) {
          let beforeBrace = line.substring(0, line.indexOf('{') + 1);
          let afterBrace = line.substring(line.indexOf('{') + 1);
          output.push(beforeBrace);
          if (isStaticMember) {
            output.push(`__opt_trace_fn__("${qualifiedName}", ${lineNum});`);
          } else {
            output.push(`__opt_trace_fn_this__("${qualifiedName}", ${lineNum}, "${localClassName}", (void*)this);`);
          }
          output.push(`__opt_trace_end__();`);
          output.push(afterBrace);
          continue;
        }
        // Single-line function body — split into multi-line for instrumentation
        let bodyCloseIdx = stripped.lastIndexOf('}');
        if (bodyCloseIdx > stripped.indexOf('{')) {
          let braceIdx = line.indexOf('{');
          let closeIdx = line.lastIndexOf('}');
          let beforeBrace = line.substring(0, braceIdx + 1);
          let bodyContent = line.substring(braceIdx + 1, closeIdx).trim();
          let afterBrace = line.substring(closeIdx);
          output.push(beforeBrace);
          if (isStaticMember) {
            output.push(`__opt_trace_fn__("${qualifiedName}", ${lineNum});`);
          } else {
            output.push(`__opt_trace_fn_this__("${qualifiedName}", ${lineNum}, "${localClassName}", (void*)this);`);
          }
          output.push(`__opt_trace_end__();`);
          if (bodyContent) output.push(bodyContent + ';');
          output.push(afterBrace);
          continue;
        }
        // Multi-line function body — instrument it
        inMemberFunction = true;
        memberFunctionStructName = localClassName;
        memberFunctionIsStatic = isStaticMember;
        memberFunctionScopeDepth = scopeStack.length;
        functionDefs.push({name: qualifiedName, startLine: lineNum, params: params, isMember: true, structName: localClassName});
        currentFunc = qualifiedName;
        funcNameStack.push(qualifiedName);

        output.push(line);
        if (isStaticMember) {
          output.push(`__opt_trace_fn__("${qualifiedName}", ${lineNum});`);
        } else {
          output.push(`__opt_trace_fn_this__("${qualifiedName}", ${lineNum}, "${localClassName}", (void*)this);`);
        }
        output.push(`__opt_trace_end__();`);
        // Push new scope for member function
        scopeStack.push({ depth: scopeStack[scopeStack.length-1].depth + 1, vars: new Set() });

        // Parse function parameters
        if (params) {
          let paramParts = [];
          let depth = 0;
          let current = '';
          for (let j = 0; j < params.length; j++) {
            const c = params[j];
            if (c === '<' || c === '(' || c === '[') depth++;
            if (c === '>' || c === ')' || c === ']') depth--;
            if (c === ',' && depth === 0) { paramParts.push(current.trim()); current = ''; }
            else current += c;
          }
          if (current.trim()) paramParts.push(current.trim());
          for (let p of paramParts) {
            let declared = parseDeclaration(p);
            for (let d of declared) {
              knownVars.set(d.name, d);
              scopeStack[scopeStack.length-1].vars.add(d.name);
            }
          }
        }
        // Add 'this' for non-static member functions
        if (!stripped.includes('static')) {
          let thisInfo = {name: 'this', type: localClassName + '*', isArray: false, isPointer: true};
          knownVars.set('this', thisInfo);
          scopeStack[scopeStack.length-1].vars.add('this');
        }
        continue;
      }

      // Skip constructor initializer lists on their own line
      if (stripped.includes(':') && !stripped.match(/^\s*(public|private|protected)\s*:/) && !stripped.includes('{')) {
        output.push(line);
        continue;
      }
      // Parse field declarations — collect only public fields.
      // Private members can't be accessed from outside the class.
      let fieldDecl = parseDeclaration(stripped);
      for (let d of fieldDecl) {
        d.access = localClassAccessLevel;
        if (localClassAccessLevel === 'public') {
          localClassFields.push(d);
        }
      }
      output.push(line);
      continue;
    }

    // If inside struct/class body (but NOT inside a member function), handle field declarations
    if (inStructBody && !inFunctionBody) {
      // Track braces inside struct body
      for (let c of stripped) {
        if (c === '{') structBraceDepth++;
        if (c === '}') structBraceDepth--;
      }
      // Check if struct body ended
      if (structBraceDepth <= 0) {
        inStructBody = false;
        // Always register structs/classes, even with no public fields.
        // This ensures they show as "object ClassName" instead of <unknown>.
        if (currentStructName) {
          structDefs.set(currentStructName, currentStructFields);
        }
        output.push(line);
        continue;
      }
      // Skip access specifiers — but track the current access level
      let accessMatch = stripped.match(/^(public|private|protected)\s*:/);
      if (accessMatch) {
        currentAccessLevel = accessMatch[1];
        output.push(line);
        continue;
      }

      // Detect member function definition: has parentheses and opening brace
      // e.g., "Point(int x, int y) : x(x), y(y) {" or "int getX() {"
      // Also handle inline definitions: "void foo() { ... }"
      // Allow const, override, noexcept, final, volatile, & , && between ) and { or :
      // Handle optional leading keywords: virtual, static, inline, explicit, friend, const
      // Handle operator overloads: operator(), operator++, operator=, etc.
      // Handle ref-qualified return types: const static Printer &get_print()
      let memberFuncMatch = stripped.match(/^(?:(?:virtual|static|inline|explicit|friend|const)\s+)*(?:[\w:~]+[&\s]+)*&?\s*(~?\w+|operator\s*[()]=≠%&|^~]*|operator\s*\+\+|operator\s*--|operator\s*\(\))\s*\(([^)]*)\)\s*(?:(?:const|override|noexcept|final|volatile|&|&&)\s*)*(?::\s*[^{]*)?\{/);
      if (!memberFuncMatch) {
        // Try operator() specifically: "void operator()(...) {"
        let opCallMatch = stripped.match(/^(?:(?:virtual|static|inline|explicit|friend|const)\s+)*(?:[\w:~]+[&\s]+)*&?\s*(operator\s*\(\))\s*\(([^)]*)\)\s*(?:(?:const|override|noexcept|final|volatile|&|&&)\s*)*(?::\s*[^{]*)?\{/);
        if (opCallMatch) memberFuncMatch = opCallMatch;
      }
      if (!memberFuncMatch) {
        // Try operator() with nested parens in params
        let opCallMatch2 = stripped.match(/^(?:(?:virtual|static|inline|explicit|friend|const)\s+)*(?:[\w:~]+[&\s]+)*&?\s*(operator\s*\(\))\s*\(((?:[^()]|\([^)]*\))*)\)\s*(?:(?:const|override|noexcept|final|volatile|&|&&)\s*)*(?::\s*[^{]*)?\{/);
        if (opCallMatch2) memberFuncMatch = opCallMatch2;
      }
      if (memberFuncMatch) {
        // Extract function name — could be "Point", "~Point", "getX", "operator=", etc.
        let rawName = memberFuncMatch[1].trim();
        let funcName = rawName.split(/\s+/).pop(); // take last word (handles "int getX")
        // Qualify with struct name: Point::getX, Point::Point, etc.
        let qualifiedName = `${currentStructName}::${funcName}`;
        let isStaticMember = stripped.includes('static');
        let params = memberFuncMatch[2].trim();
        // Don't instrument if it's an empty body inline "{}" or "{};"
        if (stripped.match(/\{\s*\}\s*;?$/)) {
          // Empty body — inject trace inside the body by splitting the line
          let braceIdx = stripped.indexOf('{');
          let beforeBrace = line.substring(0, line.indexOf('{') + 1);
          let afterBrace = line.substring(line.indexOf('{') + 1);
          output.push(beforeBrace);
          if (isStaticMember) {
            output.push(`__opt_trace_fn__("${qualifiedName}", ${lineNum});`);
          } else {
            output.push(`__opt_trace_fn_this__("${qualifiedName}", ${lineNum}, "${currentStructName}", (void*)this);`);
          }
          output.push(`__opt_trace_end__();`);
          output.push(afterBrace);
          continue;
        }
        // Check if the function body is entirely on one line
        let bodyCloseIdx = stripped.lastIndexOf('}');
        if (bodyCloseIdx > stripped.indexOf('{')) {
          // Single-line function body — instrument by splitting
          let beforeBrace = line.substring(0, line.indexOf('{') + 1);
          let afterBrace = line.substring(line.indexOf('{') + 1);
          output.push(beforeBrace);
          if (isStaticMember) {
            output.push(`__opt_trace_fn__("${qualifiedName}", ${lineNum});`);
          } else {
            output.push(`__opt_trace_fn_this__("${qualifiedName}", ${lineNum}, "${currentStructName}", (void*)this);`);
          }
          output.push(`__opt_trace_end__();`);
          output.push(afterBrace);
          continue;
        }
        // Multi-line function body — instrument it
        inFunctionBody = true;
        inMemberFunction = true;
        memberFunctionStructName = currentStructName;
        memberFunctionIsStatic = isStaticMember;
        memberFunctionScopeDepth = scopeStack.length;
        functionDefs.push({name: qualifiedName, startLine: lineNum, params: params, isMember: true, structName: currentStructName});
        currentFunc = qualifiedName;
        funcNameStack.push(qualifiedName);

        // Output the function signature line
        output.push(line);
        // Inject a trace call at function entry
        if (isStaticMember) {
          output.push(`__opt_trace_fn__("${qualifiedName}", ${lineNum});`);
        } else {
          output.push(`__opt_trace_fn_this__("${qualifiedName}", ${lineNum}, "${currentStructName}", (void*)this);`);
        }
        output.push(`__opt_trace_end__();`);
        // Push new scope
        scopeStack.push({ depth: scopeStack[scopeStack.length-1].depth + 1, vars: new Set() });

        // Parse function parameters and add to knownVars
        if (params) {
          let paramParts = [];
          let depth = 0;
          let current = '';
          for (let j = 0; j < params.length; j++) {
            const c = params[j];
            if (c === '<' || c === '(' || c === '[') depth++;
            if (c === '>' || c === ')' || c === ']') depth--;
            if (c === ',' && depth === 0) { paramParts.push(current.trim()); current = ''; }
            else current += c;
          }
          if (current.trim()) paramParts.push(current.trim());
          
          for (let p of paramParts) {
            let declared = parseDeclaration(p);
            for (let d of declared) {
              knownVars.set(d.name, d);
              scopeStack[scopeStack.length-1].vars.add(d.name);
            }
          }
        }
        // Add 'this' as a known variable for member functions (except static)
        // 'this' is a pointer — encode it as a regular C_DATA pointer
        if (!stripped.includes('static')) {
          let thisInfo = {name: 'this', type: currentStructName + '*', isArray: false, isPointer: true};
          knownVars.set('this', thisInfo);
          scopeStack[scopeStack.length-1].vars.add('this');
        }
        continue;
      }

      // Skip constructor initializer lists on their own line (lines with `:` that aren't access specifiers)
      if (stripped.includes(':') && !stripped.match(/^\s*(public|private|protected)\s*:/) && !stripped.includes('{')) {
        output.push(line);
        continue;
      }
      // Parse field declarations — collect only public fields for visualization.
      // Private members can't be accessed from outside the class (offsetof also
      // enforces access control in Clang), so we skip them. Classes with only
      // private fields will show as "object ClassName" with no field values.
      let fieldDecl = parseDeclaration(stripped);
      for (let d of fieldDecl) {
        d.access = currentAccessLevel;
        if (currentAccessLevel === 'public') {
          currentStructFields.push(d);
        }
      }
      output.push(line);
      continue;
    }

    // Check for opening brace — entering a new scope
    // This check must come BEFORE the global variable check, because
    // function definitions like "int add(int a, int b) {" also match
    // parseDeclaration's skip pattern but need to be handled as functions
    if (stripped.includes('{')) {
      // Check if this is a function body opening
      // e.g., "int main() {" or "void foo(int x) {"
      let funcMatch = stripped.match(/(\w[\w:]*)\s+(\w+)\s*\(([^)]*)\)\s*\{/);
      if (funcMatch && !['if','for','while','switch','else','do','catch','try'].includes(funcMatch[2])) {
        let funcName = funcMatch[2];
        let params = funcMatch[3].trim();
        inFunctionBody = true;
        functionDefs.push({name: funcName, startLine: lineNum, params: params});
        currentFunc = funcName;
        funcNameStack.push(funcName);

        // Output the function signature line
        output.push(line);
        // Inject a trace call at function entry (the opening brace line)
        let entryFnArg = `"${funcName}", `;
        output.push(`__opt_trace_fn__(${entryFnArg}${lineNum});`);
        output.push(`__opt_trace_end__();`);
        // Push new scope
        scopeStack.push({ depth: scopeStack[scopeStack.length-1].depth + 1, vars: new Set() });

        // Parse function parameters and add to knownVars
        if (params) {
          let paramParts = [];
          let depth = 0;
          let current = '';
          for (let j = 0; j < params.length; j++) {
            const c = params[j];
            if (c === '<' || c === '(' || c === '[') depth++;
            if (c === '>' || c === ')' || c === ']') depth--;
            if (c === ',' && depth === 0) { paramParts.push(current.trim()); current = ''; }
            else current += c;
          }
          if (current.trim()) paramParts.push(current.trim());
          
          for (let p of paramParts) {
            let declared = parseDeclaration(p);
            for (let d of declared) {
              knownVars.set(d.name, d);
              scopeStack[scopeStack.length-1].vars.add(d.name);
            }
          }
        }
        // For main, add global variables to knownVars so they appear in the frame
        if (funcName === 'main') {
          for (let g of globalVars) {
            knownVars.set(g.name, g);
            scopeStack[scopeStack.length-1].vars.add(g.name);
          }
        }
        continue;
      }
      // Push new scope (but not for struct/class bodies — they're handled separately)
      if (!stripped.match(/^(struct|class)\s+\w+\s*(?:final\s*)?(?::\s*[^{]*)?\{/)) {
        scopeStack.push({ depth: scopeStack[scopeStack.length-1].depth + 1, vars: new Set() });
        // If this block is a LAMBDA body, remember its capture list + parameters
        // so traces inside the body only capture variables the lambda can access.
        // (A trace injected inside `l = [](int v) {` must NOT reference outer
        //  vars that `l` doesn't capture — that is illegal C++.)
        const lambdaInfo = inFunctionBody ? detectLambdaBody(stripped) : null;
        if (lambdaInfo) {
          lambdaStack.push({
            captures: lambdaInfo.captures, // null = default capture ([&]/[=])
            params: lambdaInfo.params,
            scopeDepth: scopeStack.length - 1,
          });
          // Note: lambda parameters are NOT added to knownVars (matches baseline
          // behavior and avoids shadowing bugs where a param shadows an outer var
          // — deleting it on scope-pop would lose the outer variable). They are
          // only kept in the `allowed` set below so they could be captured if
          // present; outer locals the lambda does NOT capture are excluded.
        }
      }
    }

    // At file scope (not in function body), track struct/class bodies and global variable declarations
    if (!inFunctionBody) {
      // Detect struct/class body entry: "struct Name {" or "class Name {"
      let structMatch = stripped.match(/^(struct|class)\s+(\w+)\s*(?:final\s*)?(?::\s*[^{}]*)?\{/);
      if (structMatch) {
        currentStructName = structMatch[2];
        currentStructFields = [];
        currentAccessLevel = (structMatch[1] === 'class') ? 'private' : 'public';
        // Count net braces on THIS line instead of hard-coding depth 1. This
        // handles same-line bodies (`class Person {}` empty, or `class A { int
        // a; }` non-empty) which previously never closed: the `continue` below
        // skipped the rest of the line, so structBraceDepth stayed 1 forever and
        // every later line (including `int main`) was misparsed as being inside
        // the class — turning `main` into `Person::main` with a bogus `this`.
        let opens = 0, closes = 0;
        for (const c of stripped) { if (c === '{') opens++; else if (c === '}') closes++; }
        const netDepth = opens - closes;
        if (netDepth > 0) {
          // Body continues on following lines — normal multi-line tracking.
          inStructBody = true;
          structBraceDepth = netDepth;
          output.push(line);
          continue;
        }
        // Body closes on this line. Parse any fields between the class braces,
        // register the class, and stay at file scope.
        const bodyOpen = stripped.indexOf('{');
        if (bodyOpen >= 0) {
          let d = 0, bodyClose = -1;
          for (let k = bodyOpen; k < stripped.length; k++) {
            if (stripped[k] === '{') d++;
            else if (stripped[k] === '}') { d--; if (d === 0) { bodyClose = k; break; } }
          }
          const interior = (bodyClose > bodyOpen) ? stripped.slice(bodyOpen + 1, bodyClose) : '';
          // Split on ';' so a multi-field one-liner is parsed field-by-field.
          // parseDeclaration skips function defs / operators / access specs.
          for (const chunk of interior.split(';')) {
            for (const f of parseDeclaration(chunk)) {
              f.access = currentAccessLevel;
              if (currentAccessLevel === 'public') currentStructFields.push(f);
            }
          }
        }
        structDefs.set(currentStructName, currentStructFields);
        output.push(line);
        continue;
      }
      // inStructBody case is handled above (before function detection)
      // Skip global variable declarations if inside struct body (shouldn't reach here)
      let declared = parseDeclaration(stripped);
      if (declared.length > 0) {
        for (let d of declared) {
          globalVars.push(d);
        }
      }
      // Output the original line as-is (no trace call at file scope)
      output.push(line);
      continue;
    }

    // Check for closing brace — leaving a scope
    if (stripped.includes('}')) {
      // Pop scope and remove its variables
      if (scopeStack.length > 1) {
        let popped = scopeStack.pop();
        for (let v of popped.vars) {
          knownVars.delete(v);
          heapPointers.delete(v);
          deletedPointers.delete(v);
        }
        // If the scope just popped was a lambda body, pop the matching lambda
        // context so subsequent traces are no longer lambda-restricted.
        if (lambdaStack.length > 0 && lambdaStack[lambdaStack.length-1].scopeDepth === scopeStack.length) {
          lambdaStack.pop();
        }
      }
      // Check if we're leaving a member function — return to struct/local-class body mode
      if (inMemberFunction && scopeStack.length <= memberFunctionScopeDepth) {
        inMemberFunction = false;
        funcNameStack.pop();
        currentFunc = funcNameStack[funcNameStack.length - 1];
        if (inLocalClassBody) {
          // The member function's '{' was counted by the local class body
          // handler. Now count the '}' to keep localClassBraceDepth balanced.
          for (let c of stripped) {
            if (c === '}') localClassBraceDepth--;
          }
          output.push(line);
          continue;
        }
        // Returning to global struct body
        inFunctionBody = false;
        inStructBody = true;
        // Count closing braces to update structBraceDepth.
        // The member function's '{' was counted by the inStructBody block
        // before we switched to inFunctionBody mode. Now we need to count
        // the '}' to keep the depth balanced.
        for (let c of stripped) {
          if (c === '}') structBraceDepth--;
        }
        if (structBraceDepth <= 0) {
          inStructBody = false;
          if (currentStructName && currentStructFields.length > 0) {
            structDefs.set(currentStructName, currentStructFields);
          }
        }
        output.push(line);
        continue;
      }
      // Check if we're leaving a function body
      if (inFunctionBody && scopeStack.length <= 1) {
        inFunctionBody = false;
        funcNameStack.pop();
        currentFunc = funcNameStack[funcNameStack.length - 1];
        // Note: __opt_pop_frame__() is NOT emitted here because in clang-repl,
        // code after 'return' inside a function is unreachable and causes
        // "UNSUPPORTED FEATURES" errors. Instead, frames are popped implicitly
        // by __opt_trace_impl__ which detects when the call stack depth changes.
        output.push(line);
        continue;
      }
    }

    // Only instrument inside function bodies
    if (!inFunctionBody) {
      output.push(line);
      continue;
    }

    // currentFunc is tracked via funcNameStack — no need to derive from line numbers

    // Check for for-loop header: extract variable declarations from inside for(...)
    // Handles both braced for-loops (for(...) {) and brace-less single-line
    // for-loops (for(...) <body>;) — the latter are wrapped in braces with a
    // trace call injected inside the loop body.
    let forMatch = stripped.match(/^\s*for\s*\(([^;]*);([^;]*);([^)]*)\)\s*\{\s*$/);
    if (!forMatch) {
      // Brace-less for-loop: for(...) <body>;
      // The body is everything after the closing ')' of the for-header.
      // If there are multiple statements on the same line separated by ';',
      // only the first is the loop body; the rest execute after the loop.
      let bracelessForMatch = stripped.match(/^\s*for\s*\(([^;]*);([^;]*);([^)]*)\)\s*(.+)$/);
      if (bracelessForMatch && !bracelessForMatch[4].trim().startsWith('{')) {
        // Transform: for(...) body; rest;
        // Into:      for(...) { __opt_trace_fn__(...); body; }
        //            rest;
        let initPart = bracelessForMatch[1].trim();
        let condPart = bracelessForMatch[2].trim();
        let incrPart = bracelessForMatch[3].trim();

        // Extract body and afterLoop from the ORIGINAL line (not stripped)
        // to preserve string/char literals. Find the ')' that closes the for-header
        // by tracking paren depth from 'for', then split the rest at first ';'.
        let bodyStartIdx = -1;
        let parenD = 0;
        let inStr = false, inChar = false;
        for (let j = line.indexOf('for'); j < line.length; j++) {
          const c = line[j];
          if (inStr) { if (c === '\\' && j+1 < line.length) j++; else if (c === '"') inStr = false; continue; }
          if (inChar) { if (c === '\\' && j+1 < line.length) j++; else if (c === "'") inChar = false; continue; }
          if (c === '"') { inStr = true; continue; }
          if (c === "'") { inChar = true; continue; }
          if (c === '(') parenD++;
          if (c === ')') { parenD--; if (parenD === 0) { bodyStartIdx = j + 1; break; } }
        }
        let restOriginal = bodyStartIdx >= 0 ? line.substring(bodyStartIdx).trim() : '';

        // Split restOriginal into loop-body (first statement) and post-loop statements
        let bodyPart = restOriginal;
        let afterLoop = '';
        let pd = 0, bd = 0, brd = 0, inS = false, inC = false;
        for (let j = 0; j < restOriginal.length; j++) {
          const c = restOriginal[j];
          if (inS) { if (c === '\\' && j+1 < restOriginal.length) j++; else if (c === '"') inS = false; continue; }
          if (inC) { if (c === '\\' && j+1 < restOriginal.length) j++; else if (c === "'") inC = false; continue; }
          if (c === '"') { inS = true; continue; }
          if (c === "'") { inC = true; continue; }
          if (c === '(') pd++; if (c === ')') pd--;
          if (c === '{') bd++; if (c === '}') bd--;
          if (c === '[') brd++; if (c === ']') brd--;
          if (c === ';' && pd === 0 && bd === 0 && brd === 0) {
            bodyPart = restOriginal.substring(0, j + 1);
            afterLoop = restOriginal.substring(j + 1);
            break;
          }
        }

        // Parse init vars
        let initVars = new Set();
        if (initPart) {
          let declared = parseDeclaration(initPart);
          for (let d of declared) { initVars.add(d.name); }
        }

        // Pre-loop trace (exclude loop vars — not initialized yet)
        let fnArg = `"${currentFunc}", `;
        let captures = genCaptures(varsForCaps(scopeStack, lambdaStack, knownVars), heapPointers, deletedPointers, structDefs, initVars);
        if (captures.length > 0) {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          if (captures.length > 0) { output.push(captures.join(' ')); }
          output.push(`__opt_trace_end__();`);
        } else {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          output.push(`__opt_trace_end__();`);
        }

        // Add init vars to knownVars
        if (initPart) {
          let declared = parseDeclaration(initPart);
          for (let d of declared) {
            knownVars.set(d.name, d);
            scopeStack[scopeStack.length-1].vars.add(d.name);
          }
        }

        // Output: for(...) { __trace; body; } afterLoop;
        let forHeader = `for (${initPart}; ${condPart}; ${incrPart})`;
        output.push(`${forHeader} {`);
        // Per-iteration trace inside loop body
        let captures2 = genCaptures(varsForCaps(scopeStack, lambdaStack, knownVars), heapPointers, deletedPointers, structDefs);
        if (captures2.length > 0) {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          if (captures2.length > 0) { output.push(captures2.join(' ')); }
          output.push(`__opt_trace_end__();`);
        } else {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          output.push(`__opt_trace_end__();`);
        }
        output.push(bodyPart);
        output.push(`}`);
        // Remove loop variables from knownVars — they're scoped to the for-loop
        if (initPart) {
          let declared = parseDeclaration(initPart);
          for (let d of declared) {
            knownVars.delete(d.name);
            scopeStack[scopeStack.length-1].vars.delete(d.name);
          }
        }
        if (afterLoop.trim()) {
          output.push(afterLoop.trim());
        }
        continue;
      }
    }
    if (forMatch) {
      // Parse the init part: e.g., "int i = 0" or "int i = 0, j = 5"
      let initPart = forMatch[1].trim();
      let initVars = new Set();
      if (initPart) {
        let declared = parseDeclaration(initPart);
        for (let d of declared) {
          initVars.add(d.name);
        }
      }
      // Inject a trace call BEFORE the for header (captures pre-loop state)
      // Exclude loop variables (they're not initialized yet)
      let fnArg = `"${currentFunc}", `;
      let captures = genCaptures(varsForCaps(scopeStack, lambdaStack, knownVars), heapPointers, deletedPointers, structDefs, initVars);
      if (captures.length > 0) {
        output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          if (captures.length > 0) { output.push(captures.join(' ')); }
          output.push(`__opt_trace_end__();`);
      } else {
        output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
        output.push(`__opt_trace_end__();`);
      }
      // Now add init vars to knownVars (they'll be visible after the for header executes)
      if (initPart) {
        let declared = parseDeclaration(initPart);
        for (let d of declared) {
          knownVars.set(d.name, d);
          scopeStack[scopeStack.length-1].vars.add(d.name);
        }
      }
      // Output the original for line
      output.push(line);
      // After the for header executes, the loop variable is initialized.
      // Inject another trace showing the for-loop state (i now has a value)
      // ONLY if the for-loop has an opening brace — otherwise the trace
      // would become the loop body, breaking single-statement for-loops.
      if (stripped.includes('{')) {
        let captures2 = genCaptures(varsForCaps(scopeStack, lambdaStack, knownVars), heapPointers, deletedPointers, structDefs);
        if (captures2.length > 0) {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          if (captures2.length > 0) { output.push(captures2.join(' ')); }
          output.push(`__opt_trace_end__();`);
        }
      }
      continue;
    }

    // Try to parse variable declarations from this line
    let declared = parseDeclaration(line);
    // Don't add to knownVars yet — we want to capture state BEFORE this line

    // Check if this line ends a statement (has a semicolon at the top level)
    let stmtComplete = false;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let inStr = false;
    for (let j = 0; j < stripped.length; j++) {
      const c = stripped[j];
      if (inStr) {
        if (c === '\\' && j+1 < stripped.length) { j++; }
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '(') parenDepth++;
      if (c === ')') parenDepth--;
      if (c === '{') braceDepth++;
      if (c === '}') braceDepth--;
      if (c === '[') bracketDepth++;
      if (c === ']') bracketDepth--;
      if (c === ';' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
        stmtComplete = true;
      }
    }
    // Net opening braces left after this line. == 1 (with a pending decl) means
    // the line opens a multi-line initializer block (lambda body / brace-init).
    const netBraceOpen = braceDepth;

    // If the previous line started a multi-line statement (no top-level ';' was
    // found), this line is a continuation. We must NOT inject a trace call
    // between the continuation and the start of the expression — that would
    // break the expression (e.g. `std::cout << 1 \n __trace; \n << 2;` is a
    // syntax error).  Instead, we only check whether the statement is now
    // complete.  If it is, inject the trace AFTER outputting the line (as a
    // post-statement trace) so the expression stays intact.
    if (inMultiLineStmt) {
      // This line is a continuation of a multi-line statement.
      // If the statement is now complete (has a top-level ';'), we can inject
      // a trace AFTER the line.  Otherwise, keep accumulating.
      // Output the continuation line first — do NOT inject trace before it.
      let declared2 = parseDeclaration(line);
      for (let d of declared2) {
        knownVars.set(d.name, d);
        scopeStack[scopeStack.length-1].vars.add(d.name);
      }
      output.push(line);
      if (stmtComplete) {
        // The multi-line statement is now complete.  Inject a trace call
        // AFTER the line to capture state.  This is a post-statement trace
        // (different from the normal pre-statement convention), but it's the
        // only way to avoid breaking the expression.
        let fnArg = `"${currentFunc}", `;
        let captures = genCaptures(varsForCaps(scopeStack, lambdaStack, knownVars), heapPointers, deletedPointers, structDefs);
        output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
        if (captures.length > 0) { output.push(captures.join(' ')); }
        output.push(`__opt_trace_end__();`);
        inMultiLineStmt = false;
      }
      continue;
    }

    // Detect start of a multi-line statement: the line has no top-level ';'
    // but does have expression content (not just a brace, preprocessor, etc.).
    // We set inMultiLineStmt so the next line is treated as a continuation.
    // Skip control-flow keywords and lines that are obviously not expressions.
    if (!stmtComplete && stripped && !stripped.match(/^\s*(for|while|if|else|switch|do|try|catch)\b/)
        && !stripped.endsWith('{') && !stripped.match(/^[};\s]*$/)
        && !stripped.startsWith('#')) {
      inMultiLineStmt = true;
    }

    // Inject trace BEFORE the statement (Python Tutor convention):
    // trace entry's line = the line about to execute
    // variables = state BEFORE this line executes
    // But skip if this line is the body of a brace-less for/while/if
    if (pendingBracelessBody) {
      pendingBracelessBody = false;
      // Don't inject trace — this line is the body of a brace-less control flow
      // Just output the line and add any declared variables
      let declared = parseDeclaration(line);
      for (let d of declared) {
        knownVars.set(d.name, d);
        scopeStack[scopeStack.length-1].vars.add(d.name);
      }
      output.push(line);
      continue;
    }

    // Detect brace-less control flow (for/while/if without {) — next line is the body
    // Must come AFTER the pendingBracelessBody check so the flag is set for the NEXT line
    if (stripped.match(/^\s*(for|while|if)\s*\(/) && !stripped.includes('{') && stripped.endsWith(')')) {
      pendingBracelessBody = true;
    }

    if (stmtComplete && !stripped.match(/^\s*(for|while|if|else|switch|do)\b/)) {
      let fnArg = `"${currentFunc}", `;
      if (inMemberFunction && !memberFunctionIsStatic) {
        // Non-static member function: capture 'this' explicitly, plus all
        // known variables via lambda. The lambda captures 'this' so we can
        // access member variables through the this pointer.
        let captures = genCaptures(varsForCaps(scopeStack, lambdaStack, knownVars), heapPointers, deletedPointers, structDefs);
        if (captures.length > 0) {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          if (captures.length > 0) { output.push(captures.join(' ')); }
          output.push(`__opt_trace_end__();`);
        } else {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          output.push(`__opt_trace_end__();`);
        }
      } else {
        let captures = genCaptures(varsForCaps(scopeStack, lambdaStack, knownVars), heapPointers, deletedPointers, structDefs);
        if (captures.length > 0) {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          if (captures.length > 0) { output.push(captures.join(' ')); }
          output.push(`__opt_trace_end__();`);
        } else {
          output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
          output.push(`__opt_trace_end__();`);
        }
      }
    }

    // Now add declared variables to knownVars.
    // EXCEPTION — block-opening initializers: a declaration whose initializer
    // opens a multi-line block (e.g. a lambda `auto f = [...] { ... }` or a
    // multi-line brace-init `auto x = { ... }`) must be DEFERRED until that
    // block closes. While the initializer is still open the variable's `auto`
    // type is not yet deduced, so capturing `(void*)&f` inside its own
    // initializer is illegal C++ ("use of 'f' before deduction of 'auto'").
    // We record the decl on pendingBlocks (keyed by the scope depth it opened)
    // and add it to knownVars when the block's closing brace pops (see below).
    for (let d of declared) {
      if (d.init && netBraceOpen === 1) {
        // Initializer opens a multi-line block — defer until it closes.
        // ownerScope is the scope that OWNS this variable (one up from the
        // block the initializer just opened). We flush it there once that
        // block's closing brace pops.
        pendingBlocks.push({
          ownerScope: scopeStack[scopeStack.length - 2],
          decls: [d],
        });
        continue;
      }
      knownVars.set(d.name, d);
      scopeStack[scopeStack.length-1].vars.add(d.name);
      // Static local variables: track for globals section, but don't add to
      // globalVars (which are added to main's knownVars). They are only visible
      // in their declaring function.
      if (d.isStatic) {
        staticVars.add(d.name);
      }
    }

    // Detect heap allocations: new T(value) or new T[size]
    if (stmtComplete) {
      // Match: varName = new Type(size)  → single heap value
      // Match: varName = new Type[size]  → heap array
      let newSingleMatch = stripped.match(/(\w+)\s*=\s*new\s+\w+/);
      let newArrMatch = stripped.match(/(\w+)\s*=\s*new\s+\w+\s*\[(\d+)\]/);
      if (newArrMatch) {
        heapPointers.set(newArrMatch[1], parseInt(newArrMatch[2]));
      } else if (newSingleMatch) {
        heapPointers.set(newSingleMatch[1], 0);
      }
    }
    // Detect heap allocations via malloc/calloc (mirror `new`). The heap
    // capture overloads (__opt_cap_heap__ / __opt_cap_heap_arr__) only support
    // int, so gate to an `(int*)` cast; a `(T*)malloc` of another type stays a
    // plain pointer (no crash, no heap block) — extend the overloads to widen.
    if (stmtComplete) {
      let mallocMatch = stripped.match(/(\w+)\s*=\s*\(\s*(unsigned\s+)?(int|long|short|char)\s*\*\s*\)\s*(?:malloc|calloc)\s*\(/);
      if (mallocMatch) {
        const allocVar = mallocMatch[1];
        const allocType = ((mallocMatch[2] || '') + ' ' + mallocMatch[3]).trim();
        if (allocType === 'int') {
          // array? calloc(N, sizeof) or malloc(sizeof(int) * N)
          const callocN = stripped.match(/\bcalloc\s*\(\s*(\d+)\s*,/);
          const szMul = stripped.match(/sizeof\s*\(\s*(?:unsigned\s+)?int\s*\)\s*\*\s*(\d+)/);
          if (callocN) heapPointers.set(allocVar, parseInt(callocN[1]));
          else if (szMul) heapPointers.set(allocVar, parseInt(szMul[1]));
          else heapPointers.set(allocVar, 0);
        }
      }
    }

    // Detect heap deallocations: delete ptr; or delete[] ptr;
    if (stmtComplete) {
      let delMatch = stripped.match(/delete\s*\[\s*\]\s*(\w+)/);
      let delSingleMatch = stripped.match(/delete\s+(\w+)/);
      let freeMatch = stripped.match(/\bfree\s*\(\s*(\w+)\s*\)/);
      if (delMatch) {
        deletedPointers.add(delMatch[1]);
      } else if (delSingleMatch) {
        deletedPointers.add(delSingleMatch[1]);
      } else if (freeMatch) {
        deletedPointers.add(freeMatch[1]);
      }
    }

    // Output the original line
    output.push(line);

  }

  // Return both the instrumented code and the list of global variable names
  return { code: output.join('\n'), globalVars: globalVars.map(g => g.name), staticVars: Array.from(staticVars) };
}

// Backward-compatible string return for any code that expects a string
// (instrumentCode now returns an object; cppworker.js handles both)

// ── cin-prompt protocol: post-read marker injection ──
// Appends a post-read check right after each plain `cin >>` read STATEMENT so
// the runtime can tell when the pre-seeded input runs out:
//   * `__opt_cin_read_done__();` — the statement is NOT inside a for/while/do
//     loop body (i.e. the innermost open block is a function/if/else/switch
//     body). A failed read here means the pre-seeded input is exhausted: the
//     runtime freezes the trace and longjmps back to the worker, which flags
//     the prompt; __opt_finalize__ appends the {"event":"raw_input"} marker
//     the frontend turns into "Enter user input:", then re-executes the whole
//     program with the typed value appended to the input list (matching
//     Python Tutor's input() behavior).
//   * `__opt_cin_read_done_quiet__();` — the statement IS inside a for/while/
//     do loop body. A failed read here ends naturally, exactly like a real
//     C++ stream at EOF (the loop body has already run once on the input).
//     Loop-CONDITION reads (`while (cin >> x)`) are excluded outright — a
//     `while (cin >> x) sum += x;` "sum all inputs" idiom must be able to
//     finish on its own, and its terminating "value" is EOF, which the user
//     cannot type into the input box (a prompt there would be un-breakable).
// Chained reads (`cin >> a >> b;`) need no special handling: if any read in
// the statement fails, failbit stays set (until cin.clear()), so the single
// post-statement check sees it.
// This runs on the FINAL instrumented lines (after line-number remapping), so
// injected marker lines shift nothing and are safe for both the v2 and legacy
// instrumenter outputs.
const __CIN_MARK__ = '__opt_cin_read_done__();';
const __CIN_MARK_QUIET__ = '__opt_cin_read_done_quiet__();';

function __opt_cin_mask__(s) {
  // Blank out string/char literal CONTENTS (keep quote chars) so brace and
  // operator counting is not fooled by literals like "a{b" or '>>'.
  let out = '';
  let inStr = false, inChar = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\' && i + 1 < s.length) { out += '  '; i++; }
      else if (c === '"') { out += '"'; inStr = false; }
      else out += ' ';
      continue;
    }
    if (inChar) {
      if (c === '\\' && i + 1 < s.length) { out += '  '; i++; }
      else if (c === "'") { out += "'"; inChar = false; }
      else out += ' ';
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "'") { inChar = true; out += c; continue; }
    out += c;
  }
  return out;
}

function __opt_is_cin_read_stmt__(maskedLine) {
  if (!maskedLine || maskedLine.endsWith('{') || maskedLine === '}') return false;
  // Loop/control headers never get a marker: their conditions keep natural
  // EOF semantics, and their bodies are handled by the block-kind check.
  if (/^\s*(for|while|do|if|else|switch|return|break|continue)\b/.test(maskedLine)) return false;
  if (!/(^|[^A-Za-z0-9_])cin\s*>>/.test(maskedLine)) return false;
  // Require a top-level ';' (statement boundary).
  let depth = 0;
  for (let i = 0; i < maskedLine.length; i++) {
    const c = maskedLine[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return true;
  }
  return false;
}

// Kind of the block opened by a '{' at position i on this line: 'loop' if a
// for/while header (or `do`) immediately precedes it, 'plain' otherwise.
function __opt_cin_block_kind__(masked, i) {
  const before = masked.substring(0, i);
  if (/\b(for|while)\s*\([^()]*\)\s*$/.test(before) || /^\s*do\s*$/.test(before)) {
    return 'loop';
  }
  return 'plain';
}

function postprocessCinReads(instrumentedCode) {
  const lines = instrumentedCode.split('\n');
  const out = [];
  const blockKinds = []; // kind of each currently open block (innermost last)
  for (const rawLine of lines) {
    const noComment = rawLine.replace(/\/\/.*$/, '');
    const masked = __opt_cin_mask__(noComment);
    const isCin = __opt_is_cin_read_stmt__(masked.trim());
    const inLoop = blockKinds.length > 0 && blockKinds[blockKinds.length - 1] === 'loop';
    // Update the block-kind stack with this line's braces (char scan, so
    // multiple blocks on one line like `} else if (...) {` are handled).
    for (let i = 0; i < masked.length; i++) {
      const c = masked[i];
      if (c === '{') blockKinds.push(__opt_cin_block_kind__(masked, i));
      else if (c === '}' && blockKinds.length > 0) blockKinds.pop();
    }
    out.push(rawLine);
    if (isCin) out.push(inLoop ? __CIN_MARK_QUIET__ : __CIN_MARK__);
  }
  return out.join('\n');
}

self.postprocessCinReads = postprocessCinReads;

// Export for use in worker
self.instrumentCode = instrumentCode;
