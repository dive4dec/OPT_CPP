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

// Track brace depth to know which function/scope we're in
function getBraceDepth(code, upToIndex) {
  let depth = 0;
  let inString = false, inChar = false, inComment = false, inLineComment = false;
  for (let i = 0; i < upToIndex; i++) {
    const c = code[i];
    const next = code[i+1];
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inComment) { if (c === '*' && next === '/') { inComment = false; i++; } continue; }
    if (inString) { if (c === '\\') { i++; } else if (c === '"') inString = false; continue; }
    if (inChar) { if (c === '\\') { i++; } else if (c === "'") inChar = false; continue; }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inComment = true; i++; continue; }
    if (c === '"') { inString = true; continue; }
    if (c === "'") { inChar = true; continue; }
    if (c === '{') depth++;
    if (c === '}') depth--;
  }
  return depth;
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

  // Skip if it's a function definition (has parentheses with types)
  // e.g., "int main()" or "void foo(int x)"
  if (/\w+\s+\w+\s*\([^)]*\)\s*(\{|\s*$)/.test(line) && !line.includes('=')) return [];

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
    // Parse: name [= value] or name[size] or name[] = {...} or name[M][N] = {...}
    // Capture multiple array dimensions: name[2][3]
    let nameMatch = v.match(/^(\w+)\s*((?:\[[^\]]*\])*)\s*(=.*)?$/);
    if (!nameMatch) continue;

    let name = nameMatch[1];
    let arrayPart = nameMatch[2];
    let init = nameMatch[3];

    let isArray = !!arrayPart;
    let arraySize = null;
    let arrayDims = [];
    if (isArray) {
      // Extract all dimensions: [2][3] → [2, 3]
      let dimMatches = arrayPart.match(/\[(\d+)\]/g);
      if (dimMatches) {
        arrayDims = dimMatches.map(d => parseInt(d.match(/\d+/)[0]));
        arraySize = arrayDims[0];
      }
    }

    let isPointer = pointerRef.includes('*') || baseType.includes('*');
    let isReference = pointerRef.includes('&') || baseType.includes('&');

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
    });
  }

  return result;
}

// ── Main instrumentation function ──

