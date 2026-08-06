#include "../pty.h"
#include "../exec.h"
#include "../sandbox.h"

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* ConPTY entry points are resolved at runtime: below Windows 10 1809 they do
 * not exist, and core.ping must not advertise the pty capability there.
 * Declared with local types so older SDK headers are not required. */
typedef void *owc_hpcon;
typedef HRESULT (WINAPI *create_pseudo_console_fn)(COORD size, HANDLE input, HANDLE output, DWORD flags, owc_hpcon *console);
typedef HRESULT (WINAPI *resize_pseudo_console_fn)(owc_hpcon console, COORD size);
typedef void (WINAPI *close_pseudo_console_fn)(owc_hpcon console);

#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
/* ProcThreadAttributeValue(22, FALSE, TRUE, FALSE) from newer WinBase.h. */
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE ((DWORD_PTR)22 | 0x00020000)
#endif

static int conpty_state = -1; /* -1 unknown, 0 unavailable, 1 available */
static create_pseudo_console_fn conpty_create;
static resize_pseudo_console_fn conpty_resize;
static close_pseudo_console_fn conpty_close;

static void conpty_resolve(void) {
    HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
    if (kernel) {
        conpty_create = (create_pseudo_console_fn)(void *)GetProcAddress(kernel, "CreatePseudoConsole");
        conpty_resize = (resize_pseudo_console_fn)(void *)GetProcAddress(kernel, "ResizePseudoConsole");
        conpty_close = (close_pseudo_console_fn)(void *)GetProcAddress(kernel, "ClosePseudoConsole");
    }
    conpty_state = (conpty_create && conpty_resize && conpty_close) ? 1 : 0;
}

int owc_pty_supported(void) {
    if (conpty_state < 0) conpty_resolve();
    return conpty_state;
}

struct owc_pty {
    owc_hpcon console;
    HANDLE input_write;   /* our end: keyboard input into the console */
    HANDLE output_read;   /* our end: console output */
    HANDLE process;
    HANDLE process_thread;
    HANDLE job;
    HANDLE reader;        /* reader thread handle */
    CRITICAL_SECTION lock; /* guards closing/input_write/resize */
    int closing;
    int exited;
    int exit_code;
    owc_pty_output_fn on_output;
    owc_pty_exit_fn on_exit;
    void *user_data;
    owc_sandbox *sandbox; /* retained for the PTY lifetime: destroy revokes ACL grants */
};

static volatile LONG pty_run_counter = 0;

static wchar_t *utf8_to_wide(const char *value) {
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, NULL, 0);
    wchar_t *wide;
    if (!length) return NULL;
    wide = (wchar_t *)malloc((size_t)length * sizeof(*wide));
    if (!wide || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, wide, length)) { free(wide); return NULL; }
    return wide;
}

static char *normalize_path(const char *value) {
    wchar_t *wide = utf8_to_wide(value), *full = NULL;
    char *utf8 = NULL;
    DWORD wide_length;
    int utf8_length;
    size_t length;
    if (!wide) return NULL;
    wide_length = GetFullPathNameW(wide, 0, NULL, NULL);
    if (!wide_length) goto cleanup;
    full = (wchar_t *)malloc((size_t)wide_length * sizeof(*full));
    if (!full || !GetFullPathNameW(wide, wide_length, full, NULL)) goto cleanup;
    length = wcslen(full);
    while (length > 3 && (full[length - 1] == L'\\' || full[length - 1] == L'/')) full[--length] = L'\0';
    utf8_length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, full, -1, NULL, 0, NULL, NULL);
    if (!utf8_length) goto cleanup;
    utf8 = (char *)malloc((size_t)utf8_length);
    if (!utf8 || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, full, -1, utf8, utf8_length, NULL, NULL)) { free(utf8); utf8 = NULL; }
cleanup:
    free(wide); free(full); return utf8;
}

static int add_write_root(char **roots, size_t *count, size_t capacity, const char *path) {
    char *normalized;
    size_t i;
    if (*count >= capacity) return 0;
    normalized = normalize_path(path);
    if (!normalized) return 0;
    for (i = 0; i < *count; i++) if (_stricmp(roots[i], normalized) == 0) { free(normalized); return 1; }
    roots[(*count)++] = normalized;
    return 1;
}

