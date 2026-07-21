cmake_minimum_required(VERSION 3.19)
project(openwebcode_core VERSION 0.2.2 LANGUAGES C)

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
    target_sources(owc-exec PRIVATE src/icon.rc src/platform/exec_win.c src/platform/path_win.c src/platform/fs_win.c src/platform/sandbox_win.c)
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

# ---------------------------------------------------------------------------
# 分发打包（CPack）
#
# 职责划分：CPack 只组装安装包骨架（owc-exec 本体 + 下方 stage 整树收编），
# 不负责构建/收集 server、web 与 Node 运行时。发布流水线
# （.github/workflows/release.yml）在调用 cpack 之前，先把完整运行时布局
# staging 到 ${CMAKE_BINARY_DIR}/stage/，契约如下：
#   stage/bin/owc-exec(.exe)     core 可执行文件
#   stage/bin/owc.cmd            Windows 启动脚本（由 packaging/owc.cmd 转 CRLF 生成）
#   stage/server/dist/           服务端编译产物（入口 dist/index.js）
#   stage/server/package.json    "type": "module" 声明，dist ESM 运行必需
#   stage/server/node_modules/   生产依赖（npm prune --omit=dev 之后）
#   stage/server/assets/         运行时资产（refs-clone.ps1 等）
#   stage/web/dist/              前端静态资源（server 解析 server/dist/../../web/dist 托管）
#   stage/node/                  Node 20 运行时（Windows: node.exe；Linux: bin/node）
# 本地开发 configure 时 stage/ 通常不存在：install(DIRECTORY ... OPTIONAL)
# 静默跳过，此时包内只有 owc-exec。
# ---------------------------------------------------------------------------
install(DIRECTORY "${CMAKE_BINARY_DIR}/stage/" DESTINATION . OPTIONAL)

set(CPACK_PACKAGE_NAME "openwebcode")
set(CPACK_PACKAGE_VENDOR "OpenWebCode")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "OpenWebCode: web-based agentic coding environment")
# 版本默认 0.2.2；CI 用 -DCPACK_PACKAGE_VERSION=x.y.z 注入 tag 版本
set(CPACK_PACKAGE_VERSION "0.2.2" CACHE STRING "Package version (x.y.z)")
# WiX accepts .rtf directly and converts .txt to RTF, but rejects a license
# path without an extension. Keep the repository's canonical LICENSE intact
# and give the configured copy the extension required by the generator.
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/../LICENSE" "${CMAKE_CURRENT_BINARY_DIR}/LICENSE.txt" COPYONLY)
set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_CURRENT_BINARY_DIR}/LICENSE.txt")
set(CPACK_PACKAGE_INSTALL_DIRECTORY "openwebcode")
if(WIN32)
    set(CPACK_GENERATOR "WIX")
    # 产物名固定为 openwebcode-<version>-windows-x64.msi（Linux tar.gz 由 CI 直接 tar，不经 CPack）
    set(CPACK_PACKAGE_FILE_NAME "${CPACK_PACKAGE_NAME}-${CPACK_PACKAGE_VERSION}-windows-x64")
else()
    set(CPACK_GENERATOR "TGZ")
endif()
# 固定 UpgradeCode，跨版本升级识别为同一产品；不要再改
set(CPACK_WIX_UPGRADE_GUID "7F3A2C1E-9B4D-4E6F-A1C8-2D5B7E9F0C3A")

if(WIN32)
    # 安装程序与程序和功能使用同一套应用图标。该资源也由 src/icon.rc
    # 编入 owc-exec.exe，因此安装后和裸可执行文件的视觉标识保持一致。
    set(CPACK_WIX_PRODUCT_ICON "${CMAKE_CURRENT_SOURCE_DIR}/../assets/icon.ico")

    # 开始菜单快捷方式始终提供；桌面快捷方式及用户 PATH 由自定义 WiX
    # 选项页控制。目标必须是实际启动 Server 的 owc.cmd，而非仅提供 RPC
    # 的 owc-exec.exe。
    set(CPACK_WIX_PROGRAM_MENU_FOLDER "OpenWebCode")
    set_property(INSTALL "bin/owc.cmd" PROPERTY CPACK_START_MENU_SHORTCUTS "OpenWebCode")

    # CPack 没有 WIX 的 ADD_TO_PATH 开关，也无法把桌面快捷方式做成可选项。
    # 使用完整但改名的 InstallDir UI，在安装目录选择页与确认页之间插入
    # OpenWebCode 选项页；组件本身放在额外 WXS，默认数据清理仍由 patch
    # 注入。不要改 CPACK_WIX_INSTALL_SCOPE：已发布 MSI 使用 CPack 的遗留
    # NONE 行为，切换为 perMachine 会破坏其升级兼容性。
    set(CPACK_WIX_UI_REF "OpenWebCodeUI")
    set(CPACK_WIX_EXTRA_SOURCES
        "${CMAKE_CURRENT_SOURCE_DIR}/../packaging/openwebcode-ui.wxs")
    set(CPACK_WIX_PATCH_FILE "${CMAKE_CURRENT_SOURCE_DIR}/../packaging/wix-patch.xml")
    set(CPACK_WIX_CUSTOM_XMLNS "util=http://schemas.microsoft.com/wix/UtilExtension")
    set(CPACK_WIX_EXTENSIONS "WixUtilExtension")
endif()

include(CPack)
