#include "exec_platform.h"
#include "sandbox.h"

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static volatile LONG sandbox_run_counter = 0;

static wchar_t *utf8_to_wide(const char *value) {
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, NULL, 0);
    wchar_t *wide;
    if (!length) return NULL;
    wide=(wchar_t *)malloc((size_t)length*sizeof(*wide));
    if (!wide || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, wide, length)) { free(wide); return NULL; }
    return wide;
}

static char *normalize_path(const char *value) {
    wchar_t *wide=utf8_to_wide(value),*full=NULL;
    char *utf8=NULL;
    DWORD wide_length;
    int utf8_length;
    size_t length;
    if(!wide)return NULL;
    wide_length=GetFullPathNameW(wide,0,NULL,NULL);
    if(!wide_length)goto cleanup;
    full=(wchar_t *)malloc((size_t)wide_length*sizeof(*full));
    if(!full||!GetFullPathNameW(wide,wide_length,full,NULL))goto cleanup;
    length=wcslen(full);
    while(length>3&&(full[length-1]==L'\\'||full[length-1]==L'/'))full[--length]=L'\0';
    utf8_length=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,full,-1,NULL,0,NULL,NULL);
    if(!utf8_length)goto cleanup;
    utf8=(char *)malloc((size_t)utf8_length);
    if(!utf8||!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,full,-1,utf8,utf8_length,NULL,NULL)){free(utf8);utf8=NULL;}
cleanup:
    free(wide);free(full);return utf8;
}

/* Grows on demand (initial 8, doubling); the RPC layer caps allowPaths at
   32 plus cwd, so growth past that means a caller bug, not a quota.  On
   failure the Win32 last-error is set so the caller can report a specific
   system error instead of a generic cleanup failure. */
static int add_write_root(char ***roots,size_t *count,size_t *capacity,const char *path) {
    char *normalized;
    size_t i;
    normalized=normalize_path(path);
    if(!normalized){if(!GetLastError())SetLastError(ERROR_INVALID_PARAMETER);return 0;}
    for(i=0;i<*count;i++)if(_stricmp((*roots)[i],normalized)==0){free(normalized);return 1;}
    if(*count==*capacity){
        size_t grown_capacity=*capacity?*capacity*2:8;
        char **grown=(char **)realloc(*roots,grown_capacity*sizeof(*grown));
        if(!grown){free(normalized);SetLastError(ERROR_OUTOFMEMORY);return 0;}
        *roots=grown;*capacity=grown_capacity;
    }
    (*roots)[(*count)++]=normalized;
    return 1;
}

static void drain_pipe(HANDLE pipe, const char *stream, const owc_exec_request *request,
                       owc_exec_result *result, size_t *forwarded, unsigned *sequence) {
    DWORD available=0, read_count;
    unsigned char data[4096];
    while (PeekNamedPipe(pipe,NULL,0,NULL,&available,NULL) && available) {
        DWORD wanted=available>sizeof(data)?(DWORD)sizeof(data):available;
        if (!ReadFile(pipe,data,wanted,&read_count,NULL) || !read_count) break;
        {
            size_t emit=(size_t)read_count;
            if (*forwarded>=request->output_limit) emit=0;
            else if(emit>request->output_limit-*forwarded) emit=request->output_limit-*forwarded;
            if(emit && request->on_output) request->on_output(request->user_data,stream,data,emit,(*sequence)++);
            *forwarded+=emit; if(emit<(size_t)read_count) result->truncated=1;
        }
    }
}

/* Command-line argument style of the selected interpreter. */
#define OWC_SHELL_ARGS_CMD 0
#define OWC_SHELL_ARGS_PWSH 1
#define OWC_SHELL_ARGS_BASH 2