/* Filtered-network sessions route child traffic through the in-sandbox proxy
 * sidecar: inherited proxy variables are stripped and HTTP_PROXY/HTTPS_PROXY
 * (both casings) point at the sidecar with NO_PROXY emptied.  Same
 * environment-block construction as exec_win.c build_child_environment,
 * without the pwsh profile redirection a PTY does not need.  Returns NULL to
 * fall back to inheriting the parent environment. */
static wchar_t *build_proxy_environment(const wchar_t *proxy_addr) {
    static const wchar_t *const proxy_names[6] = {
        L"HTTP_PROXY=http://", L"HTTPS_PROXY=http://", L"NO_PROXY=",
        L"http_proxy=http://", L"https_proxy=http://", L"no_proxy="
    };
    LPWCH parent, entry;
    wchar_t *block, *dst;
    size_t total = 1, length, proxy_length = wcslen(proxy_addr), name_index;
    parent = GetEnvironmentStringsW();
    if (!parent) return NULL;
    for (entry = parent; *entry; entry += wcslen(entry) + 1) {
        if (_wcsnicmp(entry, L"HTTP_PROXY=", 11) == 0) continue;
        if (_wcsnicmp(entry, L"HTTPS_PROXY=", 12) == 0) continue;
        if (_wcsnicmp(entry, L"NO_PROXY=", 9) == 0) continue;
        total += wcslen(entry) + 1;
    }
    total += 2 * (18 + proxy_length + 1 + 19 + proxy_length + 1 + 9 + 1);
    block = (wchar_t *)malloc(total * sizeof(*block));
    if (!block) { FreeEnvironmentStringsW(parent); return NULL; }
    dst = block;
    for (entry = parent; *entry; entry += length + 1) {
        length = wcslen(entry);
        if (_wcsnicmp(entry, L"HTTP_PROXY=", 11) == 0) continue;
        if (_wcsnicmp(entry, L"HTTPS_PROXY=", 12) == 0) continue;
        if (_wcsnicmp(entry, L"NO_PROXY=", 9) == 0) continue;
        (void)memcpy(dst, entry, (length + 1) * sizeof(*dst));
        dst += length + 1;
    }
    for (name_index = 0; name_index < 6; ++name_index) {
        length = wcslen(proxy_names[name_index]);
        (void)memcpy(dst, proxy_names[name_index], length * sizeof(*dst)); dst += length;
        if (name_index != 2 && name_index != 5) {
            (void)memcpy(dst, proxy_addr, proxy_length * sizeof(*dst));
            dst += proxy_length;
        }
        *dst++ = L'\0';
    }
    *dst = L'\0';
    FreeEnvironmentStringsW(parent);
    return block;
}

/* Poll model mirrors exec_win.c drain_pipe: PeekNamedPipe for available
 * console output, WaitForSingleObject on the child for exit.  After the
 * child exits, trailing console output is drained briefly before the exit
 * callback fires. */
static DWORD WINAPI pty_reader(void *value) {
    owc_pty *pty = (owc_pty *)value;
    unsigned char buffer[16384];
    DWORD code = 0;
    int closing;
    for (;;) {
        DWORD available = 0, read_count = 0, wait_result;
        if (!PeekNamedPipe(pty->output_read, NULL, 0, NULL, &available, NULL)) break;
        if (available) {
            DWORD wanted = available > (DWORD)sizeof(buffer) ? (DWORD)sizeof(buffer) : available;
            if (!ReadFile(pty->output_read, buffer, wanted, &read_count, NULL) || !read_count) break;
            if (pty->on_output) pty->on_output(pty->user_data, buffer, read_count);
            continue;
        }
        wait_result = WaitForSingleObject(pty->process, 20);
        if (wait_result == WAIT_FAILED) break;
        if (wait_result == WAIT_OBJECT_0) {
            int idle = 0;
            for (;;) {
                if (!PeekNamedPipe(pty->output_read, NULL, 0, NULL, &available, NULL)) break;
                if (!available) { if (++idle >= 10) break; Sleep(20); continue; }
                idle = 0;
                {
                    DWORD wanted = available > (DWORD)sizeof(buffer) ? (DWORD)sizeof(buffer) : available;
                    if (!ReadFile(pty->output_read, buffer, wanted, &read_count, NULL) || !read_count) break;
                    if (pty->on_output) pty->on_output(pty->user_data, buffer, read_count);
                }
            }
            break;
        }
    }
    if (WaitForSingleObject(pty->process, 5000) != WAIT_OBJECT_0 || !GetExitCodeProcess(pty->process, &code)) code = 0;
    EnterCriticalSection(&pty->lock);
    pty->exited = 1;
    pty->exit_code = (int)code;
    closing = pty->closing;
    LeaveCriticalSection(&pty->lock);
    if (!closing && pty->on_exit) pty->on_exit(pty->user_data, (int)code);
    return 0;
}

