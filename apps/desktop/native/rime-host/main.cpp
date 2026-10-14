#include "rime_api.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
using LibraryHandle = HMODULE;
static LibraryHandle open_library(const std::string& path) {
  const int count = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  std::wstring wide(count, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wide.data(), count);
  return LoadLibraryExW(wide.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
}
static void* get_symbol(LibraryHandle library, const char* name) {
  return reinterpret_cast<void*>(GetProcAddress(library, name));
}
static void close_library(LibraryHandle library) { FreeLibrary(library); }
#else
#include <dlfcn.h>
using LibraryHandle = void*;
static LibraryHandle open_library(const std::string& path) {
  return dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
}
static void* get_symbol(LibraryHandle library, const char* name) {
  return dlsym(library, name);
}
static void close_library(LibraryHandle library) { dlclose(library); }
#endif

static std::string json_escape(const char* value) {
  std::string output;
  if (!value) return output;
  for (const unsigned char ch : std::string(value)) {
    switch (ch) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (ch < 0x20) {
          static const char hex[] = "0123456789abcdef";
          output += "\\u00";
          output += hex[ch >> 4];
          output += hex[ch & 0x0f];
        } else {
          output += static_cast<char>(ch);
        }
    }
  }
  return output;
}

class RimeHost {
 public:
  bool initialize(const std::string& library_path, const std::string& shared_dir,
                  const std::string& user_dir, const std::string& schema) {
    library_ = open_library(library_path);
    if (!library_) return false;
    using GetApi = RimeApi* (*)();
    auto get_api = reinterpret_cast<GetApi>(get_symbol(library_, "rime_get_api"));
    if (!get_api) return false;
    api_ = get_api();
    if (!api_ || !RIME_API_AVAILABLE(api_, setup) ||
        !RIME_API_AVAILABLE(api_, initialize) ||
        !RIME_API_AVAILABLE(api_, deploy_schema) ||
        !RIME_API_AVAILABLE(api_, create_session) ||
        !RIME_API_AVAILABLE(api_, select_schema) ||
        !RIME_API_AVAILABLE(api_, process_key) ||
        !RIME_API_AVAILABLE(api_, get_context) ||
        !RIME_API_AVAILABLE(api_, free_context) ||
        !RIME_API_AVAILABLE(api_, get_commit) ||
        !RIME_API_AVAILABLE(api_, free_commit) ||
        !RIME_API_AVAILABLE(api_, set_option) ||
        !RIME_API_AVAILABLE(api_, clear_composition) ||
        !RIME_API_AVAILABLE(api_, destroy_session)) return false;

    RIME_STRUCT(RimeTraits, traits);
    traits.shared_data_dir = shared_dir.c_str();
    traits.user_data_dir = user_dir.c_str();
    traits.app_name = "rime.answra";
    traits.min_log_level = 2;
    traits.log_dir = "";
    api_->setup(&traits);
    api_->initialize(&traits);
    if (RIME_API_AVAILABLE(api_, start_maintenance) &&
        RIME_API_AVAILABLE(api_, join_maintenance_thread)) {
      api_->start_maintenance(False);
      api_->join_maintenance_thread();
    }
    const std::string schema_file = shared_dir + "/" + schema + ".schema.yaml";
    // Deploy dependencies explicitly: easy_en is referenced by the simplified
    // Chinese schema and librime does not always build dependency prisms when
    // only the top-level schema is deployed.
    const std::string easy_schema = shared_dir + "/easy_en.schema.yaml";
    if (schema == "luna_pinyin_simp" && api_->deploy_schema(easy_schema.c_str()) == False) {
      std::cerr << "rime dependency deployment failed: " << easy_schema << std::endl;
      return false;
    }
    if (api_->deploy_schema(schema_file.c_str()) == False) {
      std::cerr << "rime schema deployment failed: " << schema_file << std::endl;
      return false;
    }
    session_ = api_->create_session();
    ready_ = session_ != 0 && api_->select_schema(session_, schema.c_str());
    if (ready_) {
      // The embedded editor always starts in Chinese mode. This is the
      // official session option and avoids inheriting an old ASCII-mode user
      // setting from a system or previous Rime frontend.
      api_->set_option(session_, "ascii_mode", False);
    }
    return ready_;
  }

  ~RimeHost() {
    if (api_ && session_ && RIME_API_AVAILABLE(api_, destroy_session)) {
      api_->destroy_session(session_);
    }
    if (api_ && RIME_API_AVAILABLE(api_, finalize)) api_->finalize();
    if (library_) close_library(library_);
  }

