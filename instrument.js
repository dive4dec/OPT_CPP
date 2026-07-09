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

function instrumentCode(sourceCode) {
  const lines = sourceCode.split('\n');

  // Track all declared variables (type info)
  // Map from variable name → type info
  let knownVars = new Map();

  // Track current scope (brace depth → list of vars declared at that depth)
  let scopeStack = [{ depth: 0, vars: new Set() }];

  // Output lines
  let output = [];

  // Track if we're inside a function body (to skip instrumentation at file scope)
  let inFunctionBody = false;
  let mainFunctionDepth = -1;

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

    // Check for opening brace — entering a new scope
    if (stripped.includes('{')) {
      // Check if this is a function body opening
      // e.g., "int main() {"
      let funcMatch = stripped.match(/(\w+)\s+main\s*\([^)]*\)\s*\{/);
      if (funcMatch) {
        inFunctionBody = true;
        mainFunctionDepth = getBraceDepth(sourceCode, sourceCode.indexOf(line));
      }
      // Push new scope
      scopeStack.push({ depth: scopeStack[scopeStack.length-1].depth + 1, vars: new Set() });
    }

    // Check for closing brace — leaving a scope
    if (stripped.includes('}')) {
      // Pop scope and remove its variables
      if (scopeStack.length > 1) {
        let popped = scopeStack.pop();
        for (let v of popped.vars) {
          knownVars.delete(v);
        }
      }
      if (inFunctionBody && scopeStack.length <= 1) {
        inFunctionBody = false;
      }
    }

    // Only instrument inside function bodies
    if (!inFunctionBody) {
      output.push(line);
      continue;
    }

    // Check for for-loop header: extract variable declarations from inside for(...)
    let forMatch = stripped.match(/^\s*for\s*\(([^;]*);([^;]*);([^)]*)\)\s*\{?\s*$/);
    if (forMatch) {
      // Parse the init part: e.g., "int i = 0" or "int i = 0, j = 5"
      let initPart = forMatch[1].trim();
      if (initPart) {
        let declared = parseDeclaration(initPart);
        for (let d of declared) {
          knownVars.set(d.name, d);
          scopeStack[scopeStack.length-1].vars.add(d.name);
        }
      }
      // Output the original for line
      output.push(line);
      // Inject a trace call right after the for header to capture loop variable state
      let captures = [];
      for (let [name, info] of knownVars) {
        captures.push(`__t__.cap("${name}", ${name});`);
      }
      if (captures.length > 0) {
        output.push(`__opt_trace__(${lineNum}, [&](auto& __t__) { ${captures.join(' ')} });`);
      } else {
        output.push(`__opt_trace__(${lineNum});`);
      }
      continue;
    }

    // Try to parse variable declarations from this line
    let declared = parseDeclaration(line);
    for (let d of declared) {
      knownVars.set(d.name, d);
      scopeStack[scopeStack.length-1].vars.add(d.name);
    }

    // Output the original line
    output.push(line);

    // Check if this line ends a statement (has a semicolon at the top level)
    // We need to handle multiline statements
    let stmtComplete = false;

    // Count unbalanced delimiters in the stripped line
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

    // Only inject trace after statement-ending lines (with semicolons)
    // Skip if the line is a for-loop header (e.g., "for (int i = 0; i < 10; i++)")
    if (stmtComplete && !stripped.match(/^\s*(for|while|if|else|switch|do)\b/)) {
      // Inject trace call with all known variables
      let captures = [];
      for (let [name, info] of knownVars) {
        captures.push(`__t__.cap("${name}", ${name});`);
      }

      if (captures.length > 0) {
        output.push(`__opt_trace__(${lineNum}, [&](auto& __t__) { ${captures.join(' ')} });`);
      } else {
        // Even with no variables, emit a trace point for step navigation
        output.push(`__opt_trace__(${lineNum});`);
      }
    }
  }

  return output.join('\n');
}

// Export for use in worker
self.instrumentCode = instrumentCode;