static int select_shell(wchar_t *path, size_t count, int shell_backend,
                        const char *explicit_path, int *arg_style) {
    DWORD length;
    if (explicit_path && explicit_path[0]) {
        /* Explicit executable from the host detection layer (e.g. a Git Bash
           absolute path): use as-is, the argument style follows the backend. */
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, explicit_path, -1, path, (int)count) <= 0) {
            SetLastError(ERROR_FILE_NOT_FOUND);
            return 0;
        }
        *arg_style = shell_backend == (int)OWC_SHELL_PWSH ? OWC_SHELL_ARGS_PWSH
            : shell_backend == (int)OWC_SHELL_BASH ? OWC_SHELL_ARGS_BASH : OWC_SHELL_ARGS_CMD;
        return 1;
    }
    if (shell_backend == (int)OWC_SHELL_PWSH) {
        length = SearchPathW(NULL, L"pwsh.exe", NULL, (DWORD)count, path, NULL);
        if (length > 0 && length < count) {
            *arg_style = OWC_SHELL_ARGS_PWSH;
            return 1;
        }
        SetLastError(ERROR_FILE_NOT_FOUND);
        return 0;
    }
    if (shell_backend == (int)OWC_SHELL_BASH) {
        wchar_t system_dir[MAX_PATH];
        size_t system_dir_length;
        length = SearchPathW(NULL, L"bash.exe", NULL, (DWORD)count, path, NULL);
        if (length > 0 && length < count) {
            /* System32ash.exe is the WSL launcher, not Git/MSYS bash. */
            system_dir_length = GetSystemDirectoryW(system_dir, (UINT)ARRAYSIZE(system_dir));
            if (system_dir_length && _wcsnicmp(path, system_dir, system_dir_length) == 0) {
                SetLastError(ERROR_FILE_NOT_FOUND);
                return 0;
            }
            *arg_style = OWC_SHELL_ARGS_BASH;
            return 1;
        }
        SetLastError(ERROR_FILE_NOT_FOUND);
        return 0;
    }
    length = GetSystemDirectoryW(path, (UINT)count);
    if (!length || length >= count - 8) return 0;
    if (wcscat_s(path, count, L"\\cmd.exe") != 0) return 0;
    *arg_style = OWC_SHELL_ARGS_CMD;
    return 1;
}

/* AppContainer access is granted to the workspace and, best-effort, as
 * traverse/read-attributes ACEs on its ancestors. Keep process creation on the host
 * token: mixing a linked medium token with SECURITY_CAPABILITIES can leave
 * shells stalled during initialization on split-token Windows accounts. */
static char *build_shell_command(const wchar_t *shell_path, const char *arguments,
                                 const char *cwd, const char *user_command, int arg_style) {
    /* Under AppContainer, pwsh's FileSystem provider init fails (the profile
       home is not granted) and its location falls back to C:\; and even a
       plain Set-Location fails when an ancestor directory is not readable by
       the AppContainer SID (provider resolution stats every component, and a
       non-elevated core cannot grant DACLs it does not own).  Fall back to a
       PSDrive rooted at the cwd: drive roots open by full path, which only
       needs traverse on ancestors. */
    const char *src;
    char *escaped, *dst, *full;
    size_t extra = 0, n;
    int length;
    if (arg_style == OWC_SHELL_ARGS_CMD) {
        length = snprintf(NULL, 0, "\"%ls\" %s \"%s\"", shell_path, arguments, user_command);
        if (length < 0) return NULL;
        full = (char *)malloc((size_t)length + 1);
        if (full) (void)snprintf(full, (size_t)length + 1, "\"%ls\" %s \"%s\"", shell_path, arguments, user_command);
        return full;
    }
    if (arg_style == OWC_SHELL_ARGS_BASH) {
        /* MSYS/CRT command-line decoding inside the wrapped "..." argument:
           backslashes and quotes must be escaped so the shell receives the
           command text byte-for-byte. */
        for (src = user_command; *src; src++) if (*src == '\\' || *src == '"') extra++;
        escaped = (char *)malloc(strlen(user_command) + extra + 1);
        if (!escaped) return NULL;
        dst = escaped;
        for (src = user_command; *src; src++) { if (*src == '\\' || *src == '"') *dst++ = '\\'; *dst++ = *src; }
        *dst = '\0';
        length = snprintf(NULL, 0, "\"%ls\" %s \"%s\"", shell_path, arguments, escaped);
        if (length >= 0) {
            full = (char *)malloc((size_t)length + 1);
            if (full) (void)snprintf(full, (size_t)length + 1, "\"%ls\" %s \"%s\"", shell_path, arguments, escaped);
        } else full = NULL;
        free(escaped);
        return full;
    }
    for (src = cwd; *src; src++) if (*src == '\'') extra++;
    n = (size_t)(src - cwd);
    escaped = (char *)malloc(n + extra + 1);
    if (!escaped) return NULL;
    dst = escaped;
    for (src = cwd; *src; src++) { if (*src == '\'') *dst++ = '\''; *dst++ = *src; }
    *dst = '\0';
    length = snprintf(NULL, 0, "\"%ls\" %s try { Set-Location -LiteralPath '%s' -ErrorAction Stop } catch { New-PSDrive -Name OWC -PSProvider FileSystem -Root '%s' | Out-Null; Set-Location OWC: }; %s", shell_path, arguments, escaped, escaped, user_command);
    if (length >= 0) {
        full = (char *)malloc((size_t)length + 1);
        if (full) (void)snprintf(full, (size_t)length + 1, "\"%ls\" %s try { Set-Location -LiteralPath '%s' -ErrorAction Stop } catch { New-PSDrive -Name OWC -PSProvider FileSystem -Root '%s' | Out-Null; Set-Location OWC: }; %s", shell_path, arguments, escaped, escaped, user_command);
    } else full = NULL;
    free(escaped);
    return full;
}