  std::string state(bool handled = false, const std::string& committed = "") {
    RimeContext context{};
    RIME_STRUCT_INIT(RimeContext, context);
    const bool has_context = api_->get_context(session_, &context) != False;
    const std::string preedit = has_context ? json_escape(context.composition.preedit) : "";
    std::ostringstream candidates;
    candidates << '[';
    int count = 0;
    if (has_context && context.menu.candidates) {
      count = std::min(context.menu.num_candidates, 20);
      for (int index = 0; index < count; ++index) {
        if (index) candidates << ',';
        const RimeCandidate& item = context.menu.candidates[index];
        candidates << "{\"text\":\"" << json_escape(item.text) << "\"";
        if (item.comment && item.comment[0]) {
          candidates << ",\"comment\":\"" << json_escape(item.comment) << "\"";
        }
        candidates << '}';
      }
    }
    candidates << ']';
    int selected = has_context ? context.menu.highlighted_candidate_index : 0;
    int page = has_context ? context.menu.page_no : 0;
    bool has_next = has_context && !context.menu.is_last_page;
    if (has_context) api_->free_context(&context);
    return std::string("{\"enabled\":") + (enabled_ ? "true" : "false") +
           ",\"composing\":" + ((preedit.size() || count) ? "true" : "false") +
           ",\"preedit\":\"" + preedit + "\",\"candidates\":" + candidates.str() +
           ",\"selectedIndex\":" + std::to_string(selected) +
           ",\"page\":" + std::to_string(page) +
           ",\"hasNextPage\":" + (has_next ? "true" : "false") +
           ",\"committedText\":" +
           (committed.empty() ? "null" : "\"" + json_escape(committed.c_str()) + "\"") +
           ",\"handled\":" + (handled ? "true" : "false") + '}';
  }

  std::string execute(const std::vector<std::string>& fields) {
    if (!ready_ || fields.empty()) return state(false);
    const std::string& command = fields[0];
    if (command == "enable" && fields.size() == 2) {
      enabled_ = fields[1] == "1";
      if (!enabled_) api_->clear_composition(session_);
      return state(false);
    }
    if (command == "key" && fields.size() == 3 && enabled_) {
      const bool handled = api_->process_key(session_, std::stoi(fields[1]),
                                             std::stoi(fields[2])) != False;
      return state(handled, take_commit());
    }
    if (command == "select" && fields.size() == 2 && enabled_ &&
        RIME_API_AVAILABLE(api_, select_candidate_on_current_page)) {
      const bool handled = api_->select_candidate_on_current_page(
                               session_, static_cast<size_t>(std::stoul(fields[1]))) != False;
      return state(handled, take_commit());
    }
    if (command == "reset" && enabled_) {
      api_->clear_composition(session_);
      return state(true);
    }
    return state(false);
  }

  bool ready() const { return ready_; }

 private:
  std::string take_commit() {
    RimeCommit commit{};
    RIME_STRUCT_INIT(RimeCommit, commit);
    if (!api_->get_commit(session_, &commit)) return "";
    const std::string text = commit.text ? commit.text : "";
    api_->free_commit(&commit);
    return text;
  }

  LibraryHandle library_{};
  RimeApi* api_{};
  RimeSessionId session_{};
  bool ready_{};
  bool enabled_{};
};

static std::vector<std::string> split_tabs(const std::string& line) {
  std::vector<std::string> fields;
  std::istringstream stream(line);
  std::string field;
  while (std::getline(stream, field, '\t')) fields.push_back(field);
  return fields;
}

static std::string utf8(const std::wstring& value) {
#ifdef _WIN32
  const int count = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string result(count > 0 ? count : 0, '\0');
  if (count > 0) {
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, result.data(), count, nullptr, nullptr);
    result.pop_back();
  }
  return result;
#else
  return std::string(value.begin(), value.end());
#endif
}

static int run(const std::vector<std::string>& args) {
  if (args.size() != 5) return 2;
  RimeHost host;
  const bool available = host.initialize(args[1], args[2], args[3], args[4]);
  std::cout << "0\t{\"available\":" << (available ? "true" : "false") << "}\n" << std::flush;
  if (!available) return 3;
  std::string line;
  while (std::getline(std::cin, line)) {
    const std::vector<std::string> fields = split_tabs(line);
    if (fields.size() < 2) continue;
    if (fields[1] == "quit") break;
    try {
      std::vector<std::string> command(fields.begin() + 1, fields.end());
      std::cout << fields[0] << '\t' << host.execute(command) << '\n' << std::flush;
    } catch (const std::exception&) {
      std::cout << fields[0] << '\t' << host.state(false) << '\n' << std::flush;
    }
  }
  return 0;
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  std::vector<std::string> args;
  for (int index = 0; index < argc; ++index) args.push_back(utf8(argv[index]));
  return run(args);
}
#else
int main(int argc, char** argv) {
  std::vector<std::string> args(argv, argv + argc);
  return run(args);
}
#endif
