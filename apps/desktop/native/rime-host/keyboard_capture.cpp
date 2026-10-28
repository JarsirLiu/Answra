#include "keyboard_capture.h"

#ifdef _WIN32

#include <windows.h>

#include <array>
#include <atomic>
#include <chrono>
#include <future>
#include <mutex>
#include <thread>
#include <unordered_set>
#include <utility>

namespace {

constexpr UINT WM_CAPTURE_STOP = WM_APP + 41;
constexpr UINT_PTR CAPTURE_IDLE_TIMER = 1;
constexpr UINT CAPTURE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
struct HookState {
  std::atomic<bool> active{false};
  std::uint32_t generation{};
  DWORD owner_process_id{};
  HWND owner_window{};
  std::atomic<DWORD> thread_id{0};
  HWND original_foreground{};
  std::chrono::steady_clock::time_point last_input{};
  std::mutex reason_mutex;
  std::string stop_reason{"released"};
  KeyboardCapture::EventSink event_sink;
  KeyboardCapture::StopSink stop_sink;
  std::unordered_set<DWORD> pressed_keys;
  std::uint64_t next_event_id{};
  HHOOK keyboard_hook{};
  HHOOK mouse_hook{};
};

std::atomic<HookState*> current_hook_state{};

LRESULT CALLBACK keyboard_hook_proc(int code, WPARAM message, LPARAM data);
LRESULT CALLBACK mouse_hook_proc(int code, WPARAM message, LPARAM data);

void request_stop(HookState* state, const char* reason) {
  if (!state || !state->active.exchange(false, std::memory_order_acq_rel)) return;
  {
    std::lock_guard<std::mutex> lock(state->reason_mutex);
    state->stop_reason = reason;
  }
  const DWORD thread_id = state->thread_id.load(std::memory_order_acquire);
  if (thread_id != 0) PostThreadMessageW(thread_id, WM_CAPTURE_STOP, 0, 0);
}

std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int count = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                                       nullptr, 0, nullptr, nullptr);
  if (count <= 0) return {};
  std::string result(static_cast<size_t>(count), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), count,
                      nullptr, nullptr);
  return result;
}

bool key_for_event(DWORD vk, DWORD scan, bool shift, HKL layout, std::string& key,
                   std::string& code) {
  switch (vk) {
    case VK_BACK: key = "Backspace"; code = "Backspace"; return true;
    case VK_TAB: key = "Tab"; code = "Tab"; return true;
    case VK_RETURN: key = "Enter"; code = (scan & 0x100) ? "NumpadEnter" : "Enter"; return true;
    case VK_ESCAPE: key = "Escape"; code = "Escape"; return true;
    case VK_SPACE: key = " "; code = "Space"; return true;
    case VK_DELETE: key = "Delete"; code = "Delete"; return true;
    case VK_LEFT: key = "ArrowLeft"; code = "ArrowLeft"; return true;
    case VK_RIGHT: key = "ArrowRight"; code = "ArrowRight"; return true;
    case VK_UP: key = "ArrowUp"; code = "ArrowUp"; return true;
    case VK_DOWN: key = "ArrowDown"; code = "ArrowDown"; return true;
    case VK_PRIOR: key = "PageUp"; code = "PageUp"; return true;
    case VK_NEXT: key = "PageDown"; code = "PageDown"; return true;
    case VK_HOME: key = "Home"; code = "Home"; return true;
    case VK_END: key = "End"; code = "End"; return true;
    case VK_OEM_1: code = "Semicolon"; break;
    case VK_OEM_PLUS: code = "Equal"; break;
    case VK_OEM_COMMA: code = "Comma"; break;
    case VK_OEM_MINUS: code = "Minus"; break;
    case VK_OEM_PERIOD: code = "Period"; break;
    case VK_OEM_2: code = "Slash"; break;
    case VK_OEM_3: code = "Backquote"; break;
    case VK_OEM_4: code = "BracketLeft"; break;
    case VK_OEM_5: code = "Backslash"; break;
    case VK_OEM_6: code = "BracketRight"; break;
    case VK_OEM_7: code = "Quote"; break;
    case VK_SHIFT:
    case VK_LSHIFT:
    case VK_RSHIFT:
      key = "Shift";
      code = (vk == VK_RSHIFT || scan == 0x36) ? "ShiftRight" : "ShiftLeft";
      return true;
    default: break;
  }

  if (vk >= 'A' && vk <= 'Z') {
    code = "Key" + std::string(1, static_cast<char>(vk));
  } else if (vk >= '0' && vk <= '9') {
    code = "Digit" + std::string(1, static_cast<char>(vk));
  } else if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) {
    code = "Numpad" + std::to_string(vk - VK_NUMPAD0);
  } else if (code.empty()) {
    return false;
  }

  std::array<BYTE, 256> keyboard_state{};
  if (shift) keyboard_state[VK_SHIFT] = 0x80;
  if (GetKeyState(VK_CAPITAL) & 1) keyboard_state[VK_CAPITAL] = 0x01;
  std::array<wchar_t, 8> characters{};
  const int count = ToUnicodeEx(vk, scan & 0xff, keyboard_state.data(), characters.data(),
                                static_cast<int>(characters.size()), 0x4, layout);
  if (count == 0) return false;
  const int character_count = count < 0 ? 1 : count;
  key = utf8(std::wstring(characters.data(), characters.data() + character_count));
  return !key.empty();
}