static void close_handle(HANDLE *handle) {
    if (*handle) { CloseHandle(*handle); *handle = NULL; }
}

int owc_pty_open(const owc_pty_options *options,
                 owc_pty_output_fn on_output, owc_pty_exit_fn on_exit,
                 void *user_data, owc_pty **result,
                 owc_pty_open_result *open_result, unsigned long *system_error) {
    HANDLE input_read = NULL, output_write = NULL, nul = NULL;
    SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
    owc_pty *pty = NULL;
    STARTUPINFOEXW startup;
    PROCESS_INFORMATION process;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    SIZE_T attribute_size = 0;
    wchar_t *cwd = NULL, *command = NULL, *shell = NULL, *env_block = NULL;
    wchar_t default_shell[MAX_PATH];
    owc_sandbox_options sandbox_options;
    char sandbox_identity[96];
    char *write_roots[17] = {0};
    size_t write_root_count = 0, write_root_index;
    COORD size;
    int appcontainer = 0, ok = 0;
    HRESULT hr;

    memset(&startup, 0, sizeof(startup));
    memset(&process, 0, sizeof(process));
    memset(&limits, 0, sizeof(limits));
    memset(&sandbox_options, 0, sizeof(sandbox_options));
    memset(open_result, 0, sizeof(*open_result));
    *result = NULL;
    if (!options || !options->cwd || !options->session_id || !options->session_id[0]
        || options->cols < 1 || options->cols > (int)OWC_PTY_MAX_COLS
        || options->rows < 1 || options->rows > (int)OWC_PTY_MAX_ROWS) {
        *system_error = ERROR_INVALID_PARAMETER;
        return 0;
    }
    if (!owc_pty_supported()) {
        *system_error = ERROR_CALL_NOT_IMPLEMENTED;
        return 0;
    }
    pty = (owc_pty *)calloc(1, sizeof(*pty));
    if (!pty) { *system_error = ERROR_OUTOFMEMORY; return 0; }
    InitializeCriticalSection(&pty->lock);
    pty->on_output = on_output;
    pty->on_exit = on_exit;
    pty->user_data = user_data;

    if (!CreatePipe(&input_read, &pty->input_write, NULL, 0)
        || !CreatePipe(&pty->output_read, &output_write, NULL, 0)) goto cleanup;
    size.X = (SHORT)options->cols;
    size.Y = (SHORT)options->rows;
    hr = conpty_create(size, input_read, output_write, 0, &pty->console);
    if (FAILED(hr)) goto cleanup;

    if (options->shell) {
        shell = utf8_to_wide(options->shell);
        if (!shell) goto cleanup;
    } else {
        DWORD length = GetSystemDirectoryW(default_shell, (UINT)ARRAYSIZE(default_shell));
        if (!length || length >= ARRAYSIZE(default_shell) - 8) goto cleanup;
        if (wcscat_s(default_shell, ARRAYSIZE(default_shell), L"\\cmd.exe") != 0) goto cleanup;
        shell = default_shell;
    }
    {
        size_t shell_length = wcslen(shell);
        command = (wchar_t *)malloc((shell_length + 3) * sizeof(*command));
        if (!command) goto cleanup;
        command[0] = L'"';
        memcpy(command + 1, shell, shell_length * sizeof(*command));
        command[shell_length + 1] = L'"';
        command[shell_length + 2] = L'\0';
    }
    cwd = utf8_to_wide(options->cwd);
    if (!cwd) goto cleanup;

    if (options->sandbox && options->sandbox_mode == (int)OWC_SANDBOX_MODE_JOBOBJECT) {
        /* Session explicitly asked for compatibility mode: skip the
         * AppContainer profile, keep only the Job Object below. */
        open_result->sandbox_status = (int)OWC_SANDBOX_PARTIAL;
        (void)snprintf(open_result->sandbox_reason, sizeof(open_result->sandbox_reason),
                       "Job Object compatibility mode requested by session policy");
    } else if (options->sandbox) {
        wchar_t *proxy_wide = NULL;
        if (options->network_filtered) {
            /* Filtered-network session: share the fixed session profile with
               the in-sandbox proxy sidecar; the session grant owns the
               profile and ACLs. */
            sandbox_options.session_id = options->session_id;
            sandbox_options.shared_profile = 1;
        } else {
            (void)snprintf(sandbox_identity, sizeof(sandbox_identity), "Pty.%lu.%llu.%ld",
                           (unsigned long)GetCurrentProcessId(),
                           (unsigned long long)GetTickCount64(),
                           (long)InterlockedIncrement(&pty_run_counter));
            sandbox_options.session_id = sandbox_identity;
        }
        sandbox_options.allow_network = options->allow_network;
        sandbox_options.private_network = options->allow_network && options->network_filtered;
        sandbox_options.read_only_paths = options->read_only_paths;
        sandbox_options.read_only_count = options->read_only_count;
        if (options->allow_path_count > 16
            || !add_write_root(write_roots, &write_root_count, ARRAYSIZE(write_roots), options->cwd)) goto cleanup;
        for (write_root_index = 0; write_root_index < options->allow_path_count; write_root_index++)
            if (!add_write_root(write_roots, &write_root_count, ARRAYSIZE(write_roots), options->allow_paths[write_root_index])) goto cleanup;
        sandbox_options.write_roots = (const char *const *)write_roots;
        sandbox_options.write_root_count = write_root_count;
        sandbox_options.bind_backing = options->bind_backing;
        sandbox_options.bind_read_only = options->bind_read_only;
        sandbox_options.bind_count = options->bind_count;
        pty->sandbox = owc_sandbox_create(&sandbox_options, open_result->sandbox_reason, sizeof(open_result->sandbox_reason));
        open_result->sandbox_status = pty->sandbox
            ? (int)owc_sandbox_get_status(pty->sandbox) : (int)OWC_SANDBOX_ADVISORY;
        if (pty->sandbox && options->network_filtered)
            (void)snprintf(open_result->sandbox_reason, sizeof(open_result->sandbox_reason),
                           options->allow_network
                               ? "AppContainer enforced; network allowed by per-exec override (filtered session sidecar)"
                               : "AppContainer enforced; network filtered via in-sandbox proxy");
        /* Same rule as exec: only the capability-less business execution of
           a filtered session gets the proxy environment. */
        if (pty->sandbox && options->network_filtered && options->proxy_addr
            && options->proxy_addr[0] && !options->allow_network) {
            proxy_wide = utf8_to_wide(options->proxy_addr);
            if (proxy_wide) {
                env_block = build_proxy_environment(proxy_wide);
                free(proxy_wide);
            }
        }
    } else {
        open_result->sandbox_status = (int)OWC_SANDBOX_ADVISORY;
        (void)snprintf(open_result->sandbox_reason, sizeof(open_result->sandbox_reason),
                       "sandbox disabled by session policy");
    }

    (void)InitializeProcThreadAttributeList(NULL, pty->sandbox ? 2 : 1, 0, &attribute_size);
    if (!attribute_size) goto cleanup;
    attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attribute_size);
    if (!attributes || !InitializeProcThreadAttributeList(attributes, pty->sandbox ? 2 : 1, 0, &attribute_size)) goto cleanup;
    startup.lpAttributeList = attributes;
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                   pty->console, sizeof(pty->console), NULL, NULL)) goto cleanup;
    if (pty->sandbox) {
        if (!owc_sandbox_add_process_attribute(pty->sandbox, attributes,
                                               open_result->sandbox_reason, sizeof(open_result->sandbox_reason))) {
            owc_sandbox_destroy(pty->sandbox); pty->sandbox = NULL;
            open_result->sandbox_status = (int)OWC_SANDBOX_PARTIAL;
        } else appcontainer = 1;
    }

    startup.StartupInfo.cb = sizeof(startup);
    /* The pseudoconsole overrides these once the client attaches, but a
     * client created without STARTF_USESTDHANDLES falls back to the
     * parent's std handles and leaks early console output (cmd banner)
     * straight into the RPC stream.  Point them at NUL instead. */
    nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                      &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (nul == INVALID_HANDLE_VALUE) { nul = NULL; goto cleanup; }
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nul;
    startup.StartupInfo.hStdOutput = nul;
    startup.StartupInfo.hStdError = nul;
    if (!CreateProcessW(NULL, command, NULL, NULL, FALSE,
                        CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | (env_block ? CREATE_UNICODE_ENVIRONMENT : 0),
                        env_block, cwd, &startup.StartupInfo, &process)) {
        DWORD creation_error = GetLastError();
        if (!pty->sandbox) goto cleanup;
        /* AppContainer x ConPTY has known compatibility failures on some
         * builds: degrade honestly to the Job Object compatibility mode,
         * same fallback precedent as exec_win.c. */
        owc_sandbox_destroy(pty->sandbox); pty->sandbox = NULL; appcontainer = 0;
        open_result->sandbox_status = (int)OWC_SANDBOX_PARTIAL;
        (void)snprintf(open_result->sandbox_reason, sizeof(open_result->sandbox_reason),
                       "AppContainer PTY process creation failed (%lu); using Job Object compatibility mode",
                       (unsigned long)creation_error);
        DeleteProcThreadAttributeList(attributes); free(attributes); attributes = NULL; attribute_size = 0;
        (void)InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
        if (!attribute_size) goto cleanup;
        attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attribute_size);
        if (!attributes || !InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size)) goto cleanup;
        startup.lpAttributeList = attributes;
        if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                       pty->console, sizeof(pty->console), NULL, NULL)) goto cleanup;
        if (!CreateProcessW(NULL, command, NULL, NULL, FALSE,
                            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                            NULL, cwd, &startup.StartupInfo, &process)) goto cleanup;
    }
    pty->process = process.hProcess;
    pty->process_thread = process.hThread;
    if (pty->sandbox) open_result->sandbox_status = (int)owc_sandbox_get_status(pty->sandbox);
    /* ConPTY was given these ends and the client is attached now; our
     * copies are closed only after CreateProcess (sample order). */
    CloseHandle(input_read); input_read = NULL;
    CloseHandle(output_write); output_write = NULL;
    CloseHandle(nul); nul = NULL;

    pty->job = CreateJobObjectW(NULL, NULL);
    if (!pty->job) goto cleanup;
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (options->sandbox && !appcontainer) {
        /* Job Object is the only enforcement in these paths (explicit
         * jobobject mode, AppContainer fallback, or no profile): apply
         * resource limits, same rule as exec_win.c. */
        limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.JobMemoryLimit = (SIZE_T)(options->job_memory_mb ? options->job_memory_mb : OWC_JOB_DEFAULT_MEMORY_MB) * 1024 * 1024;
        limits.BasicLimitInformation.ActiveProcessLimit = (DWORD)(options->job_max_processes ? options->job_max_processes : OWC_JOB_DEFAULT_MAX_PROCESSES);
    }
    if (!SetInformationJobObject(pty->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))
        || !AssignProcessToJobObject(pty->job, pty->process)) {
        /* A requested sandbox that failed to obtain AppContainer enforcement
         * must not be weakened; otherwise the Job Object is lifecycle-only. */
        if (options->sandbox && !appcontainer) goto cleanup;
        close_handle(&pty->job);
    }
    if (ResumeThread(pty->process_thread) == (DWORD)-1) goto cleanup;

    pty->reader = CreateThread(NULL, 0, pty_reader, pty, 0, NULL);
    if (!pty->reader) goto cleanup;
    *result = pty;
    ok = 1;

