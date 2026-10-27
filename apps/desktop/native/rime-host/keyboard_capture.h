#pragma once

#include <functional>
#include <cstdint>
#include <memory>
#include <string>

struct CapturedKeyboardEvent {
  std::uint32_t generation{};
  std::uint64_t event_id{};
  std::string key;
  std::string code;
  bool shift{};
  bool ctrl{};
  bool alt{};
  bool meta{};
  bool release{};
  bool repeat{};
};

/** Windows-only, lease-scoped keyboard capture used by the non-activating editor. */
class KeyboardCapture {
 public:
  using EventSink = std::function<bool(const CapturedKeyboardEvent&)>;
  using StopSink = std::function<void(const std::string&)>;

  KeyboardCapture();
  ~KeyboardCapture();
  KeyboardCapture(const KeyboardCapture&) = delete;
  KeyboardCapture& operator=(const KeyboardCapture&) = delete;

  static bool available();
  bool active() const;
  bool start(std::uint32_t generation, unsigned long owner_process_id, EventSink event_sink,
             StopSink stop_sink);
  bool acknowledge(std::uint32_t generation, std::uint64_t event_id, bool handled);
  void stop(const std::string& reason = "released");

 private:
  struct State;
  std::unique_ptr<State> state_;
};