bool is_modifier_or_system_key(DWORD vk) {
  return vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL || vk == VK_MENU ||
         vk == VK_LMENU || vk == VK_RMENU || vk == VK_LWIN || vk == VK_RWIN ||
         vk == VK_CAPITAL || vk == VK_NUMLOCK || vk == VK_SCROLL || vk == VK_SNAPSHOT ||
         (vk >= VK_F1 && vk <= VK_F24);
}

bool modifier_down(int key) {
  return (GetAsyncKeyState(key) & 0x8000) != 0;
}

LRESULT CALLBACK keyboard_hook_proc(int code, WPARAM message, LPARAM data) {
  const auto next = [&]() { return CallNextHookEx(nullptr, code, message, data); };
  if (code < 0 || (message != WM_KEYDOWN && message != WM_SYSKEYDOWN && message != WM_KEYUP &&
                   message != WM_SYSKEYUP))
    return next();

  HookState* state = current_hook_state.load(std::memory_order_acquire);
  if (!state) return next();
  const auto* key_data = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
  const DWORD vk = key_data->vkCode;
  const bool release = message == WM_KEYUP || message == WM_SYSKEYUP;
  if (!state->active.load(std::memory_order_acquire)) {
    // Once capture has stopped, every physical key edge must reach Windows.
    // Swallowing a pending key-up leaves modifiers or Backspace logically stuck
    // in the next foreground application.
    return next();
  }
  const bool previously_captured = state->pressed_keys.find(vk) != state->pressed_keys.end();
  if (is_modifier_or_system_key(vk) || (release && !previously_captured)) return next();

  const bool ctrl = modifier_down(VK_CONTROL);
  const bool alt = modifier_down(VK_MENU);
  const bool meta = modifier_down(VK_LWIN) || modifier_down(VK_RWIN);
  if (!release && (ctrl || alt || meta)) return next();

  const bool shift = modifier_down(VK_SHIFT) || vk == VK_SHIFT || vk == VK_LSHIFT || vk == VK_RSHIFT;
  DWORD foreground_thread = GetWindowThreadProcessId(state->original_foreground, nullptr);
  HKL layout = GetKeyboardLayout(foreground_thread);
  CapturedKeyboardEvent captured;
  if (!key_for_event(vk, key_data->scanCode, shift, layout, captured.key, captured.code)) return next();

  captured.shift = shift;
  captured.generation = state->generation;
  captured.event_id = ++state->next_event_id;
  captured.ctrl = false;
  captured.alt = false;
  captured.meta = false;
  captured.release = release;
  if (!release) {
    captured.repeat = !state->pressed_keys.insert(vk).second;
  } else {
    state->pressed_keys.erase(vk);
  }

  if (!state->event_sink || !state->event_sink(captured)) {
    request_stop(state, "event-delivery-failed");
    return next();
  }
  // Escape ends the lease even when the editor has no composition to consume it.
  // Keep the physical Escape behavior by letting an unhandled key continue to Windows.
  if (!release && vk == VK_ESCAPE) {
    request_stop(state, "escape");
    state->pressed_keys.erase(vk);
    return next();
  }
  state->last_input = std::chrono::steady_clock::now();
  return 1;
}

LRESULT CALLBACK mouse_hook_proc(int code, WPARAM message, LPARAM data) {
  const auto next = [&]() { return CallNextHookEx(nullptr, code, message, data); };
  if (code < 0 || (message != WM_LBUTTONDOWN && message != WM_RBUTTONDOWN &&
                   message != WM_MBUTTONDOWN && message != WM_XBUTTONDOWN))
    return next();
  HookState* state = current_hook_state.load(std::memory_order_acquire);
  if (!state || !state->active.load(std::memory_order_acquire)) return next();
  const auto* mouse_data = reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
  // Low-level hooks report physical screen coordinates. `WindowFromPhysicalPoint`
  // keeps hit-testing in the same space even when this helper is DPI-unaware.
  const HWND target = WindowFromPhysicalPoint(mouse_data->pt);
  // Chromium can return a renderer-owned child HWND; the top-level HWND belongs to Electron.
  const HWND root = target ? GetAncestor(target, GA_ROOT) : nullptr;
  DWORD target_process = 0;
  if (root) GetWindowThreadProcessId(root, &target_process);
  const bool inside_owner_window =
      state->owner_window && target &&
      (target == state->owner_window || IsChild(state->owner_window, target) ||
       GetAncestor(target, GA_ROOTOWNER) == state->owner_window);
  const bool inside_owner_process = target_process == state->owner_process_id;
  // Electron/Chromium can expose a transient top-level HWND for a renderer or
  // popup. The lease owns the exact BrowserWindow, so HWND ancestry is the
  // authority; PID is retained only for diagnostics and compatibility.
  if (!inside_owner_window && !inside_owner_process) request_stop(state, "outside-click");
  return next();
}

}  // namespace