cleanup:
    if (!ok) {
        *system_error = (unsigned long)GetLastError();
        if (pty && process.hProcess) {
            if (pty->job) (void)TerminateJobObject(pty->job, 1);
            else (void)TerminateProcess(process.hProcess, 1);
            (void)WaitForSingleObject(process.hProcess, 2000);
        }
    }
    if (pty && !ok) {
        if (pty->reader) CloseHandle(pty->reader);
        if (pty->console) conpty_close(pty->console);
        if (pty->input_write) CloseHandle(pty->input_write);
        if (pty->output_read) CloseHandle(pty->output_read);
        if (pty->job) CloseHandle(pty->job);
        owc_sandbox_destroy(pty->sandbox);
        DeleteCriticalSection(&pty->lock);
        free(pty);
    }
    if (!ok) {
        if (process.hThread) CloseHandle(process.hThread);
        if (process.hProcess) CloseHandle(process.hProcess);
    }
    if (input_read) CloseHandle(input_read);
    if (output_write) CloseHandle(output_write);
    if (nul) CloseHandle(nul);
    if (attributes) DeleteProcThreadAttributeList(attributes);
    free(attributes);
    for (write_root_index = 0; write_root_index < write_root_count; write_root_index++) free(write_roots[write_root_index]);
    free(cwd);
    free(command);
    free(env_block);
    if (shell && shell != default_shell) free(shell);
    return ok;
}