/* Under AppContainer the real user profile is not granted, so pwsh fails its
   FileSystem InitializeDefaultDrives at engine start and prints a spurious
   error to stderr on every command (agents then mistake it for a failed
   command and retry). Redirect the profile variables into the workspace,
   which the AppContainer profile always grants.
   Filtered-network sessions additionally route child traffic through the
   in-sandbox proxy sidecar: inherited proxy variables are stripped and
   HTTP_PROXY/HTTPS_PROXY (both casings) point at the sidecar with NO_PROXY
   emptied.  Returns NULL to fall back to inheriting the parent
   environment. */
static wchar_t *build_child_environment(const wchar_t *cwd, const wchar_t *proxy_addr) {
    LPWCH parent, entry;
    wchar_t *block, *dst;
    size_t total = 1, length, proxy_length = proxy_addr ? wcslen(proxy_addr) : 0;
    parent = GetEnvironmentStringsW();
    if (!parent) return NULL;
    for (entry = parent; *entry; entry += wcslen(entry) + 1) {
        if (cwd && _wcsnicmp(entry, L"USERPROFILE=", 12) == 0) continue;
        if (cwd && _wcsnicmp(entry, L"HOME=", 5) == 0) continue;
        if (proxy_addr && _wcsnicmp(entry, L"HTTP_PROXY=", 11) == 0) continue;
        if (proxy_addr && _wcsnicmp(entry, L"HTTPS_PROXY=", 12) == 0) continue;
        if (proxy_addr && _wcsnicmp(entry, L"NO_PROXY=", 9) == 0) continue;
        total += wcslen(entry) + 1;
    }
    if (cwd) total += 12 + wcslen(cwd) + 1 + 5 + wcslen(cwd) + 1;
    if (proxy_addr) {
        /* "HTTP_PROXY=http://" (18) + "HTTPS_PROXY=http://" (19) +
           "NO_PROXY=" (9) plus the same three names in lowercase, each with
           its terminator. */
        total += 18 + proxy_length + 1 + 19 + proxy_length + 1 + 9 + 1;
        total += 18 + proxy_length + 1 + 19 + proxy_length + 1 + 9 + 1;
    }
    block = (wchar_t *)malloc(total * sizeof(*block));
    if (!block) { FreeEnvironmentStringsW(parent); return NULL; }
    dst = block;
    for (entry = parent; *entry; entry += length + 1) {
        length = wcslen(entry);
        if (cwd && _wcsnicmp(entry, L"USERPROFILE=", 12) == 0) continue;
        if (cwd && _wcsnicmp(entry, L"HOME=", 5) == 0) continue;
        if (proxy_addr && _wcsnicmp(entry, L"HTTP_PROXY=", 11) == 0) continue;
        if (proxy_addr && _wcsnicmp(entry, L"HTTPS_PROXY=", 12) == 0) continue;
        if (proxy_addr && _wcsnicmp(entry, L"NO_PROXY=", 9) == 0) continue;
        (void)memcpy(dst, entry, (length + 1) * sizeof(*dst));
        dst += length + 1;
    }
    if (cwd) {
        (void)memcpy(dst, L"USERPROFILE=", 12 * sizeof(*dst)); dst += 12;
        length = wcslen(cwd);
        (void)memcpy(dst, cwd, length * sizeof(*dst)); dst += length;
        *dst++ = L'\0';
        (void)memcpy(dst, L"HOME=", 5 * sizeof(*dst)); dst += 5;
        (void)memcpy(dst, cwd, length * sizeof(*dst)); dst += length;
        *dst++ = L'\0';
    }
    if (proxy_addr) {
        static const wchar_t *const proxy_names[6] = {
            L"HTTP_PROXY=http://", L"HTTPS_PROXY=http://", L"NO_PROXY=",
            L"http_proxy=http://", L"https_proxy=http://", L"no_proxy="
        };
        size_t name_index;
        for (name_index = 0; name_index < 6; ++name_index) {
            length = wcslen(proxy_names[name_index]);
            (void)memcpy(dst, proxy_names[name_index], length * sizeof(*dst)); dst += length;
            if (name_index != 2 && name_index != 5) {
                (void)memcpy(dst, proxy_addr, proxy_length * sizeof(*dst));
                dst += proxy_length;
            }
            *dst++ = L'\0';
        }
    }
    *dst = L'\0';
    FreeEnvironmentStringsW(parent);
    return block;
}

