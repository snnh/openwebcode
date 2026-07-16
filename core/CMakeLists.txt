cmake_minimum_required(VERSION 3.16)
project(openwebcode_core VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_executable(owc-exec
    src/main.c
    src/json.c
    src/rpc.c
    src/exec.c
    src/path_policy.c
    src/fs.c
)

if(WIN32)
    target_sources(owc-exec PRIVATE src/platform/exec_win.c src/platform/path_win.c src/platform/fs_win.c src/platform/sandbox_win.c)
    target_compile_definitions(owc-exec PRIVATE WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
    target_link_libraries(owc-exec PRIVATE userenv advapi32)
else()
    target_sources(owc-exec PRIVATE src/platform/exec_posix.c src/platform/path_posix.c src/platform/fs_posix.c src/platform/sandbox_posix.c)
    target_compile_definitions(owc-exec PRIVATE _POSIX_C_SOURCE=200809L _GNU_SOURCE)
endif()

target_include_directories(owc-exec PRIVATE src)

if(MSVC)
    target_compile_options(owc-exec PRIVATE /W4 /WX)
else()
    target_compile_options(owc-exec PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

include(CTest)
if(BUILD_TESTING)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    add_test(NAME protocol COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_protocol.py $<TARGET_FILE:owc-exec>)
    add_test(NAME fs COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_fs.py $<TARGET_FILE:owc-exec>)

    add_executable(test-path-policy tests/test_path_policy.c src/path_policy.c)
    if(WIN32)
        target_compile_definitions(test-path-policy PRIVATE WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
    endif()
    target_include_directories(test-path-policy PRIVATE src)
    if(MSVC)
        target_compile_options(test-path-policy PRIVATE /W4 /WX)
    else()
        target_compile_options(test-path-policy PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
    add_test(NAME path-policy COMMAND test-path-policy)

    add_executable(test-sandbox tests/test_sandbox.c)
    if(WIN32)
        target_sources(test-sandbox PRIVATE src/platform/sandbox_win.c)
        target_compile_definitions(test-sandbox PRIVATE WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
        target_link_libraries(test-sandbox PRIVATE userenv advapi32)
    else()
        target_sources(test-sandbox PRIVATE src/platform/sandbox_posix.c)
        target_compile_definitions(test-sandbox PRIVATE _POSIX_C_SOURCE=200809L _GNU_SOURCE)
    endif()
    target_include_directories(test-sandbox PRIVATE src)
    if(MSVC)
        target_compile_options(test-sandbox PRIVATE /W4 /WX)
    else()
        target_compile_options(test-sandbox PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
    add_test(NAME sandbox-capability COMMAND test-sandbox)
endif()

install(TARGETS owc-exec RUNTIME DESTINATION bin)
