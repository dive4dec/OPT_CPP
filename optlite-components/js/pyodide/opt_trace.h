// opt_trace.h — C++ trace runtime for OPT_CPP visualization
// Prepended to user code by cppworker.js.
// Produces JSON trace in Python Tutor C++ format.
//
// Type support:
#ifndef OPT_TRACE_H
#define OPT_TRACE_H
//   C_DATA:                   bool, char, std::string, arithmetic, pointer
//   C_ARRAY:                  T arr[N] (1-D arrays)
//   C_MULTIDIMENSIONAL_ARRAY: T arr[M][N] (2-D+ arrays)
//   C_STRUCT:                 user-defined structs/classes (via cap_struct)
//   Heap:                     dynamically allocated objects (new/malloc)
//   Call stack:               multiple frames for user-defined functions

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sstream>
#include <typeinfo>
#include <type_traits>
#include <cxxabi.h>
#include <iostream>
#include <vector>
#include <functional>

// ── Persistent trace state ──
// NOTE: Meyers singleton (static local) doesn't work in clang-repl —
// each top-level statement may get a different static instance.
// Use a global variable instead, which is shared across all statements.
struct __opt_state__ {
  std::string trace_output;
  int step = 0;
  // Call stack: each entry is {func_name, frame_id, line, locals_json, varnames}
  struct frame_info {
    std::string func_name;
    std::string frame_id;
    int line;
    std::string locals;   // JSON object string
    std::vector<std::string> names;
  };
  std::vector<frame_info> call_stack;

  void reset() {
    trace_output.clear(); step = 0;
    call_stack.clear();
    globals_json = "{}";
    globals_names.clear();
  }
  // Globals storage
  std::string globals_json = "{}";
  std::vector<std::string> globals_names;
};

// Global state instance — shared across all clang-repl top-level statements
__opt_state__ __opt_global_state__;

__opt_state__& __opt_get_state__() {
  return __opt_global_state__;
}

// ── Address formatting ──
std::string __opt_addr__(const void* p) {
  char buf[32]; snprintf(buf, sizeof(buf), "0x%lx", (unsigned long)p); return buf;
}

// ── Demangling ──
std::string __opt_demangle__(const char* n) {
  int st=0; char* d=abi::__cxa_demangle(n,nullptr,nullptr,&st);
  std::string r=(st==0&&d)?d:n; free(d); return r;
}

// ── JSON escape ──
std::string __opt_esc__(const std::string& s) {
  std::string o; o.reserve(s.size()+8);
  for(char c: s) { switch(c){
    case '"': o+="\\\""; break; case '\\': o+="\\\\"; break;
    case '\n': o+="\\n"; break; case '\r': o+="\\r"; break;
    case '\t': o+="\\t"; break;
    default: if((unsigned char)c<0x20){char b[8];snprintf(b,8,"\\u%04x",(unsigned char)c);o+=b;}else o+=c;
  }} return o;
}

// ── Frame ID generation ──
static int __opt_frame_counter__ = 0;
std::string __opt_new_frame_id__() {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%08X", ++__opt_frame_counter__);
  return buf;
}

// Forward declarations
template<typename T> std::string __opt_encode_data__(const T& v);
template<typename T> std::string __opt_encode_value__(const T& v);

