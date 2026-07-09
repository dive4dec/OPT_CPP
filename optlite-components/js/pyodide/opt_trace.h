// opt_trace.h — C++ trace runtime for OPT_CPP visualization
// Prepended to user code by cppworker.js.
// Produces JSON trace in Python Tutor C++ format.
//
// Type support:
//   C_DATA:                   bool, char, std::string, arithmetic, pointer
//   C_ARRAY:                  T arr[N] (1-D arrays)
//   C_MULTIDIMENSIONAL_ARRAY: T arr[M][N] (2-D+ arrays)
//   C_STRUCT:                 user-defined structs (via opt-in cap method)

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
struct __opt_state__ {
  std::string trace_output;
  int step = 0;
  std::string stdout_buffer;
  std::streambuf* old_buf;
  std::ostringstream oss;

  void redirect() {
    old_buf = std::cout.rdbuf(oss.rdbuf());
    std::cout.setf(std::ios::unitbuf); // unbuffered — flush after every output
  }
  void unredirect() {
    std::cout.rdbuf(old_buf);
    std::cout.unsetf(std::ios::unitbuf);
  }
  std::string drain() {
    std::string s = oss.str(); oss.str(""); oss.clear(); return s;
  }
  void reset() {
    trace_output.clear(); step = 0; stdout_buffer.clear();
    oss.str(""); oss.clear();
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

// ── Frame address (constant) ──
const char* __opt_frame_id__ = "0xFFF000BE0";

// ── Helper: encode a single element as C_DATA ──
// Used by array capture to encode each element
template<typename T>
std::string __opt_encode_data__(const T& v) {
  if constexpr (std::is_same_v<T, bool>) {
    return "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\"bool\","+(v?"true":"false")+",{\"bytes\":1}]";
  } else if constexpr (std::is_same_v<T, char>) {
    // Encode char as a string value, properly escaped for JSON
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
    return "[\"C_DATA\",\""+__opt_addr__(&v)+"\",\""+
        __opt_esc__(__opt_demangle__(typeid(v).name()))+"\",\"<unknown>\",{\"bytes\":"+std::to_string(sizeof(T))+"}]";
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
  __opt_tracer__(int line) : ln(line), locals("{") {}

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
    auto& st = __opt_get_state__();
    // Flush std::cout to ensure all output reaches our ostringstream
    std::cout.flush();
    std::string out = st.drain();
    st.stdout_buffer += out;

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
  try {
    lambda(__t__);
  } catch (...) {
    // If cap() throws, still emit the trace entry with whatever was captured
  }
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
