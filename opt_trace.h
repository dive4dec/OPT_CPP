// opt_trace.h — C++ trace runtime for OPT_CPP visualization
// Prepended to user code by cppworker.js.
// Produces JSON trace in Python Tutor C++ format.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sstream>
#include <typeinfo>
#include <cxxabi.h>
#include <iostream>
#include <streambuf>

// ── Persistent trace state via Meyers singleton ──
// In clang-repl, static/local variables in functions persist across
// top-level statements, unlike file-scope statics which get re-initialized.
struct __opt_state__ {
  std::string trace_output;
  int step = 0;
  std::string stdout_buffer;

  // stdout redirect
  std::streambuf* old_buf;
  std::ostringstream oss;

  void redirect() {
    old_buf = std::cout.rdbuf(oss.rdbuf());
  }
  void unredirect() {
    std::cout.rdbuf(old_buf);
  }
  std::string drain() {
    std::string s = oss.str();
    oss.str("");
    oss.clear();
    return s;
  }

  // Reset for a new execution
  void reset() {
    trace_output.clear();
    step = 0;
    stdout_buffer.clear();
    oss.str("");
    oss.clear();
  }
};

__opt_state__& __opt_get_state__() {
  // Meyers singleton — persists across REPL statements
  static __opt_state__ s;
  return s;
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

// ── Frame address (constant) ──
const char* __opt_frame_id__ = "0xFFF000BE0";

// ── Tracer object — accumulates captured variables ──
struct __opt_tracer__ {
  std::string locals;
  std::vector<std::string> names;
  int ln;
  __opt_tracer__(int line) : ln(line), locals("{") {}

  // Unified cap() using if-constexpr for type dispatch
  // C_DATA format: ["C_DATA", address, typeName, value, {"bytes": N}]
  template<typename T>
  void cap(const std::string& n, const T& v) {
    if constexpr (std::is_same_v<T, bool>) {
      add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"bool\","+(v?"true":"false")+",{\"bytes\":1}]");
    } else if constexpr (std::is_same_v<T, char>) {
      char b[8];
      if(v>=32&&v<127) snprintf(b,8,"'%c'",v);
      else if(v=='\n') snprintf(b,8,"'\\n'");
      else if(v=='\t') snprintf(b,8,"'\\t'");
      else if(v=='\0') snprintf(b,8,"'\\0'");
      else snprintf(b,8,"'\\x%02x'",(unsigned char)v);
      add(n, std::string("[\"C_DATA\",\"")+__opt_addr__(&v)+"\",\"char\",\""+b+"\",{\"bytes\":1}]");
    } else if constexpr (std::is_same_v<T, std::string>) {
      add(n, "[\"C_DATA\",\""+__opt_addr__(v.c_str())+"\",\"string\",\""+__opt_esc__(v)+"\",{\"bytes\":"+std::to_string(v.size()+1)+"}]");
    } else if constexpr (std::is_arithmetic_v<T>) {
      std::ostringstream os; os<<v;
      std::string typeName = __opt_demangle__(typeid(v).name());
      int bytes = sizeof(T);
      add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\""+__opt_esc__(typeName)+"\","+os.str()+",{\"bytes\":"+std::to_string(bytes)+"}]");
    } else if constexpr (std::is_pointer_v<T>) {
      std::string ptr = v ? __opt_addr__((void*)v) : "0x0";
      add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"pointer\",\""+ptr+"\",{\"bytes\":"+std::to_string(sizeof(T))+"}]");
    } else {
      add(n, "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\""+
          __opt_esc__(__opt_demangle__(typeid(v).name()))+"\",\"<unknown>\",{\"bytes\":"+std::to_string(sizeof(T))+"}]");
    }
  }

  void add(const std::string& n, const std::string& encoded) {
    if(locals.size()>1) locals+=",";
    locals+="\""+__opt_esc__(n)+"\":"+encoded;
    names.push_back(n);
  }

  std::string finish() {
    locals+="}";
    auto& st = __opt_get_state__();
    // Drain stdout captured since last trace point
    std::string out = st.drain();
    st.stdout_buffer += out;

    // Build ordered_varnames array
    std::string varnames="[";
    for(size_t i=0;i<names.size();i++){if(i)varnames+=",";varnames+="\""+__opt_esc__(names[i])+"\"";}
    varnames+="]";

    std::string fid = __opt_frame_id__;
    std::string hash = std::string("main_")+fid;

    std::string e = "{\"line\":"+std::to_string(ln)+",\"event\":\"step_line\","
      "\"func_name\":\"main\","
      "\"globals\":{},\"ordered_globals\":[],"
      "\"stack_to_render\":[{"
      "\"frame_id\":\""+fid+"\","
      "\"func_name\":\"main\","
      "\"is_highlighted\":true,"
      "\"is_parent\":false,"
      "\"is_zombie\":false,"
      "\"line\":"+std::to_string(ln)+","
      "\"ordered_varnames\":"+varnames+","
      "\"parent_frame_id_list\":[],"
      "\"unique_hash\":\""+hash+"\","
      "\"encoded_locals\":"+locals+
      "}],"
      "\"heap\":{},\"stdout\":\""+__opt_esc__(st.stdout_buffer)+"\"}";
    return e;
  }
};

// ── Trace macro ──
#define __opt_trace__(...) __opt_trace_impl__(__VA_ARGS__)

template<typename F>
void __opt_trace_impl__(int line, F&& lambda) {
  __opt_tracer__ __t__(line);
  lambda(__t__);
  std::string entry = __t__.finish();
  auto& st = __opt_get_state__();
  if(st.step>0) st.trace_output+=",\n";
  st.trace_output+=entry;
  st.step++;
}

void __opt_trace_impl__(int line) {
  __opt_tracer__ __t__(line);
  std::string entry = __t__.finish();
  auto& st = __opt_get_state__();
  if(st.step>0) st.trace_output+=",\n";
  st.trace_output+=entry;
  st.step++;
}

// ── Finalizer ──
std::string __opt_finalize__() {
  auto& st = __opt_get_state__();
  return "{\"code\":\"\",\"trace\":[" + st.trace_output + "]}";
}