// ── Helper: encode a single element as C_DATA ──
template<typename T>
std::string __opt_encode_data__(const T& v) {
  if constexpr (std::is_same_v<T, bool>) {
    return "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"bool\","+(v?"true":"false")+",{\"bytes\":1}]";
  } else if constexpr (std::is_same_v<T, char>) {
    std::string charStr;
    if(v>=32&&v<127) { charStr=std::string("'")+v+"'"; }
    else if(v=='\n') { charStr="'\\n'"; }
    else if(v=='\t') { charStr="'\\t'"; }
    else if(v==0) { charStr="'\\0'"; }
    else { char b[8]; snprintf(b,8,"'\\x%02x'",(unsigned char)v); charStr=b; }
    return "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"char\",\""+__opt_esc__(charStr)+"\",{\"bytes\":1}]";
  } else if constexpr (std::is_same_v<T, std::string>) {
    return "[\"C_DATA\",\""+__opt_addr__(v.c_str())+"\",\"string\",\""+__opt_esc__(v)+"\",{\"bytes\":"+std::to_string(v.size()+1)+"}]";
  } else if constexpr (std::is_arithmetic_v<T>) {
    std::ostringstream os; os<<v;
    std::string typeName = __opt_demangle__(typeid(v).name());
    return "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\""+__opt_esc__(typeName)+"\","+os.str()+",{\"bytes\":"+std::to_string(sizeof(T))+"}]";
  } else if constexpr (std::is_pointer_v<T>) {
    using PointedType = std::remove_pointer_t<T>;
    std::string ptr = v ? __opt_addr__((void*)v) : "0x0";
    return "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"pointer\",\""+ptr+"\",{\"bytes\":"+std::to_string(sizeof(T))+"}]";
  } else if constexpr (std::is_class_v<T>) {
    // For class/struct types, emit C_STRUCT with the proper type name
    // instead of <unknown>. C++ has no reflection, so fields cannot be
    // enumerated automatically; the type name is shown for identification.
    std::string addr = __opt_addr__(&v);
    return "[\"C_STRUCT\",\""+addr+"\",\"" + __opt_esc__(__opt_demangle__(typeid(v).name()))+"\",[]]";
  } else {
    std::string addr = __opt_addr__(&v);
    return "[\"C_DATA\",\""+addr+"\",\"object\",\"<unknown>\",{\"bytes\":"+std::to_string(sizeof(T))+"}]";
  }
}

// ── Helper: encode value for struct fields (recursive) ──
// Same as __opt_encode_data__ but also handles structs and arrays
template<typename T>
std::string __opt_encode_value__(const T& v) {
  if constexpr (std::is_array_v<T>) {
    using InnerType = std::remove_extent_t<T>;
    if constexpr (std::is_array_v<InnerType>) {
      constexpr std::size_t M = std::extent_v<T>;
      constexpr std::size_t N = std::extent_v<InnerType>;
      const auto* ptr = &v[0][0];
      std::string s = "[\"C_MULTIDIMENSIONAL_ARRAY\",\""+__opt_addr__(ptr)+"\",["+std::to_string(M)+","+std::to_string(N)+"]";
      for(std::size_t i=0; i<M; i++) {
        for(std::size_t j=0; j<N; j++) {
          s += "," + __opt_encode_data__(ptr[i*N+j]);
        }
      }
      s += "]";
      return s;
    } else {
      constexpr std::size_t N = std::extent_v<T>;
      const auto* ptr = &v[0];
      std::string s = "[\"C_ARRAY\",\""+__opt_addr__(ptr)+"\"";
      for(std::size_t i=0; i<N; i++) {
        s += "," + __opt_encode_data__(ptr[i]);
      }
      s += "]";
      return s;
    }
  } else if constexpr (std::is_class_v<T>) {
    // C_STRUCT: encode as struct with type name
    // We can't iterate struct members in C++ without reflection,
    // so we rely on the struct having an __opt_cap__ method.
    // If it doesn't, we fall back to <unknown>.
    return "[\"C_STRUCT\",\""+__opt_addr__(&v)+"\",\""+
      __opt_esc__(__opt_demangle__(typeid(v).name()))+"\",[]]";
  } else {
    return __opt_encode_data__(v);
  }
}

// ── Tracer object — accumulates captured variables ──
struct __opt_tracer__ {
  std::string locals;
  std::vector<std::string> names;
  int ln;
  std::string func_name;
  std::string frame_id;

  __opt_tracer__(int line, const char* fn = "main", const char* fid = nullptr)
    : ln(line), func_name(fn) {
    locals = "{";
    if(fid) frame_id = fid;
    else frame_id = "0xFFF000BE0"; // default main frame
  }