int owc_platform_exec_run(const owc_exec_request *request, owc_exec_result *result) {
    SECURITY_ATTRIBUTES security={sizeof(security),NULL,TRUE};
    HANDLE out_read=NULL,out_write=NULL,err_read=NULL,err_write=NULL,input=NULL,job=NULL;
    HANDLE inherited[3];
    PROCESS_INFORMATION process={0}; STARTUPINFOEXW startup={0};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
    LPPROC_THREAD_ATTRIBUTE_LIST attributes=NULL;
    SIZE_T attribute_size=0;
    wchar_t *cwd=NULL,*command=NULL,*env_block=NULL; wchar_t shell_path[MAX_PATH]; char *full_command=NULL;
    owc_sandbox *sandbox=NULL; owc_sandbox_options sandbox_options={0};
    char sandbox_identity[96];
    char **write_roots=NULL; size_t write_root_count=0,write_root_capacity=0,write_root_index;
    ULONGLONG started=GetTickCount64(); size_t forwarded=0; unsigned sequence=0;
    DWORD wait_result,exit_code=1; int ok=0,arg_style=0;

    if(!CreatePipe(&out_read,&out_write,&security,0) || !CreatePipe(&err_read,&err_write,&security,0)) goto cleanup;
    if(!SetHandleInformation(out_read,HANDLE_FLAG_INHERIT,0) || !SetHandleInformation(err_read,HANDLE_FLAG_INHERIT,0)) goto cleanup;
    input=CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    if(input==INVALID_HANDLE_VALUE) { input=NULL; goto cleanup; }
    cwd=utf8_to_wide(request->cwd);
    {
        const char *arguments;
        if(!select_shell(shell_path,ARRAYSIZE(shell_path),request->shell_backend,request->shell_path,&arg_style)){if(request->shell_backend==(int)OWC_SHELL_PWSH||request->shell_backend==(int)OWC_SHELL_BASH)result->shell_unavailable=1;goto cleanup;}
        arguments=arg_style==OWC_SHELL_ARGS_PWSH?"-NoLogo -NoProfile -NonInteractive -Command":arg_style==OWC_SHELL_ARGS_BASH?"-c":"/d /s /c";
        full_command=build_shell_command(shell_path,arguments,request->cwd,request->command,arg_style);
        if(!full_command) goto cleanup;
    }
    if(!cwd) goto cleanup;
    command=utf8_to_wide(full_command); if(!command) goto cleanup;

    startup.StartupInfo.cb=sizeof(startup); startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdOutput=out_write; startup.StartupInfo.hStdError=err_write; startup.StartupInfo.hStdInput=input;
    inherited[0]=out_write; inherited[1]=err_write; inherited[2]=input;
    if(request->network_filtered) {
        /* Filtered-network session: share the fixed session profile
           (OpenWebCode.<session-id>) with the in-sandbox proxy sidecar so
           same-package loopback reaches it; profile and ACLs are owned by
           the session grant, not by this command. */
        sandbox_options.session_id=request->session_id;
        sandbox_options.shared_profile=1;
    } else {
        (void)snprintf(sandbox_identity,sizeof(sandbox_identity),"Run.%lu.%llu.%ld",
                       (unsigned long)GetCurrentProcessId(),
                       (unsigned long long)GetTickCount64(),
                       (long)InterlockedIncrement(&sandbox_run_counter));
        sandbox_options.session_id=sandbox_identity;
    }
    sandbox_options.allow_network=request->allow_network;
    /* The filtered sidecar (per-exec network allow override) also needs
       privateNetworkClientServer to reach an upstream proxy on a LAN
       address; a filtered business execution gets no capability SID at all,
       so direct networking is cut. */
    sandbox_options.private_network=request->allow_network&&request->network_filtered;
    sandbox_options.read_only_paths=request->read_only_paths; sandbox_options.read_only_count=request->read_only_count;
    sandbox_options.deny_paths=request->deny_paths; sandbox_options.deny_count=request->deny_path_count;
    if(!add_write_root(&write_roots,&write_root_count,&write_root_capacity,request->cwd))goto cleanup;
    for(write_root_index=0;write_root_index<request->allow_path_count;write_root_index++)
        if(!add_write_root(&write_roots,&write_root_count,&write_root_capacity,request->allow_paths[write_root_index]))goto cleanup;
    sandbox_options.write_roots=(const char *const *)write_roots; sandbox_options.write_root_count=write_root_count;
    sandbox_options.bind_backing=request->bind_backing; sandbox_options.bind_read_only=request->bind_read_only; sandbox_options.bind_count=request->bind_count;
    if(request->sandbox_enabled && request->sandbox_mode==(int)OWC_SANDBOX_MODE_JOBOBJECT) {
        /* Session explicitly asked for compatibility mode: skip the AppContainer
           profile and process attribute, keep only the Job Object below. */
        result->sandbox_status=(int)OWC_SANDBOX_PARTIAL;
        (void)snprintf(result->sandbox_reason,sizeof(result->sandbox_reason),"Job Object compatibility mode requested by session policy");
    } else {
        if(request->sandbox_enabled) {
            sandbox=owc_sandbox_create(&sandbox_options,result->sandbox_reason,sizeof(result->sandbox_reason));
            /* Fail closed: a requested AppContainer sandbox that cannot be
               created (profile, ACL grant, deny ACE) must not degrade into
               an unsandboxed run.  The session can explicitly select the
               jobobject compatibility mode instead. */
            if(!sandbox){SetLastError(ERROR_INVALID_STATE);goto cleanup;}
        }
        result->sandbox_status=sandbox?(int)owc_sandbox_get_status(sandbox):(int)OWC_SANDBOX_ADVISORY;
        if(sandbox&&request->network_filtered)
            (void)snprintf(result->sandbox_reason,sizeof(result->sandbox_reason),
                           request->allow_network
                               ?"AppContainer enforced; network allowed by per-exec override (filtered session sidecar)"
                               :"AppContainer enforced; network filtered via in-sandbox proxy");
    }
    {
        /* Proxy injection only for the capability-less business execution of
           a filtered session (never for the sidecar itself); only meaningful
           while an AppContainer actually enforces. */
        int inject_proxy=sandbox&&request->network_filtered&&request->proxy_addr&&request->proxy_addr[0]&&!request->allow_network;
        if(sandbox&&(arg_style==OWC_SHELL_ARGS_PWSH||inject_proxy)) {
            wchar_t *proxy_wide=inject_proxy?utf8_to_wide(request->proxy_addr):NULL;
            env_block=build_child_environment(arg_style==OWC_SHELL_ARGS_PWSH?cwd:NULL,proxy_wide);
            free(proxy_wide);
        }
    }
    (void)InitializeProcThreadAttributeList(NULL,sandbox?2:1,0,&attribute_size);
    if(!attribute_size) goto cleanup;
    attributes=(LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attribute_size); if(!attributes) goto cleanup;
    if(!InitializeProcThreadAttributeList(attributes,sandbox?2:1,0,&attribute_size)) goto cleanup;
    startup.lpAttributeList=attributes;
    if(!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),NULL,NULL)) goto cleanup;
    if(sandbox&&!owc_sandbox_add_process_attribute(sandbox,attributes,result->sandbox_reason,sizeof(result->sandbox_reason))){result->sandbox_status=(int)OWC_SANDBOX_PARTIAL;goto cleanup;}

    if(!CreateProcessW(shell_path,command,NULL,NULL,TRUE,
                       CREATE_NO_WINDOW|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT|(env_block?CREATE_UNICODE_ENVIRONMENT:0),
                       env_block,cwd,&startup.StartupInfo,&process)) {
        DWORD appcontainer_error=GetLastError();
        if(!sandbox) goto cleanup;
        /* No silent downgrade: a sandboxed command whose AppContainer
           process cannot be created fails outright (AppContainer x ConPTY
           and profile restrictions have known environment-dependent
           failures); the session can explicitly select the jobobject
           compatibility mode. */
        (void)snprintf(result->sandbox_reason,sizeof(result->sandbox_reason),
                       "AppContainer process creation failed (error=%lu); refusing to run unsandboxed - set sandbox mode to \"jobobject\" for the Job Object compatibility mode",
                       (unsigned long)appcontainer_error);
        SetLastError(appcontainer_error);
        goto cleanup;
    }
    if(sandbox)result->sandbox_status=(int)owc_sandbox_get_status(sandbox);
    job=CreateJobObjectW(NULL,NULL); if(!job) goto cleanup;
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(request->sandbox_enabled && !sandbox) {
        /* Only the explicit jobobject compatibility mode reaches this branch
           now (AppContainer creation failures fail the command above), so
           the Job Object is the only enforcement: apply resource limits.
           With an active AppContainer profile the job stays cleanup-only -
           previous default-mode behavior is kept so large builds are not
           broken by the memory ceiling. */
        limits.BasicLimitInformation.LimitFlags|=JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.JobMemoryLimit=(SIZE_T)(request->job_memory_mb?request->job_memory_mb:OWC_JOB_DEFAULT_MEMORY_MB)*1024*1024;
        limits.BasicLimitInformation.ActiveProcessLimit=(DWORD)(request->job_max_processes?request->job_max_processes:OWC_JOB_DEFAULT_MAX_PROCESSES);
    }
    if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)) || !AssignProcessToJobObject(job,process.hProcess)) {
        /* Hosted Windows runners can already place this process in a Job
         * Object and reject nesting.  A non-sandboxed command needs no
         * enforcement Job Object; an AppContainer remains enforced without
         * this cleanup-only handle.  Do not weaken a requested sandbox that
         * failed to obtain AppContainer enforcement. */
        if(request->sandbox_enabled&&!sandbox) goto cleanup;
        CloseHandle(job);job=NULL;
    }
    if(ResumeThread(process.hThread)==(DWORD)-1) goto cleanup;
    CloseHandle(out_write); out_write=NULL; CloseHandle(err_write); err_write=NULL; CloseHandle(input); input=NULL;

    for(;;) {
        drain_pipe(out_read,"stdout",request,result,&forwarded,&sequence);
        drain_pipe(err_read,"stderr",request,result,&forwarded,&sequence);
        wait_result=WaitForSingleObject(process.hProcess,20);
        if(wait_result==WAIT_OBJECT_0) break;
        if(wait_result==WAIT_FAILED) goto cleanup;
        if(request->cancel_requested&&*request->cancel_requested) {
            if(job) (void)TerminateJobObject(job,1); else (void)TerminateProcess(process.hProcess,1);
            result->cancelled=1; (void)WaitForSingleObject(process.hProcess,2000); break;
        }
        if(GetTickCount64()-started>=(ULONGLONG)request->timeout_ms) {
            if(job) (void)TerminateJobObject(job,1); else (void)TerminateProcess(process.hProcess,1);
            result->timed_out=1; (void)WaitForSingleObject(process.hProcess,2000); break;
        }
    }
    drain_pipe(out_read,"stdout",request,result,&forwarded,&sequence);
    drain_pipe(err_read,"stderr",request,result,&forwarded,&sequence);
    if(!GetExitCodeProcess(process.hProcess,&exit_code)) goto cleanup;
    result->exit_code=(int)exit_code; result->duration_ms=(long long)(GetTickCount64()-started); ok=1;
cleanup:
    if(!ok) {
        result->system_error=(unsigned long)GetLastError();
        if(process.hProcess) {
            if(job) (void)TerminateJobObject(job,1); else (void)TerminateProcess(process.hProcess,1);
            (void)WaitForSingleObject(process.hProcess,2000);
        }
    }
    if(process.hThread) CloseHandle(process.hThread); if(process.hProcess) CloseHandle(process.hProcess);
    if(job) CloseHandle(job); if(out_read) CloseHandle(out_read); if(out_write) CloseHandle(out_write);
    if(err_read) CloseHandle(err_read); if(err_write) CloseHandle(err_write); if(input) CloseHandle(input);
    if(attributes) DeleteProcThreadAttributeList(attributes); free(attributes);
    owc_sandbox_destroy(sandbox);
    for(write_root_index=0;write_root_index<write_root_count;write_root_index++)free(write_roots[write_root_index]);
    free(write_roots);
    free(cwd); free(command); free(full_command); free(env_block); return ok;
}
