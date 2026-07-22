#include "exec_platform.h"
#include "sandbox.h"

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

static int add_write_root(char **roots,size_t *count,size_t capacity,const char *path) {
    char *normalized;
    size_t i;
    if(*count>=capacity)return 0;
    normalized=normalize_path(path);
    if(!normalized)return 0;
    for(i=0;i<*count;i++)if(_stricmp(roots[i],normalized)==0){free(normalized);return 1;}
    roots[(*count)++]=normalized;
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

static int select_shell(wchar_t *path, size_t count, int prefer_powershell,
                        int *powershell) {
    DWORD length;
    if (prefer_powershell) {
        length = SearchPathW(NULL, L"pwsh.exe", NULL, (DWORD)count, path, NULL);
        if (length > 0 && length < count) {
            *powershell = 1;
            return 1;
        }
    }
    length = GetSystemDirectoryW(path, (UINT)count);
    if (!length || length >= count - 8) return 0;
    if (wcscat_s(path, count, L"\\cmd.exe") != 0) return 0;
    *powershell = 0;
    return 1;
}

int owc_platform_exec_run(const owc_exec_request *request, owc_exec_result *result) {
    SECURITY_ATTRIBUTES security={sizeof(security),NULL,TRUE};
    HANDLE out_read=NULL,out_write=NULL,err_read=NULL,err_write=NULL,input=NULL,job=NULL;
    HANDLE inherited[3];
    PROCESS_INFORMATION process={0}; STARTUPINFOEXW startup={0};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
    LPPROC_THREAD_ATTRIBUTE_LIST attributes=NULL;
    SIZE_T attribute_size=0;
    wchar_t *cwd=NULL,*command=NULL; wchar_t shell_path[MAX_PATH]; char *full_command=NULL;
    owc_sandbox *sandbox=NULL; owc_sandbox_options sandbox_options={0};
    char *write_roots[17]={0}; size_t write_root_count=0,write_root_index;
    ULONGLONG started=GetTickCount64(); size_t forwarded=0; unsigned sequence=0;
    DWORD wait_result,exit_code=1; int ok=0,powershell=0;

    if(!CreatePipe(&out_read,&out_write,&security,0) || !CreatePipe(&err_read,&err_write,&security,0)) goto cleanup;
    if(!SetHandleInformation(out_read,HANDLE_FLAG_INHERIT,0) || !SetHandleInformation(err_read,HANDLE_FLAG_INHERIT,0)) goto cleanup;
    input=CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    if(input==INVALID_HANDLE_VALUE) { input=NULL; goto cleanup; }
    cwd=utf8_to_wide(request->cwd);
    {
        int command_length;
        const char *arguments;
        if(!select_shell(shell_path,ARRAYSIZE(shell_path),!request->sandbox_enabled,&powershell)) goto cleanup;
        arguments=powershell?"-NoLogo -NoProfile -NonInteractive -Command":"/d /s /c";
        command_length=snprintf(NULL,0,"\"%ls\" %s \"%s\"",shell_path,arguments,request->command);
        if(command_length<0) goto cleanup;
        full_command=(char *)malloc((size_t)command_length+1);
        if(!full_command) goto cleanup;
        (void)snprintf(full_command,(size_t)command_length+1,"\"%ls\" %s \"%s\"",shell_path,arguments,request->command);
    }
    if(!cwd) goto cleanup;
    command=utf8_to_wide(full_command); if(!command) goto cleanup;

    startup.StartupInfo.cb=sizeof(startup); startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdOutput=out_write; startup.StartupInfo.hStdError=err_write; startup.StartupInfo.hStdInput=input;
    inherited[0]=out_write; inherited[1]=err_write; inherited[2]=input;
    sandbox_options.session_id=request->session_id; sandbox_options.allow_network=request->allow_network;
    if(request->allow_path_count>16||!add_write_root(write_roots,&write_root_count,ARRAYSIZE(write_roots),request->cwd))goto cleanup;
    for(write_root_index=0;write_root_index<request->allow_path_count;write_root_index++)
        if(!add_write_root(write_roots,&write_root_count,ARRAYSIZE(write_roots),request->allow_paths[write_root_index]))goto cleanup;
    sandbox_options.write_roots=(const char *const *)write_roots; sandbox_options.write_root_count=write_root_count;
    if(request->sandbox_enabled && request->sandbox_mode==(int)OWC_SANDBOX_MODE_JOBOBJECT) {
        /* Session explicitly asked for compatibility mode: skip the AppContainer
           profile and process attribute, keep only the Job Object below. */
        result->sandbox_status=(int)OWC_SANDBOX_PARTIAL;
        (void)snprintf(result->sandbox_reason,sizeof(result->sandbox_reason),"Job Object compatibility mode requested by session policy");
    } else {
        if(request->sandbox_enabled) sandbox=owc_sandbox_create(&sandbox_options,result->sandbox_reason,sizeof(result->sandbox_reason));
        result->sandbox_status=sandbox?(int)owc_sandbox_get_status(sandbox):(int)OWC_SANDBOX_ADVISORY;
    }
    (void)InitializeProcThreadAttributeList(NULL,sandbox?2:1,0,&attribute_size);
    if(!attribute_size) goto cleanup;
    attributes=(LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attribute_size); if(!attributes) goto cleanup;
    if(!InitializeProcThreadAttributeList(attributes,sandbox?2:1,0,&attribute_size)) goto cleanup;
    startup.lpAttributeList=attributes;
    if(!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),NULL,NULL)) goto cleanup;
    if(sandbox&&!owc_sandbox_add_process_attribute(sandbox,attributes,result->sandbox_reason,sizeof(result->sandbox_reason))){result->sandbox_status=(int)OWC_SANDBOX_PARTIAL;goto cleanup;}

    if(!CreateProcessW(shell_path,command,NULL,NULL,TRUE,CREATE_NO_WINDOW|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT,NULL,cwd,&startup.StartupInfo,&process)) {
        DWORD appcontainer_error=GetLastError();
        if(!sandbox) goto cleanup;
        owc_sandbox_destroy(sandbox);sandbox=NULL;result->sandbox_status=(int)OWC_SANDBOX_PARTIAL;
        (void)snprintf(result->sandbox_reason,sizeof(result->sandbox_reason),"AppContainer process creation failed (%lu); using Job Object compatibility mode",(unsigned long)appcontainer_error);
        DeleteProcThreadAttributeList(attributes);free(attributes);attributes=NULL;attribute_size=0;free(command);command=utf8_to_wide(full_command);if(!command)goto cleanup;
        (void)InitializeProcThreadAttributeList(NULL,1,0,&attribute_size);if(!attribute_size)goto cleanup;attributes=(LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attribute_size);if(!attributes)goto cleanup;if(!InitializeProcThreadAttributeList(attributes,1,0,&attribute_size))goto cleanup;startup.lpAttributeList=attributes;if(!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),NULL,NULL))goto cleanup;
        if(!CreateProcessW(NULL,command,NULL,NULL,TRUE,CREATE_NO_WINDOW|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT,NULL,cwd,&startup.StartupInfo,&process))goto cleanup;
    }
    if(sandbox)result->sandbox_status=(int)owc_sandbox_get_status(sandbox);
    job=CreateJobObjectW(NULL,NULL); if(!job) goto cleanup;
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(request->sandbox_enabled && !sandbox) {
        /* Job Object is the only enforcement in these paths (explicit jobobject
           compatibility mode, AppContainer process-creation fallback, or no
           profile): apply resource limits. With an active AppContainer profile
           the job stays cleanup-only - previous default-mode behavior is kept
           so large builds are not broken by the memory ceiling. */
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
            (void)TerminateJobObject(job,1);
            result->cancelled=1; (void)WaitForSingleObject(process.hProcess,2000); break;
        }
        if(GetTickCount64()-started>=(ULONGLONG)request->timeout_ms) {
            (void)TerminateJobObject(job,1);
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
    free(cwd); free(command); free(full_command); return ok;
}