  // ── cap() for all types — uses if constexpr for type dispatch ──
  template<typename T>
  void cap(const std::string& n, const T& v) {
    if constexpr (std::is_array_v<T>) {
      // Array: T is ElemType[N] (or ElemType[M][N] for 2D)
      using InnerType = std::remove_extent_t<T>;
      if constexpr (std::is_array_v<InnerType>) {
        // 2-D array: T is ElemType[M][N]
        constexpr std::size_t M = std::extent_v<T>;
        constexpr std::size_t N = std::extent_v<InnerType>;
        const auto* ptr = &v[0][0];
        std::string s = "[\"C_MULTIDIMENSIONAL_ARRAY\",\""+__opt_addr__(ptr)+"\",["+std::to_string(M)+","+std::to_string(N)+"]";
        for(std::size_t i=0; i<M; i++) {
          for(std::size_t j=0; j<N; j++) {
            s += "," + __opt_encode_data__(ptr[i*N+j]);
          }
        }
        s += "]";
        add(n, s);
      } else {
        // 1-D array: T is ElemType[N]
        constexpr std::size_t N = std::extent_v<T>;
        const auto* ptr = &v[0];
        std::string s = "[\"C_ARRAY\",\""+__opt_addr__(ptr)+"\"";
        for(std::size_t i=0; i<N; i++) {
          s += "," + __opt_encode_data__(ptr[i]);
        }
        s += "]";
        add(n, s);
      }
    } else if constexpr (std::is_class_v<T>) {
      // For class/struct types, use __opt_encode_value__ which emits
      // C_STRUCT with the proper type name (instead of the
      // __opt_encode_data__ fallthrough that produces <unknown>).
      add(n, __opt_encode_value__(v));
    } else {
      // For all other types (including pointers),
      // encode as C_DATA using __opt_encode_data__
      add(n, __opt_encode_data__(v));
    }
  }