int owc_pty_write(owc_pty *pty, const unsigned char *data, size_t length) {
    size_t written = 0;
    int ok = 1;
    if (!pty || (!data && length)) return 0;
    EnterCriticalSection(&pty->lock);
    if (pty->closing || pty->exited) { LeaveCriticalSection(&pty->lock); return 0; }
    while (written < length) {
        DWORD count = 0;
        DWORD wanted = length - written > 65536 ? 65536 : (DWORD)(length - written);
        if (!WriteFile(pty->input_write, data + written, wanted, &count, NULL)) { ok = 0; break; }
        written += count;
    }
    LeaveCriticalSection(&pty->lock);
    return ok;
}

int owc_pty_resize(owc_pty *pty, int cols, int rows) {
    COORD size;
    HRESULT hr;
    if (!pty || cols < 1 || cols > (int)OWC_PTY_MAX_COLS || rows < 1 || rows > (int)OWC_PTY_MAX_ROWS) return 0;
    size.X = (SHORT)cols;
    size.Y = (SHORT)rows;
    EnterCriticalSection(&pty->lock);
    if (pty->closing || pty->exited) { LeaveCriticalSection(&pty->lock); return 0; }
    hr = conpty_resize(pty->console, size);
    LeaveCriticalSection(&pty->lock);
    return SUCCEEDED(hr);
}

