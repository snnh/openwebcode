#include "exec_platform.h"

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

int owc_platform_exec_run(const owc_exec_request *request, owc_exec_result *result) {
    SECURITY_ATTRIBUTES security={sizeof(security),NULL,TRUE};
    HANDLE out_read=NULL,out_write=NULL,err_read=NULL,err_write=NULL,job=NULL;
    PROCESS_INFORMATION process={0}; STARTUPINFOW startup={0};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
    wchar_t *cwd=NULL,*command=NULL; char *full_command=NULL;
    ULONGLONG started=GetTickCount64(); size_t forwarded=0; unsigned sequence=0;
    DWORD wait_result,exit_code=1; int ok=0;

    if(!CreatePipe(&out_read,&out_write,&security,0) || !CreatePipe(&err_read,&err_write,&security,0)) goto cleanup;
    (void)SetHandleInformation(out_read,HANDLE_FLAG_INHERIT,0);
    (void)SetHandleInformation(err_read,HANDLE_FLAG_INHERIT,0);
    cwd=utf8_to_wide(request->cwd);
    {
        int command_length=snprintf(NULL,0,"cmd.exe /d /s /c \"%s\"",request->command);
        if(command_length<0) goto cleanup;
        full_command=(char *)malloc((size_t)command_length+1);
        if(!full_command) goto cleanup;
        (void)snprintf(full_command,(size_t)command_length+1,"cmd.exe /d /s /c \"%s\"",request->command);
    }
    if(!cwd) goto cleanup;
    command=utf8_to_wide(full_command); if(!command) goto cleanup;

    startup.cb=sizeof(startup); startup.dwFlags=STARTF_USESTDHANDLES;
    startup.hStdOutput=out_write; startup.hStdError=err_write; startup.hStdInput=GetStdHandle(STD_INPUT_HANDLE);
    if(!CreateProcessW(NULL,command,NULL,NULL,TRUE,CREATE_NO_WINDOW|CREATE_SUSPENDED,NULL,cwd,&startup,&process)) goto cleanup;
    job=CreateJobObjectW(NULL,NULL);
    if(job) {
        limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)) || !AssignProcessToJobObject(job,process.hProcess)) { CloseHandle(job); job=NULL; }
    }
    if(ResumeThread(process.hThread)==(DWORD)-1) goto cleanup;
    CloseHandle(out_write); out_write=NULL; CloseHandle(err_write); err_write=NULL;

    for(;;) {
        drain_pipe(out_read,"stdout",request,result,&forwarded,&sequence);
        drain_pipe(err_read,"stderr",request,result,&forwarded,&sequence);
        wait_result=WaitForSingleObject(process.hProcess,20);
        if(wait_result==WAIT_OBJECT_0) break;
        if(wait_result==WAIT_FAILED) goto cleanup;
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
    if(err_read) CloseHandle(err_read); if(err_write) CloseHandle(err_write);
    free(cwd); free(command); free(full_command); return ok;
}