  void cap_deleted_ptr(const std::string& n, int* v) {
    // Show pointer on stack as NULL (freed) — no heap entry
    // Setting address to 0x0 prevents isHeapRef from matching
    add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"pointer\",\"0x0\",{\"bytes\":"+std::to_string(sizeof(int*))+"}]");
  }

  // cap_this: capture the 'this' pointer in a member function
  // 'this' is a prvalue, so we can't take its address with &this
  // The caller passes the this pointer as a void*
  void cap_this(const std::string& typeName, void* thisPtr) {
    std::string addr = __opt_addr__(thisPtr);
    add("this", "[\"C_DATA\",\""+addr+"\",\"pointer\",\""+addr+"\",{\"bytes\":"+std::to_string(sizeof(void*))+"}]");
  }

  // cap_struct: capture a struct by building C_STRUCT JSON from pre-encoded fields
  // Called as: cap_struct("varName", "TypeName", var, "addr", encodedFields)
  // where encodedFields is a pre-built string like: ["x",3],["y",4]
  template<typename T>
  void cap_struct(const std::string& n, const std::string& typeName, const T& v, const std::string& fieldsStr) {
    std::string addr = __opt_addr__(&v);
    std::string s = "[\"C_STRUCT\",\""+addr+"\",\""+__opt_esc__(typeName)+"\"";
    if(!fieldsStr.empty()) s += "," + fieldsStr;
    s += "]";
    add(n, s);
  }

  // Helper to encode a single field value as JSON
  template<typename T>
  std::string __opt_field__(const std::string& name, const T& v) {
    return "[\"" + __opt_esc__(name) + "\"," + __opt_encode_data__(v) + "]";
  }

  // cap_ptr: capture a pointer, embeds heap data via string accumulation
  // Uses a std::string for heap accumulation (vectors don't work in clang-repl)
  void cap_ptr(const std::string& n, int* v, int arrSize = 0) {
    std::string ptr = v ? __opt_addr__((void*)v) : "0x0";
    std::string typeLabel = "pointer";
    // Encode heap data in a special variable __heap__ that finish() extracts
    std::string heapEntry = "";
    if(arrSize > 0 && v) {
      heapEntry = "\"" + ptr + "\":[\"C_ARRAY\",\"" + ptr + "\"";
      for(int i = 0; i < arrSize; i++) {
        heapEntry += ",[\"C_DATA\",\"" + ptr + "\",\"int\"," + std::to_string(v[i]) + ",{\"bytes\":4}]";
      }
      heapEntry += "]";
    } else if(v) {
      heapEntry = "\"" + ptr + "\":[\"C_ARRAY\",\"" + ptr + "\",[\"C_DATA\",\"" + ptr + "\",\"int\"," + std::to_string(*v) + ",{\"bytes\":4}]]";
    } else {
      heapEntry = "\"0x0\":[\"C_DATA\",\"0x0\",\"null\",\"null\",{}]";
    }
    // Store heap entry as a fake variable (extracted by runner.ts)
    // The value is a string that runner.ts parses to build the heap object
    add("__heap__", "\"HEAP:" + __opt_esc__(heapEntry) + "\"");
    // Also add the pointer itself
    add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\""+__opt_esc__(typeLabel)+"\",\""+ptr+"\",{\"bytes\":"+std::to_string(sizeof(int*))+"}]");
  }

  void add(const std::string& n, const std::string& encoded) {
    if(locals.size()>1) locals+=",";
    locals+="\""+__opt_esc__(n)+"\":"+encoded;
    names.push_back(n);
  }

  std::string finish() {
    locals+="}";

    std::string varnames="[";
    for(size_t i=0;i<names.size();i++){if(i)varnames+=",";varnames+="\""+__opt_esc__(names[i])+"\"";}
    varnames+="]";

    auto& st = __opt_get_state__();

    // Build stack_to_render from the call stack
    // For the top frame, use this tracer's locals/names (current step data)
    // Note: __heap__ entries in locals are extracted by runner.ts to build heap
    std::string stack_json = "[";
    for(size_t i=0;i<st.call_stack.size();i++){
      if(i) stack_json+=",";
      auto& f = st.call_stack[i];
      bool is_last = (i == st.call_stack.size()-1);
      std::string parent_ids = "[";
      if(i > 0) parent_ids += "\""+st.call_stack[i-1].frame_id+"\"";
      parent_ids += "]";
      std::string hash = f.func_name + "_" + f.frame_id;

      // For the top frame, use current tracer data
      std::string frame_locals = is_last ? locals : f.locals;
      std::string frame_varnames = is_last ? varnames : "[";
      if(!is_last) {
        for(size_t j=0;j<f.names.size();j++){if(j)frame_varnames+=",";frame_varnames+="\""+__opt_esc__(f.names[j])+"\"";}
        frame_varnames += "]";
      }
      int frame_line = is_last ? ln : f.line;

      stack_json += "{\"frame_id\":\""+f.frame_id+"\","
        "\"func_name\":\""+f.func_name+"\","
        "\"is_highlighted\":"+std::string(is_last?"true":"false")+","
        "\"is_parent\":"+std::string(i < st.call_stack.size()-1 ? "true":"false")+","
        "\"is_zombie\":false,"
        "\"line\":"+std::to_string(frame_line)+","
        "\"ordered_varnames\":"+frame_varnames+","
        "\"parent_frame_id_list\":"+parent_ids+","
        "\"unique_hash\":\""+hash+"\","
        "\"encoded_locals\":"+frame_locals+
        "}";
    }
    // If call_stack is empty, add a main frame
    if(st.call_stack.empty()) {
      std::string fid = "0xFFF000BE0";
      stack_json += "{\"frame_id\":\""+fid+"\","
        "\"func_name\":\"main\","
        "\"is_highlighted\":true,"
        "\"is_parent\":false,"
        "\"is_zombie\":false,"
        "\"line\":"+std::to_string(ln)+","
        "\"ordered_varnames\":"+varnames+","
        "\"parent_frame_id_list\":[],"
        "\"unique_hash\":\"main_"+fid+"\","
        "\"encoded_locals\":"+locals+
        "}";
    }
    stack_json += "]";

    // Build ordered_globals
    std::string globals_varnames="[";
    for(size_t j=0;j<st.globals_names.size();j++){if(j)globals_varnames+=",";globals_varnames+="\""+__opt_esc__(st.globals_names[j])+"\"";}
    globals_varnames+="]";

    // Heap is built by runner.ts from __heap__ entries in locals
    std::string heapJson = "{}";
    
    std::string e = "{\"line\":"+std::to_string(ln)+",\"event\":\"step_line\","
      "\"func_name\":\""+(st.call_stack.empty()?"main":st.call_stack.back().func_name)+"\","
      "\"globals\":"+st.globals_json+",\"ordered_globals\":"+globals_varnames+","
      "\"stack_to_render\":"+stack_json+","
      "\"heap\":"+heapJson+",\"stdout\":\"\"}";
    return e;
  }
};

