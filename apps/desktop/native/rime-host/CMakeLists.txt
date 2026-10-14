cmake_minimum_required(VERSION 3.20)
project(answra_rime_host LANGUAGES CXX)

if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/include/rime_api.h")
  message(FATAL_ERROR "official librime rime_api.h is required")
endif()

add_executable(answra-rime-host main.cpp)
target_compile_features(answra-rime-host PRIVATE cxx_std_17)
target_include_directories(answra-rime-host PRIVATE include)
if(WIN32)
  target_compile_definitions(answra-rime-host PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()
if(WIN32)
  set_target_properties(answra-rime-host PROPERTIES
    OUTPUT_NAME "answra-rime-host"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}"
  )
  if(MINGW)
    target_link_options(answra-rime-host PRIVATE -municode)
  endif()
else()
  target_link_libraries(answra-rime-host PRIVATE ${CMAKE_DL_LIBS})
endif()