void owc_pty_close(owc_pty *pty) {
    int exited;
    if (!pty) return;
    EnterCriticalSection(&pty->lock);
    pty->closing = 1;
    exited = pty->exited;
    LeaveCriticalSection(&pty->lock);
    if (!exited) {
        /* Process-tree kill is the lifecycle guarantee on both channels
         * (sandbox true/false); the reader thread observes the death and
         * exits without firing the exit callback (closing is set). */
        if (pty->job) (void)TerminateJobObject(pty->job, 1);
        else if (pty->process) (void)TerminateProcess(pty->process, 1);
    }
    if (pty->reader) {
        (void)WaitForSingleObject(pty->reader, 10000);
        CloseHandle(pty->reader);
    }
    if (pty->console) conpty_close(pty->console);
    if (pty->input_write) CloseHandle(pty->input_write);
    if (pty->output_read) CloseHandle(pty->output_read);
    if (pty->process_thread) CloseHandle(pty->process_thread);
    if (pty->process) CloseHandle(pty->process);
    if (pty->job) CloseHandle(pty->job);
    owc_sandbox_destroy(pty->sandbox);
    DeleteCriticalSection(&pty->lock);
    free(pty);
}

void owc_pty_terminate_all(void) {
    /* Windows: every PTY child tree sits in a Job Object with
     * KILL_ON_JOB_CLOSE, so core exit closes the handles and the kernel
     * tears the trees down. Nothing to do here. */
}