struct KeyboardCapture::State : HookState {
  std::thread worker;
  std::unique_ptr<std::promise<bool>> started;
};

KeyboardCapture::KeyboardCapture() : state_(std::make_unique<State>()) {}

KeyboardCapture::~KeyboardCapture() { stop("shutdown"); }

bool KeyboardCapture::available() { return true; }

bool KeyboardCapture::active() const {
  return state_ && state_->active.load(std::memory_order_acquire);
}

bool KeyboardCapture::start(std::uint32_t generation, unsigned long owner_process_id,
                            std::uintptr_t owner_window_handle, EventSink event_sink,
                            StopSink stop_sink) {
  if (!state_ || state_->active.load(std::memory_order_acquire)) return active();
  if (state_->worker.joinable()) state_->worker.join();
  state_->event_sink = std::move(event_sink);
  state_->stop_sink = std::move(stop_sink);
  state_->generation = generation;
  state_->owner_process_id = static_cast<DWORD>(owner_process_id);
  state_->owner_window = reinterpret_cast<HWND>(owner_window_handle);
  state_->started = std::make_unique<std::promise<bool>>();
  state_->original_foreground = GetForegroundWindow();
  if (!state_->original_foreground) return false;
  state_->pressed_keys.clear();
  state_->next_event_id = 0;
  state_->last_input = std::chrono::steady_clock::now();
  {
    std::lock_guard<std::mutex> lock(state_->reason_mutex);
    state_->stop_reason = "released";
  }
  state_->active.store(true, std::memory_order_release);
  auto ready = state_->started->get_future();
  state_->worker = std::thread([state = state_.get()] {
    PeekMessageW(nullptr, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    state->thread_id.store(GetCurrentThreadId(), std::memory_order_release);
    current_hook_state.store(state, std::memory_order_release);
    state->keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard_hook_proc,
                                             GetModuleHandleW(nullptr), 0);
    state->mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, mouse_hook_proc,
                                          GetModuleHandleW(nullptr), 0);
    // The owner window is deliberately non-activating. A foreground transition is
    // therefore expected while the lease is active and must not stop capture.
    // Outside clicks, explicit release, Escape, and idle timeout end the lease.
    const bool installed = state->keyboard_hook && state->mouse_hook;
    state->started->set_value(installed);
    if (!installed) request_stop(state, "hook-install-failed");
    if (installed) SetTimer(nullptr, CAPTURE_IDLE_TIMER, CAPTURE_IDLE_TIMEOUT_MS, nullptr);

    MSG message{};
    while (installed && GetMessageW(&message, nullptr, 0, 0) > 0) {
      if (message.message == WM_CAPTURE_STOP) break;
      if (message.message == WM_TIMER &&
          std::chrono::steady_clock::now() - state->last_input >=
              std::chrono::milliseconds(CAPTURE_IDLE_TIMEOUT_MS)) {
        request_stop(state, "idle-timeout");
        break;
      }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }

    KillTimer(nullptr, CAPTURE_IDLE_TIMER);
    if (state->keyboard_hook) UnhookWindowsHookEx(state->keyboard_hook);
    if (state->mouse_hook) UnhookWindowsHookEx(state->mouse_hook);
    state->keyboard_hook = nullptr;
    state->mouse_hook = nullptr;
    state->active.store(false, std::memory_order_release);
    current_hook_state.store(nullptr, std::memory_order_release);
    if (state->stop_sink) {
      std::string reason;
      {
        std::lock_guard<std::mutex> lock(state->reason_mutex);
        reason = state->stop_reason;
      }
      state->stop_sink(reason);
    }
  });

  if (ready.wait_for(std::chrono::seconds(3)) != std::future_status::ready || !ready.get()) {
    stop("hook-install-failed");
    return false;
  }
  return true;
}

void KeyboardCapture::stop(const std::string& reason) {
  if (!state_) return;
  if (state_->active.load(std::memory_order_acquire)) request_stop(state_.get(), reason.c_str());
  if (state_->worker.joinable()) state_->worker.join();
}

#else

struct KeyboardCapture::State {};
KeyboardCapture::KeyboardCapture() : state_(std::make_unique<State>()) {}
KeyboardCapture::~KeyboardCapture() = default;
bool KeyboardCapture::available() { return false; }
bool KeyboardCapture::active() const { return false; }
bool KeyboardCapture::start(std::uint32_t, unsigned long, std::uintptr_t, EventSink, StopSink) {
  return false;
}
void KeyboardCapture::stop(const std::string&) {}

#endif