// ── Sentinel for per-step stdout capture ──
static const char* __OPT_SENTINEL__ = "\x01\x02__OPT_STEP__\x02\x01";

// ── Frame management ──
// Push a new frame onto the call stack
void __opt_push_frame__(const char* func_name, int line) {
  auto& st = __opt_get_state__();
  __opt_state__::frame_info fi;
  fi.func_name = func_name;
  fi.frame_id = __opt_new_frame_id__();
  fi.line = line;
  fi.locals = "{";
  st.call_stack.push_back(fi);
}

// Pop a frame from the call stack
void __opt_pop_frame__() {
  auto& st = __opt_get_state__();
  if(!st.call_stack.empty()) st.call_stack.pop_back();
}

// Update the top frame's variables
void __opt_update_frame__(int line, const std::string& locals,
                          const std::vector<std::string>& names) {
  auto& st = __opt_get_state__();
  if(!st.call_stack.empty()) {
    st.call_stack.back().line = line;
    st.call_stack.back().locals = locals;
    st.call_stack.back().names = names;
  }
}

// ── Global current tracer pointer ──
// Set by __opt_trace_fn_impl__/__opt_trace_impl__ when creating a tracer.
// Used by __opt_cap__* non-template functions to add variables without
// requiring template instantiation (which fails in clang-repl WASM).
__opt_tracer__* __opt_current_tracer__ = nullptr;

// ── Trace macro ──
// Use std::function instead of template parameter to avoid per-lambda
// template instantiation in clang-repl, which fails silently for some types.
#define __opt_trace__(...) __opt_trace_impl__(__VA_ARGS__)
#define __opt_trace_fn__(...) __opt_trace_fn_impl__(__VA_ARGS__)

// Ensure a frame exists for the named function; push if not on top,
// pop if returning to a parent frame.
// For recursive calls (same function name on top), push a new frame.
void __opt_ensure_frame__(const char* func_name, int line) {
  auto& st = __opt_get_state__();
  if(st.call_stack.empty()) {
    __opt_push_frame__(func_name, line);
    return;
  }
  // If the top frame is already this function, it's either:
  // 1. A continuation of the same frame (line >= current line) — do nothing
  // 2. A recursive call (line < current line, i.e., back to entry) — push new frame
  if(st.call_stack.back().func_name == func_name) {
    if(line < st.call_stack.back().line) {
      // Recursive call — push a new frame
      __opt_push_frame__(func_name, line);
    }
    // Otherwise, same frame continuing — do nothing
    return;
  }
  // Check if this function is already on the stack (returning to a parent)
  for(int i = (int)st.call_stack.size() - 1; i >= 0; i--) {
    if(st.call_stack[i].func_name == func_name) {
      // Pop frames down to this one
      while((int)st.call_stack.size() > i + 1) st.call_stack.pop_back();
      return;
    }
  }
  // Not on stack — push as a new child frame
  __opt_push_frame__(func_name, line);
}

// Use std::function instead of template F&& to avoid per-lambda template
// instantiation in clang-repl incremental compilation mode.
void __opt_trace_impl__(int line, const std::function<void(__opt_tracer__&)>& lambda) {
  auto& st = __opt_get_state__();
  if(st.call_stack.empty()) {
    __opt_push_frame__("main", line);
  }

  __opt_tracer__ __t__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
  try {
    lambda(__t__);
  } catch (const std::exception& e) {
    // If cap() throws (e.g., bad pointer dereference), add error info
    __t__.add("__opt_error__", "[\"C_DATA\",\"0x0\",\"error\",\"" + __opt_esc__(e.what()) + "\",{}]");
  } catch (...) {
    __t__.add("__opt_error__", "[\"C_DATA\",\"0x0\",\"error\",\"unknown\",{}]");
  }
  std::cout << __OPT_SENTINEL__;
  std::cout.flush();
  std::string entry = __t__.finish();
  __opt_update_frame__(line, __t__.locals, __t__.names);
  st.trace_output += (st.step>0 ? ",\n" : "") + entry;
  st.step++;
}

