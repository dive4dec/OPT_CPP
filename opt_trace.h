// opt_trace.h — C++ trace runtime for OPT_CPP visualization
// Prepended to user code by cppworker.js.
// Produces JSON trace in Python Tutor C++ format.
//
// Type support:
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

// ── Persistent trace state via Meyers singleton ──
struct __opt_state__ {
  std::string trace_output;
  int step = 0;
  // Heap entries: address → JSON string
  std::vector<std::pair<std::string,std::string>> heap_entries;
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
    heap_entries.clear();
    call_stack.clear();
  }
  // Check if we already have a heap entry for this address
  bool has_heap(const std::string& addr) {
    for(auto& h : heap_entries) if(h.first == addr) return true;
    return false;
  }
  // Add a heap entry (deduplicated by address)
  void add_heap(const std::string& addr, const std::string& json) {
    if(!has_heap(addr)) heap_entries.push_back({addr, json});
  }
  // Build the heap JSON object
  std::string heap_json() {
    if(heap_entries.empty()) return "{}";
    std::string s = "{";
    for(size_t i=0;i<heap_entries.size();i++){
      if(i) s+=",";
      s+="\""+heap_entries[i].first+"\":"+heap_entries[i].second;
    }
    s+="}";
    return s;
  }
};

__opt_state__& __opt_get_state__() {
  static __opt_state__ s; return s;
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
    std::string ptr = v ? __opt_addr__((void*)v) : "0x0";
    return "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"pointer\",\""+ptr+"\",{\"bytes\":"+std::to_string(sizeof(T))+"}]";
  } else {
    // For unknown types (including structs/classes), encode as C_DATA
    // The C_STRUCT format causes frontend assertion failures
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

// ── Helper: get element type name for arrays ──
template<typename T>
std::string __opt_type_name__() {
  return __opt_demangle__(typeid(T).name());
}

// ── Tracer object — accumulates captured variables ──
struct __opt_tracer__ {
  std::string locals;
  std::vector<std::string> names;
  int ln;
  std::string func_name;
  std::string frame_id;
  bool is_parent;

  __opt_tracer__(int line, const char* fn = "main", const char* fid = nullptr, bool parent = false)
    : ln(line), func_name(fn), is_parent(parent) {
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
    } else {
      // For all other types (including structs/classes and pointers),
      // encode as C_DATA using __opt_encode_data__
      add(n, __opt_encode_data__(v));
    }
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

    std::string e = "{\"line\":"+std::to_string(ln)+",\"event\":\"step_line\","
      "\"func_name\":\""+(st.call_stack.empty()?"main":st.call_stack.back().func_name)+"\","
      "\"globals\":{},\"ordered_globals\":[],"
      "\"stack_to_render\":"+stack_json+","
      "\"heap\":"+st.heap_json()+",\"stdout\":\"\"}";
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

// ── Trace macro ──
#define __opt_trace__(...) __opt_trace_impl__(__VA_ARGS__)
#define __opt_trace_fn__(...) __opt_trace_fn_impl__(__VA_ARGS__)

// Helper: pop frames until we're at the named function
void __opt_pop_to__(const char* func_name) {
  auto& st = __opt_get_state__();
  while(!st.call_stack.empty() && st.call_stack.back().func_name != func_name) {
    st.call_stack.pop_back();
  }
  if(st.call_stack.empty()) {
    __opt_push_frame__("main", 0);
  }
}

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
  // 1. A continuation of the same frame (line > current line) — do nothing
  // 2. A recursive call (line <= current line, i.e., back to entry) — push new frame
  if(st.call_stack.back().func_name == func_name) {
    if(line <= st.call_stack.back().line) {
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

template<typename F>
void __opt_trace_impl__(int line, F&& lambda) {
  auto& st = __opt_get_state__();
  if(st.call_stack.empty()) {
    __opt_push_frame__("main", line);
  }

  __opt_tracer__ __t__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
  try {
    lambda(__t__);
  } catch (...) {
  }
  std::cout << __OPT_SENTINEL__;
  std::cout.flush();
  std::string entry = __t__.finish();
  __opt_update_frame__(line, __t__.locals, __t__.names);
  st.trace_output += (st.step>0 ? ",\n" : "") + entry;
  st.step++;
}

// Overload with explicit function name for frame management
template<typename F>
void __opt_trace_fn_impl__(const char* func_name, int line, F&& lambda) {
  __opt_ensure_frame__(func_name, line);
  auto& st = __opt_get_state__();

  __opt_tracer__ __t__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
  try {
    lambda(__t__);
  } catch (...) {
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
  __opt_tracer__ __t__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
  std::cout << __OPT_SENTINEL__;
  std::cout.flush();
  std::string entry = __t__.finish();
  __opt_update_frame__(line, __t__.locals, __t__.names);
  st.trace_output += (st.step>0 ? ",\n" : "") + entry;
  st.step++;
}

void __opt_trace_fn_impl__(const char* func_name, int line) {
  __opt_ensure_frame__(func_name, line);
  auto& st = __opt_get_state__();
  __opt_tracer__ __t__(line, st.call_stack.back().func_name.c_str(),
                        st.call_stack.back().frame_id.c_str());
  std::cout << __OPT_SENTINEL__;
  std::cout.flush();
  std::string entry = __t__.finish();
  __opt_update_frame__(line, __t__.locals, __t__.names);
  st.trace_output += (st.step>0 ? ",\n" : "") + entry;
  st.step++;
}

// ── Finalizer ──
std::string __opt_finalize__() {
  auto& st = __opt_get_state__();
  return "{\"code\":\"\",\"trace\":[" + st.trace_output + "]}";
}
