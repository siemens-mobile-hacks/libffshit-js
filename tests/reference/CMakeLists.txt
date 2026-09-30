# The C++ libffshit, built from its sources, and ffshit-ref, which the tests compare the rewrite
# with. LIBFFSHIT_SOURCE_DIR is the libffshit source tree, by default next to this repository.

cmake_minimum_required(VERSION 3.15)

project(ffshit_reference LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(LIBFFSHIT_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../libffshit" CACHE PATH "The libffshit source tree")

file(GLOB_RECURSE LIBFFSHIT_SOURCES "${LIBFFSHIT_SOURCE_DIR}/src/*.cpp")

if (NOT LIBFFSHIT_SOURCES)
    message(FATAL_ERROR "No libffshit sources in ${LIBFFSHIT_SOURCE_DIR}. Set LIBFFSHIT_SOURCE_DIR.")
endif()

find_package(Iconv REQUIRED)

add_library(ffshit_reference STATIC ${LIBFFSHIT_SOURCES})

target_include_directories(ffshit_reference PUBLIC
    "${LIBFFSHIT_SOURCE_DIR}/inc"
    "${LIBFFSHIT_SOURCE_DIR}/src"
    "${LIBFFSHIT_SOURCE_DIR}/third_party/fmt/include"
    ${Iconv_INCLUDE_DIRS})

target_compile_definitions(ffshit_reference PUBLIC FMT_HEADER_ONLY)
target_link_libraries(ffshit_reference PUBLIC ${Iconv_LIBRARIES})

add_executable(ffshit-ref ffshit-ref.cpp)
target_link_libraries(ffshit-ref PRIVATE ffshit_reference)
