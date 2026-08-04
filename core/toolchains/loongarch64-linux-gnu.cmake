# LoongArch64 (Loongson) Linux cross-compile toolchain for owc-exec.
# Used by release.yml/core.yml on x64 ubuntu runners:
#   sudo apt-get install -y gcc-14-loongarch64-linux-gnu
#   cmake -S core -B build --toolchain core/toolchains/loongarch64-linux-gnu.cmake
# No emulator is assumed: CI only compiles (ctest is skipped for this target).
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR loongarch64)

# Ubuntu noble ships only versioned cross packages (gcc-14-loongarch64-linux-gnu);
# accept both the unversioned driver and the versioned ones.
find_program(CMAKE_C_COMPILER NAMES loongarch64-linux-gnu-gcc loongarch64-linux-gnu-gcc-14 loongarch64-linux-gnu-gcc-13 REQUIRED)
find_program(CMAKE_CXX_COMPILER NAMES loongarch64-linux-gnu-g++ loongarch64-linux-gnu-g++-14 loongarch64-linux-gnu-g++-13)

# Target-side search roots; host tools/headers stay on the host paths.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