// Overload with explicit function name for frame management
// Use std::function instead of template F&& to avoid per-lambda template
// instantiation in clang-repl incremental compilation mode.
void __opt_trace_fn_impl__(const char* func_name, int line, const std::function<void(__opt_tracer__&)>& lambda) {
  __opt_ensure_frame__(func_name, line);
  auto& st = __opt_get_state__();

  __opt_tracer__ __t__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
  try {
    lambda(__t__);
  } catch (const std::exception& e) {
    __t__.add("__opt_error__", "[\"C_DATA\",\"0x0\",\"error\",\"" + __opt_esc__(e.what()) + "\",{}]");
  } catch (...) {
    __t__.add("__opt_error__", "[\"C_DATA\",\"0x0\",\"error\",\"unknown\",{}]");
  }
  std::cout << __OPT_SENTINEL__;
  std::cout.flush();
  std::string entry = __t__.finish();
  __opt_update_frame__(line, __t__.locals, __t__.names);
  st.trace_output += (st.step>0 ? ",\n" : "") + entry;
  st.step++;
}

void __opt_trace_impl__(int line) {
  auto& st = __opt_get_state__();
  if(st.call_stack.empty()) {
    __opt_push_frame__("main", line);
  }
  // Create tracer on heap so it persists for cap() calls
  // (freed by __opt_trace_end__)
  if(__opt_current_tracer__) delete __opt_current_tracer__;
  __opt_current_tracer__ = new __opt_tracer__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
}

// Finalize the current trace step: write sentinel, build entry, update frame
void __opt_trace_end__() {
  if(!__opt_current_tracer__) return;
  auto& st = __opt_get_state__();
  std::cout << __OPT_SENTINEL__;
  std::cout.flush();
  std::string entry = __opt_current_tracer__->finish();
  __opt_update_frame__(__opt_current_tracer__->ln, __opt_current_tracer__->locals, __opt_current_tracer__->names);
  st.trace_output += (st.step>0 ? ",\n" : "") + entry;
  st.step++;
  delete __opt_current_tracer__;
  __opt_current_tracer__ = nullptr;
}

void __opt_trace_fn_impl__(const char* func_name, int line) {
  __opt_ensure_frame__(func_name, line);
  auto& st = __opt_get_state__();
  if(__opt_current_tracer__) delete __opt_current_tracer__;
  __opt_current_tracer__ = new __opt_tracer__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
}