// Generate capture calls for all known variables
function genCaptures(knownVars, heapPointers, deletedPointers, structDefs, excludeVars) {
  let captures = [];
  for (let [name, info] of knownVars) {
    if (excludeVars && excludeVars.has(name)) continue;
    if (deletedPointers.has(name)) {
      captures.push(`__t__.cap_deleted_ptr("${name}", ${name});`);
    } else if (heapPointers.has(name)) {
      let sz = heapPointers.get(name);
      captures.push(`__t__.cap_ptr("${name}", ${name}, ${sz});`);
    } else if (info && info.type && structDefs.has(info.type)) {
          // Struct variable: capture with field names
          let fields = structDefs.get(info.type);
          let fieldEncoders = fields.map(f => `__t__.__opt_field__("${f.name}", ${name}.${f.name})`).join(" + \",\" + ");
          captures.push(`__t__.cap_struct("${name}", "${info.type}", ${name}, ${fieldEncoders});`);
    } else {
      captures.push(`__t__.cap("${name}", ${name});`);
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
  let mainFunctionDepth = -1;
  let mainFrameEnsured = false;

  // Track if we're inside a struct/class body (to skip variable declarations)
  let inStructBody = false;
  let structBraceDepth = 0;
  let currentStructName = '';
  let currentStructFields = [];

  // Map: struct name → array of {name, type}
  let structDefs = new Map();

  // Track all function definitions: name → {startLine, endLine, params}
  let functionDefs = [];

  // Track multiline statements
  let inMultilineStatement = false;
  let statementStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let lineNum = i + 1;

    // Strip comments for analysis but keep original for output
    let stripped = stripCommentsAndStrings(line).trim();

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
    if (!inFunctionBody && !mainFrameEnsured) {
      // Push ensure_frame as a separate statement
      output.push('__opt_ensure_frame__("main", 0);');
      mainFrameEnsured = true;
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
        mainFunctionDepth = getBraceDepth(sourceCode, sourceCode.indexOf(line));
        functionDefs.push({name: funcName, startLine: lineNum, params: params});

        // Output the function signature line
        output.push(line);
        // Inject a trace call at function entry (the opening brace line)
        let entryFnArg = `"${funcName}", `;
        output.push(`__opt_trace_fn__(${entryFnArg}${lineNum});`);
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
      // Push new scope
      scopeStack.push({ depth: scopeStack[scopeStack.length-1].depth + 1, vars: new Set() });
    }

    // At file scope (not in function body), track struct/class bodies and global variable declarations
    if (!inFunctionBody) {
      // Detect struct/class body entry: "struct Name {" or "class Name {"
      let structMatch = stripped.match(/^(struct|class)\s+(\w+)\s*\{/);
      if (structMatch) {
        inStructBody = true;
        structBraceDepth = 1;
        currentStructName = structMatch[2];
        currentStructFields = [];
        output.push(line);
        continue;
      }
      // Track braces inside struct body and collect field declarations
      if (inStructBody) {
        for (let c of stripped) {
          if (c === '{') structBraceDepth++;
          if (c === '}') structBraceDepth--;
        }
        // Parse field declarations (e.g., "int x;" → {name: "x", type: "int"})
        if (structBraceDepth > 0) {
          let fieldDecl = parseDeclaration(stripped);
          for (let d of fieldDecl) {
            currentStructFields.push(d);
          }
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
        }
      }
      // Check if we're leaving a function body
      if (inFunctionBody && scopeStack.length <= 1) {
        inFunctionBody = false;
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

    // Determine current function name for frame management
    let currentFunc = 'main';
    for (let fd of functionDefs) {
      if (fd.startLine <= lineNum) currentFunc = fd.name;
    }

    // Check for for-loop header: extract variable declarations from inside for(...)
    let forMatch = stripped.match(/^\s*for\s*\(([^;]*);([^;]*);([^)]*)\)\s*\{?\s*$/);
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
      let captures = genCaptures(knownVars, heapPointers, deletedPointers, structDefs, initVars);
      if (captures.length > 0) {
        output.push(`__opt_trace_fn__(${fnArg}${lineNum}, [&](auto& __t__) { ${captures.join(' ')} });`);
      } else {
        output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
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
      let captures2 = [];
      for (let [name, info] of knownVars) {
        if (heapPointers.has(name)) {
          captures2.push(`__t__.cap_ptr("${name}", ${name}, ${heapPointers.get(name)});`);
        } else {
          captures2.push(`__t__.cap("${name}", ${name});`);
        }
      }
      if (captures2.length > 0) {
        output.push(`__opt_trace_fn__(${fnArg}${lineNum}, [&](auto& __t__) { ${captures2.join(' ')} });`);
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

    // Inject trace BEFORE the statement (Python Tutor convention):
    // trace entry's line = the line about to execute
    // variables = state BEFORE this line executes
    if (stmtComplete && !stripped.match(/^\s*(for|while|if|else|switch|do)\b/)) {
      let fnArg = `"${currentFunc}", `;
      let captures = genCaptures(knownVars, heapPointers, deletedPointers, structDefs);
      if (captures.length > 0) {
        output.push(`__opt_trace_fn__(${fnArg}${lineNum}, [&](auto& __t__) { ${captures.join(' ')} });`);
      } else {
        output.push(`__opt_trace_fn__(${fnArg}${lineNum});`);
      }
    }

    // Now add declared variables to knownVars
    for (let d of declared) {
      knownVars.set(d.name, d);
      scopeStack[scopeStack.length-1].vars.add(d.name);
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

    // Detect heap deallocations: delete ptr; or delete[] ptr;
    if (stmtComplete) {
      let delMatch = stripped.match(/delete\s*\[\s*\]\s*(\w+)/);
      let delSingleMatch = stripped.match(/delete\s+(\w+)/);
      if (delMatch) {
        deletedPointers.add(delMatch[1]);
      } else if (delSingleMatch) {
        deletedPointers.add(delSingleMatch[1]);
      }
    }

    // Output the original line
    output.push(line);

  }

  // Return both the instrumented code and the list of global variable names
  return { code: output.join('\n'), globalVars: globalVars.map(g => g.name) };
}

// Backward-compatible string return for any code that expects a string
// (instrumentCode now returns an object; cppworker.js handles both)

// Export for use in worker
self.instrumentCode = instrumentCode;