// Variant for member functions: captures 'this' pointer
void __opt_trace_fn_this__(const char* func_name, int line, const char* typeName, void* thisPtr) {
  __opt_ensure_frame__(func_name, line);
  auto& st = __opt_get_state__();
  if(__opt_current_tracer__) delete __opt_current_tracer__;
  __opt_current_tracer__ = new __opt_tracer__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
  __opt_current_tracer__->cap_this(typeName, thisPtr);
}
// ── Overloaded cap functions ──
// Use C++ function overloading so the compiler selects the correct
// function based on the actual argument type. No JS-side type guessing
// needed — the compiler knows the real type (including auto, arrays, etc.)
void __opt_cap__(const char* n, int v) {
  if(!__opt_current_tracer__) return;
  std::ostringstream os; os<<v;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"int\","+os.str()+",{\"bytes\":4}]");
}
void __opt_cap__(const char* n, unsigned v) {
  if(!__opt_current_tracer__) return;
  std::ostringstream os; os<<v;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"unsigned\","+os.str()+",{\"bytes\":4}]");
}
void __opt_cap__(const char* n, long v) {
  if(!__opt_current_tracer__) return;
  std::ostringstream os; os<<v;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"long\","+os.str()+",{\"bytes\":8}]");
}
void __opt_cap__(const char* n, unsigned long v) {
  if(!__opt_current_tracer__) return;
  std::ostringstream os; os<<v;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"unsigned long\","+os.str()+",{\"bytes\":8}]");
}
void __opt_cap__(const char* n, long long v) {
  if(!__opt_current_tracer__) return;
  std::ostringstream os; os<<v;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"long long\","+os.str()+",{\"bytes\":8}]");
}
void __opt_cap__(const char* n, unsigned long long v) {
  if(!__opt_current_tracer__) return;
  std::ostringstream os; os<<v;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"unsigned long long\","+os.str()+",{\"bytes\":8}]");
}
void __opt_cap__(const char* n, double v) {
  if(!__opt_current_tracer__) return;
  std::ostringstream os; os<<v;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"double\","+os.str()+",{\"bytes\":8}]");
}
void __opt_cap__(const char* n, float v) {
  if(!__opt_current_tracer__) return;
  std::ostringstream os; os<<v;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"float\","+os.str()+",{\"bytes\":4}]");
}
void __opt_cap__(const char* n, bool v) {
  if(!__opt_current_tracer__) return;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"bool\","+(v?"true":"false")+",{\"bytes\":1}]");
}
void __opt_cap__(const char* n, char v) {
  if(!__opt_current_tracer__) return;
  std::string charStr;
  if(v>=32&&v<127) { charStr=std::string("'")+v+"'"; }
  else if(v=='\n') { charStr="'\\n'"; }
  else if(v=='\t') { charStr="'\\t'"; }
  else if(v==0) { charStr="'\\0'"; }
  else { char b[8]; snprintf(b,8,"'\\x%02x'",(unsigned char)v); charStr=b; }
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"char\",\""+__opt_esc__(charStr)+"\",{\"bytes\":1}]");
}
void __opt_cap__(const char* n, const std::string& v) {
  if(!__opt_current_tracer__) return;
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(v.c_str())+"\",\"string\",\""+__opt_esc__(v)+"\",{\"bytes\":"+std::to_string(v.size()+1)+"}]");
}
// Pointer overloads — captures the pointer address
void __opt_cap__(const char* n, int* v) {
  if(!__opt_current_tracer__) return;
  std::string ptr = v ? __opt_addr__((void*)v) : "0x0";
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"pointer\",\""+ptr+"\",{\"bytes\":8}]");
}
void __opt_cap__(const char* n, char* v) {
  if(!__opt_current_tracer__) return;
  std::string ptr = v ? __opt_addr__((void*)v) : "0x0";
  __opt_current_tracer__->add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"pointer\",\""+ptr+"\",{\"bytes\":8}]");
}
// Fixed-size int arrays — show as C_ARRAY with element count
void __opt_cap_array__(const char* n, int* v, int sz) {
  if(!__opt_current_tracer__) return;
  std::string ptr = v ? __opt_addr__((void*)v) : "0x0";
  __opt_current_tracer__->add(n, "[\"C_ARRAY\",\""+ptr+"\",\"int\","+std::to_string(sz)+",\""+ptr+"\",{\"bytes\":4}]");
}
// Fixed-size char arrays (strings) — show as C_ARRAY of chars
void __opt_cap_array__(const char* n, char* v, int sz) {
  if(!__opt_current_tracer__) return;
  std::string ptr = v ? __opt_addr__((void*)v) : "0x0";
  __opt_current_tracer__->add(n, "[\"C_ARRAY\",\""+ptr+"\",\"char\","+std::to_string(sz)+",\""+ptr+"\",{\"bytes\":1}]");
}
// Generic fallback for unknown types — just show type name
void __opt_cap_unknown__(const char* n, const char* typeName, const void* addr) {
  if(!__opt_current_tracer__) return;
  __opt_current_tracer__->add(n, "[\"C_STRUCT\",\""+__opt_addr__(addr)+"\",\""+__opt_esc__(typeName)+"\",[]]");
}

// ── Finalizer ──
std::string __opt_finalize__() {
  auto& st = __opt_get_state__();
  return "{\"code\":\"\",\"trace\":[" + st.trace_output + "]}";
}

#endif // OPT_TRACE_H
