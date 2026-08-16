#include "rpc.h"
#include "bindlink.h"
#include "bwrap.h"
#include "exec.h"
#include "fs.h"
#include "json.h"
#include "overlay.h"
#include "path_policy.h"
#include "pty.h"
#include "platform/fs_platform.h"
#include "sandbox.h"
#include "symbol_extract.h"
#include "version.h"

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <pthread.h>
typedef pthread_mutex_t CRITICAL_SECTION;
typedef struct { pthread_t thread; } owc_pthread_handle;
typedef owc_pthread_handle *HANDLE;
typedef unsigned long DWORD;
#define WINAPI
typedef DWORD (WINAPI *owc_thread_fn)(void *);
typedef struct { owc_thread_fn fn; void *data; } owc_thread_start;
static void *owc_pthread_start(void *value){owc_thread_start *start=(owc_thread_start*)value;(void)start->fn(start->data);free(start);return NULL;}
static HANDLE CreateThread(void *unused_a,size_t unused_b,owc_thread_fn fn,void *data,DWORD unused_c,void *unused_d){owc_pthread_handle *handle;owc_thread_start *start;(void)unused_a;(void)unused_b;(void)unused_c;(void)unused_d;handle=(owc_pthread_handle*)malloc(sizeof(*handle));start=(owc_thread_start*)malloc(sizeof(*start));if(!handle||!start){free(handle);free(start);return NULL;}start->fn=fn;start->data=data;if(pthread_create(&handle->thread,NULL,owc_pthread_start,start)!=0){free(handle);free(start);return NULL;}(void)pthread_detach(handle->thread);return handle;}
static int CloseHandle(HANDLE handle){free(handle);return 1;}
#define InitializeCriticalSection(lock) ((void)pthread_mutex_init((lock),NULL))
#define EnterCriticalSection(lock) ((void)pthread_mutex_lock((lock)))
#define LeaveCriticalSection(lock) ((void)pthread_mutex_unlock((lock)))
#define DeleteCriticalSection(lock) ((void)pthread_mutex_destroy((lock)))
#endif

#ifndef _WIN32
#include <time.h>
#endif

/* Joinable thread support for parallel worker pools (grep job).  The
 * existing CreateThread is detached on POSIX (fire-and-forget for
 * job workers); these wrappers create threads the caller can wait on.
 * DWORD and WINAPI are defined on both platforms by the time this is
 * compiled (Windows: <windows.h>; POSIX: the typedefs above). */
static HANDLE owc_create_joinable_thread(DWORD (WINAPI *fn)(void *), void *data) {
#ifdef _WIN32
    return CreateThread(NULL, 0, fn, data, 0, NULL);
#else
    owc_pthread_handle *handle; owc_thread_start *start;
    handle=(owc_pthread_handle*)malloc(sizeof(*handle));
    start=(owc_thread_start*)malloc(sizeof(*start));
    if(!handle||!start){free(handle);free(start);return NULL;}
    start->fn=fn; start->data=data;
    if(pthread_create(&handle->thread,NULL,owc_pthread_start,start)!=0){free(handle);free(start);return NULL;}
    return handle; /* NOT detached - caller must owc_join_thread */
#endif
}
static void owc_join_thread(HANDLE handle) {
    if(!handle) return;
#ifdef _WIN32
    WaitForSingleObject(handle, INFINITE);
    CloseHandle(handle);
#else
    pthread_join(handle->thread, NULL);
    free(handle);
#endif
}

/* Monotonic millisecond clock for scan time budgets (wall-clock-independent). */
static unsigned long long monotonic_ms(void) {
#ifdef _WIN32
    return (unsigned long long)GetTickCount64();
#else
    struct timespec now;
    if(clock_gettime(CLOCK_MONOTONIC,&now)!=0) return 0;
    return (unsigned long long)now.tv_sec*1000ull+(unsigned long long)now.tv_nsec/1000000ull;
#endif
}

static int write_format(owc_rpc *rpc, const char *format, ...) {
    va_list args, copy; int length; char *body;
    va_start(args,format); va_copy(copy,args); length=vsnprintf(NULL,0,format,args); va_end(args);
    if(length<0) { va_end(copy); return 0; }
    body=(char *)malloc((size_t)length+1); if(!body) { va_end(copy); return 0; }
    (void)vsnprintf(body,(size_t)length+1,format,copy); va_end(copy);
    { int ok=owc_rpc_write(rpc,body,(size_t)length); free(body); return ok; }
}

/* PTY reader threads are concurrent with the main dispatch loop and both
 * write frames to the same stream, so every frame write is serialized.
 * Initialized on the main thread at the top of owc_rpc_dispatch, before any
 * reader thread can exist. */
static CRITICAL_SECTION write_mutex;
static int write_mutex_ready=0;
static void write_mutex_init(void){if(!write_mutex_ready){InitializeCriticalSection(&write_mutex);write_mutex_ready=1;}}

int owc_rpc_write(owc_rpc *rpc, const char *body, size_t length) {
    int ok;
    if(write_mutex_ready)EnterCriticalSection(&write_mutex);
    if(fprintf(rpc->output,"Content-Length: %zu\r\n\r\n",length)<0) ok=0;
    else if(length && fwrite(body,1,length,rpc->output)!=length) ok=0;
    else ok=fflush(rpc->output)==0;
    if(write_mutex_ready)LeaveCriticalSection(&write_mutex);
    return ok;
}

static int header_name_equals(const char *line, const char *name, size_t length) {
    size_t i;
    for(i=0;i<length;i++) if(tolower((unsigned char)line[i])!=tolower((unsigned char)name[i])) return 0;
    return line[length]==':';
}

int owc_rpc_read(owc_rpc *rpc, char **body, size_t *length) {
    char line[1024]; size_t content_length=SIZE_MAX; int saw_header_end=0;
    *body=NULL; *length=0;
    while(fgets(line,sizeof(line),rpc->input)) {
        char *end; unsigned long long parsed;
        size_t line_length=strlen(line);
        if(!line_length || line[line_length-1]!='\n') return -1;
        if(strcmp(line,"\r\n")==0) { saw_header_end=1; break; }
        if(header_name_equals(line,"Content-Length",14)) {
            const char *number=line+15;
            if(content_length!=SIZE_MAX) return -1;
            while(*number==' ' || *number=='\t') number++;
            if(!isdigit((unsigned char)*number)) return -1;
            errno=0; parsed=strtoull(number,&end,10);
            while(*end==' ' || *end=='\t') end++;
            if(errno || strcmp(end,"\r\n")!=0 || parsed>OWC_RPC_MAX_MESSAGE) return -1;
            content_length=(size_t)parsed;
        }
    }
    if(feof(rpc->input) && content_length==SIZE_MAX) return 0;
    if(!saw_header_end || content_length==SIZE_MAX) return -1;
    *body=(char *)malloc(content_length+1); if(!*body) return -1;
    if(content_length && fread(*body,1,content_length,rpc->input)!=content_length) { free(*body); *body=NULL; return -1; }
    (*body)[content_length]='\0'; *length=content_length; return 1;
}

static char *base64_encode(const unsigned char *data, size_t length) {
    static const char table[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t i,o=0,out_length=4*((length+2)/3); char *out=(char *)malloc(out_length+1);
    if(!out) return NULL;
    for(i=0;i<length;i+=3) {
        unsigned value=(unsigned)data[i]<<16;
        value |= i+1<length?(unsigned)data[i+1]<<8:0; value |= i+2<length?data[i+2]:0;
        out[o++]=table[value>>18&63]; out[o++]=table[value>>12&63]; out[o++]=i+1<length?table[value>>6&63]:'='; out[o++]=i+2<length?table[value&63]:'=';
    }
    out[o]='\0'; return out;
}

static char *id_json(const owc_json *id) {
    char number[64],*copy;
    if(!id || id->type==OWC_JSON_NULL) { copy=(char *)malloc(5); if(copy) (void)strcpy(copy,"null"); return copy; }
    if(id->type==OWC_JSON_STRING) return owc_json_escape_string(id->value.string);
    if(id->type==OWC_JSON_NUMBER) { (void)snprintf(number,sizeof(number),"%.17g",id->value.number); copy=(char *)malloc(strlen(number)+1); if(copy) (void)strcpy(copy,number); return copy; }
    return NULL;
}

static int reply_error(owc_rpc *rpc, const owc_json *id, int code, const char *message) {
    char *id_text,*escaped; int ok=0;
    if(rpc->suppress_responses) return 1;
    id_text=id_json(id); escaped=owc_json_escape_string(message);
    if(id_text && escaped) ok=write_format(rpc,"{\"jsonrpc\":\"2.0\",\"id\":%s,\"error\":{\"code\":%d,\"message\":%s}}",id_text,code,escaped);
    free(id_text); free(escaped); return ok;
}

static int reply_result(owc_rpc *rpc, const owc_json *id, const char *result) {
    char *id_text; int ok=0;
    if(rpc->suppress_responses) return 1;
    id_text=id_json(id);
    if(id_text) ok=write_format(rpc,"{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":%s}",id_text,result);
    free(id_text); return ok;
}

typedef struct { owc_rpc *rpc; const char *exec_id; } output_context;
static void output_notification(void *user_data,const char *stream,const unsigned char *data,size_t length,unsigned sequence) {
    output_context *context=(output_context *)user_data; char *encoded,*id;
    if(context->rpc->suppress_responses) return;
    encoded=base64_encode(data,length); id=owc_json_escape_string(context->exec_id);
    if(encoded && id) (void)write_format(context->rpc,"{\"jsonrpc\":\"2.0\",\"method\":\"exec.output\",\"params\":{\"execId\":%s,\"stream\":\"%s\",\"data\":\"%s\",\"seq\":%u}}",id,stream,encoded,sequence);
    free(encoded); free(id);
}

static int parse_timeout(const owc_json *value, int *timeout_ms) {
    double number;
    if(!value) { *timeout_ms=120000; return 1; }
    if(value->type!=OWC_JSON_NUMBER) return 0;
    number=value->value.number;
    if(number<1 || number>INT_MAX || number!=(double)(int)number) return 0;
    *timeout_ms=(int)number; return 1;
}

static int parse_job_limit(const owc_json *value, unsigned long maximum, unsigned long *result) {
    double number;
    if(value->type!=OWC_JSON_NUMBER) return 0;
    number=value->value.number;
    if(number<1 || number>(double)maximum || number!=(double)(unsigned long)number) return 0;
    *result=(unsigned long)number; return 1;
}

static int session_exec_policy(const char *id,const char *cwd,int *enabled,int *allow_network,int *mode,const char *const **allow_paths,size_t *allow_path_count,unsigned long *job_memory_mb,unsigned long *job_max_processes,const char *const **bind_backing,const int **bind_read_only,size_t *bind_count,const char *const **read_roots,size_t *read_root_count,const char *const **write_roots,size_t *write_root_count,const char *const **deny_paths,size_t *deny_path_count,int *network_filtered,const char **proxy_addr,const char *const **read_only_paths,size_t *read_only_count);
static int allowed_keys(const owc_json *p,const char *const *keys,size_t count);
static void remove_session_watches(const char *session_id);
static void remove_session_ptys(const char *session_id);
static void cancel_session_jobs(const char *session_id);

/* Per-exec network override (exec.run / job.start): "allow" or "deny"
 * replaces the session's allow_network for this one execution - the
 * filtered-mode proxy sidecar uses "allow" to obtain outbound capability
 * inside the shared AppContainer profile. */
static int parse_network_override(const owc_json *params,int *allow_network) {
    const owc_json *value=owc_json_object_get(params,"network");
    const char *name;
    if(!value)return 1;
    name=owc_json_get_string(value);
    if(!name||(strcmp(name,"allow")&&strcmp(name,"deny")))return 0;
    *allow_network=!strcmp(name,"allow");
    return 1;
}

static int parse_shell_backend(const owc_json *params, int *backend) {
    const owc_json *value=owc_json_object_get(params,"shellBackend");
    const char *name;
    *backend=(int)OWC_SHELL_DEFAULT;
    if(!value)return 1;
    name=owc_json_get_string(value);
    if(!name)return 0;
    if(!strcmp(name,"default"))return 1;
    if(!strcmp(name,"pwsh")){*backend=(int)OWC_SHELL_PWSH;return 1;}
    if(!strcmp(name,"bash")){*backend=(int)OWC_SHELL_BASH;return 1;}
    return 0;
}

/* Optional explicit shell executable path from the host detection layer
   (e.g. a Git Bash absolute path); when present it takes precedence over
   the per-backend executable search. */
static int parse_shell_path(const owc_json *params, const char **shell_path) {
    const owc_json *value=owc_json_object_get(params,"shellPath");
    const char *text;
    *shell_path=NULL;
    if(!value)return 1;
    text=owc_json_get_string(value);
    if(!text||!text[0]||strlen(text)>1024)return 0;
    *shell_path=text;
    return 1;
}

static const char *shell_backend_name(int backend) {
    return backend==(int)OWC_SHELL_PWSH?"pwsh":backend==(int)OWC_SHELL_BASH?"bash":"default";
}

/* See handle_exec_run: synchronous exec.run timeouts are clamped to this. */
#define OWC_EXEC_RUN_MAX_TIMEOUT_MS (10*60*1000)
static int handle_exec_run(owc_rpc *rpc,const owc_json *id,const owc_json *params) {
    const char *command=owc_json_get_string(owc_json_object_get(params,"cmd"));
    const char *cwd=owc_json_get_string(owc_json_object_get(params,"cwd"));
    const char *exec_id=owc_json_get_string(owc_json_object_get(params,"execId"));
    const char *session_id=owc_json_get_string(owc_json_object_get(params,"sessionId"));
    static const char *keys[]={"sessionId","execId","cmd","cwd","timeoutMs","shellBackend","shellPath","network"};
    owc_exec_request request; owc_exec_result result; output_context context; int sandbox_enabled,allow_network,sandbox_mode; unsigned long job_memory_mb,job_max_processes; const char *const *bind_backing; const int *bind_read_only; size_t bind_count;
    if(!params || params->type!=OWC_JSON_OBJECT || !command || !cwd || !exec_id || !session_id || !command[0] || !cwd[0] || !exec_id[0] || !session_id[0]) return reply_error(rpc,id,-32602,"exec.run requires non-empty string sessionId, execId, cmd, and cwd");
    if(!allowed_keys(params,keys,8))return reply_error(rpc,id,-32602,"exec.run contains unknown fields");
    memset(&request,0,sizeof(request)); context.rpc=rpc; context.exec_id=exec_id;
    if(!parse_shell_backend(params,&request.shell_backend))return reply_error(rpc,id,-32602,"shellBackend must be default, pwsh, or bash");
    if(!parse_shell_path(params,&request.shell_path))return reply_error(rpc,id,-32602,"shellPath must be a non-empty string of at most 1024 bytes");
    if(!session_exec_policy(session_id,cwd,&sandbox_enabled,&allow_network,&sandbox_mode,&request.allow_paths,&request.allow_path_count,&job_memory_mb,&job_max_processes,&bind_backing,&bind_read_only,&bind_count,&request.read_roots,&request.read_root_count,&request.write_roots,&request.write_root_count,&request.deny_paths,&request.deny_path_count,&request.network_filtered,&request.proxy_addr,&request.read_only_paths,&request.read_only_count))return reply_error(rpc,id,-32002,"session cwd is not configured");
    if(!parse_network_override(params,&allow_network))return reply_error(rpc,id,-32602,"network must be \"allow\" or \"deny\"");
    request.command=command; request.cwd=cwd; request.session_id=session_id;request.sandbox_enabled=sandbox_enabled;request.allow_network=allow_network;request.sandbox_mode=sandbox_mode;
    request.job_memory_mb=job_memory_mb; request.job_max_processes=job_max_processes;
    request.bind_backing=bind_backing; request.bind_read_only=bind_read_only; request.bind_count=bind_count;
    if(!parse_timeout(owc_json_object_get(params,"timeoutMs"),&request.timeout_ms)) return reply_error(rpc,id,-32602,"timeoutMs must be a positive integer");
    /* A synchronous exec.run blocks the entire RPC loop until the command
     * finishes, so an effectively unbounded timeout (parse_timeout accepts
     * up to INT_MAX ms, roughly 24 days) would wedge every session behind
     * one request.  Clamp to ten minutes; long-running work belongs in
     * job.start, which is asynchronous. */
    if(request.timeout_ms>OWC_EXEC_RUN_MAX_TIMEOUT_MS) request.timeout_ms=OWC_EXEC_RUN_MAX_TIMEOUT_MS;
    request.output_limit=10u*1024u*1024u; request.on_output=output_notification; request.user_data=&context;
    if(!owc_exec_run(&request,&result)) { char message[96];if(result.shell_unavailable){(void)snprintf(message,sizeof(message),"%s executable was not found",shell_backend_name(request.shell_backend));return reply_error(rpc,id,-32000,message);}(void)snprintf(message,sizeof(message),"failed to start or monitor command (system error %lu)",result.system_error);return reply_error(rpc,id,-32000,message); }
    if(result.timed_out) return reply_error(rpc,id,-32001,"command timed out");
    {
        char result_text[2048];char *reason=owc_json_escape_string(result.sandbox_reason[0]?result.sandbox_reason:"sandbox not requested");if(!reason)return reply_error(rpc,id,-32000,"failed to encode sandbox status");
        (void)snprintf(result_text,sizeof(result_text),"{\"exitCode\":%d,\"durationMs\":%lld,\"truncated\":%s,\"sandboxCapability\":\"%s\",\"sandboxReason\":%s}",
            result.exit_code,result.duration_ms,result.truncated?"true":"false",owc_sandbox_status_name((owc_sandbox_status)result.sandbox_status),reason);free(reason);
        return reply_result(rpc,id,result_text);
    }
}

typedef struct { char *session_id; char *cwd; char *deny_paths[16]; size_t deny_count; char *read_roots[16]; size_t read_root_count; char *write_roots[16]; size_t write_root_count; char *allow_paths[16]; size_t allow_count; int sandbox_enabled; int allow_network; int sandbox_mode; unsigned long job_memory_mb; unsigned long job_max_processes; char *bind_virt[16]; char *bind_backing[16]; int bind_read_only[16]; size_t bind_count; int network_filtered; char proxy_addr[144]; char *read_only_paths[16]; size_t read_only_count; } session_config;
static session_config sessions[64];
static size_t session_count=0;
static char *copy_text(const char *value){size_t n=strlen(value)+1;char *copy=(char*)malloc(n);if(copy)memcpy(copy,value,n);return copy;}
static session_config *session_find(const char *id){size_t i;for(i=0;i<session_count;i++)if(!strcmp(sessions[i].session_id,id))return &sessions[i];return NULL;}
static const char *session_root(const char *id){session_config *session=session_find(id);return session?session->cwd:NULL;}
static int policy_path_equal(const char *left,const char *right){while(*left&&*right){char a=*left++,b=*right++;
#ifdef _WIN32
 if(a=='\\')a='/';if(b=='\\')b='/';a=(char)tolower((unsigned char)a);b=(char)tolower((unsigned char)b);
#endif
 if(a!=b)return 0;}return *left=='\0'&&*right=='\0';}
static int session_exec_policy(const char *id,const char *cwd,int *enabled,int *allow_network,int *mode,const char *const **allow_paths,size_t *allow_path_count,unsigned long *job_memory_mb,unsigned long *job_max_processes,const char *const **bind_backing,const int **bind_read_only,size_t *bind_count,const char *const **read_roots,size_t *read_root_count,const char *const **write_roots,size_t *write_root_count,const char *const **deny_paths,size_t *deny_path_count,int *network_filtered,const char **proxy_addr,const char *const **read_only_paths,size_t *read_only_count){session_config *session=session_find(id);if(!session||!policy_path_equal(session->cwd,cwd))return 0;*enabled=session->sandbox_enabled;*allow_network=session->allow_network;*mode=session->sandbox_mode;*allow_paths=(const char *const *)session->allow_paths;*allow_path_count=session->allow_count;*job_memory_mb=session->job_memory_mb;*job_max_processes=session->job_max_processes;*bind_backing=(const char *const *)session->bind_backing;*bind_read_only=(const int *)session->bind_read_only;*bind_count=session->bind_count;*read_roots=(const char *const *)session->read_roots;*read_root_count=session->read_root_count;*write_roots=(const char *const *)session->write_roots;*write_root_count=session->write_root_count;*deny_paths=(const char *const *)session->deny_paths;*deny_path_count=session->deny_count;*network_filtered=session->network_filtered;*proxy_addr=session->proxy_addr[0]?session->proxy_addr:NULL;*read_only_paths=(const char *const *)session->read_only_paths;*read_only_count=session->read_only_count;return 1;}
/* Filesystem primitives accept workspace-relative paths.  Normalize those
 * paths before comparing policy roots so cosmetic forms such as ./private do
 * not bypass an absolute deny root.  Traversal and absolute paths are denied
 * here as well as by the no-follow platform implementation. */
static char *session_policy_path(const char *cwd,const char *path){
    const char *cursor;char *out;size_t used=0,components=0;int absolute;
    if(!cwd||!path||!path[0])return NULL;
    absolute=path[0]=='/'||path[0]=='\\'||(path[0]&&path[1]==':');
    /* Drive-relative (D:foo) and UNC prefix forms are ambiguous: reject.
       Other absolute paths are normalized lexically; the root policy check
       below remains the only authority on what is reachable. */
    if(path[0]&&path[1]==':'&&path[2]&&path[2]!='/'&&path[2]!='\\')return NULL;
    if(path[0]=='\\'&&path[1]=='\\')return NULL;
    out=(char*)malloc(strlen(cwd)+strlen(path)+3);
    if(!out)return NULL;
    if(!absolute){
        used=strlen(cwd);memcpy(out,cwd,used);
        while(used&&(out[used-1]=='/'||out[used-1]=='\\'))used--;
    }else if(path[0]=='/'||path[0]=='\\'){
        out[used++]='/';
    }
    out[used]='\0';cursor=path;
    while(*cursor){
        const char *end;size_t length;
        while(*cursor=='/'||*cursor=='\\')cursor++;
        if(!*cursor)break;
        end=cursor;while(*end&&*end!='/'&&*end!='\\')end++;
        length=(size_t)(end-cursor);
        if(length==1&&cursor[0]=='.'){cursor=end;continue;}
        if(length==2&&cursor[0]=='.'&&cursor[1]=='.'){
            if(!absolute){free(out);return NULL;}
            /* Absolute: pop one component lexically, keeping any root marker.
               Popping past the root is harmless - the result simply fails the
               root prefix check like any other outside path. */
            while(used&&out[used-1]!='/')used--;
            if(used>1)used--;
            out[used]='\0';cursor=end;continue;
        }
        if(++components>256u){free(out);return NULL;}
        if(used&&out[used-1]!='/'&&out[used-1]!='\\')out[used++]='/';
        memcpy(out+used,cursor,length);used+=length;out[used]='\0';cursor=end;
    }
    if(absolute&&!components){free(out);return NULL;}
    return out;
}
static int session_path_check(const session_config *session,const char *path,owc_path_permission permission){owc_path_policy policy;char *canonical;int allowed;if(!session)return 0;canonical=session_policy_path(session->cwd,path);if(!canonical)return 0;memset(&policy,0,sizeof(policy));policy.read_roots=(const char *const *)session->read_roots;policy.read_root_count=session->read_root_count;policy.write_roots=(const char *const *)session->write_roots;policy.write_root_count=session->write_root_count;policy.deny_roots=(const char *const *)session->deny_paths;policy.deny_root_count=session->deny_count;allowed=owc_path_policy_check(&policy,canonical,permission);free(canonical);return allowed;}
static int session_path_allowed(const char *id,const char *path,owc_path_permission permission){session_config *session=session_find(id);if(!session)return 0;/* Publish the session deny roots to the platform layer before any file
 * operation that follows this check: the textual comparison below cannot see
 * junction / 8.3 / trailing-dot aliases, so the platform re-checks the
 * resolved final path (Windows) against the same roots. */
owc_fs_platform_set_deny_roots((const char *const *)session->deny_paths,session->deny_count);owc_fs_platform_set_bind_links((const char *const *)session->bind_virt,(const char *const *)session->bind_backing,session->bind_count);return session_path_check(session,path,permission);}
static void clear_denies(session_config *session){size_t i;for(i=0;i<session->deny_count;i++)free(session->deny_paths[i]);session->deny_count=0;}
static void clear_allows(session_config *session){size_t i;for(i=0;i<session->allow_count;i++)free(session->allow_paths[i]);session->allow_count=0;}
static void clear_roots(char **roots,size_t *count){size_t i;for(i=0;i<*count;i++)free(roots[i]);*count=0;}
static void clear_bind_links(session_config *session){size_t i;for(i=0;i<session->bind_count;i++){free(session->bind_virt[i]);free(session->bind_backing[i]);}session->bind_count=0;}
/* Undo the system-wide links this session created (session cleanup,
 * re-configure, and process exit all funnel through here).  Best effort:
 * removal failures are ignored, matching the documented reboot lifetime. */
static void remove_session_bind_links(session_config *session){size_t i;for(i=0;i<session->bind_count;i++)owc_bindlink_remove(session->bind_virt[i]);}
static void clear_session_config(session_config *session){if(!session)return;remove_session_bind_links(session);clear_bind_links(session);clear_denies(session);clear_allows(session);clear_roots(session->read_roots,&session->read_root_count);clear_roots(session->write_roots,&session->write_root_count);clear_roots(session->read_only_paths,&session->read_only_count);free(session->session_id);free(session->cwd);memset(session,0,sizeof(*session));}
static int copy_string_array(const owc_json *array,char **values,size_t *count){size_t i;if(!array)return 1;if(array->type!=OWC_JSON_ARRAY||array->value.children.count>16)return 0;for(i=0;i<array->value.children.count;i++){const char *value=owc_json_get_string(array->value.children.items[i]);if(!value||!value[0])return 0;values[*count]=copy_text(value);if(!values[*count])return 0;(*count)++;}return 1;}
/* sandbox.bindLinks: optional directory bindings created through the Windows
 * Bind Link API before the session's first process starts.  Parse errors are
 * reported as invalid params (-32602) via err; a NULL/empty err means the
 * caller falls back to its generic configure failure. */
static int parse_bind_links(session_config *session,const owc_json *value,char *err,size_t err_size){
    static const char *keys[]={"virtPath","backingPath","readOnly"};
    size_t i;
    if(!value)return 1;
    if(value->type!=OWC_JSON_ARRAY||value->value.children.count>16){(void)snprintf(err,err_size,"sandbox.bindLinks must be an array of at most 16 entries");return 0;}
    for(i=0;i<value->value.children.count;i++){
        const owc_json *entry=value->value.children.items[i],*read_only;const char *virt,*backing;
        if(entry->type!=OWC_JSON_OBJECT||!allowed_keys(entry,keys,3)){(void)snprintf(err,err_size,"sandbox.bindLinks entries must be objects with only virtPath, backingPath, and readOnly");return 0;}
        virt=owc_json_get_string(owc_json_object_get(entry,"virtPath"));
        backing=owc_json_get_string(owc_json_object_get(entry,"backingPath"));
        if(!virt||!virt[0]||!backing||!backing[0]){(void)snprintf(err,err_size,"sandbox.bindLinks entries require non-empty string virtPath and backingPath");return 0;}
        read_only=owc_json_object_get(entry,"readOnly");
        if(read_only&&read_only->type!=OWC_JSON_BOOL){(void)snprintf(err,err_size,"sandbox.bindLinks readOnly must be a boolean");return 0;}
        session->bind_virt[session->bind_count]=copy_text(virt);
        session->bind_backing[session->bind_count]=copy_text(backing);
        if(!session->bind_virt[session->bind_count]||!session->bind_backing[session->bind_count]){(void)snprintf(err,err_size,"out of memory");return 0;}
        session->bind_read_only[session->bind_count]=read_only?read_only->value.boolean:0;
        session->bind_count++;
    }
    return 1;
}
/* virtPath must stay inside the session write roots (write permission check,
 * so denyPaths keep priority) and backingPath must be an existing directory.
 * The roots are parsed before this runs. */
static int validate_bind_links(session_config *session,char *err,size_t err_size){
    size_t i;
    for(i=0;i<session->bind_count;i++){
        if(!session_path_check(session,session->bind_virt[i],OWC_PATH_WRITE)){(void)snprintf(err,err_size,"bind link virtPath must stay within the session write roots and outside denyPaths");return 0;}
        if(!owc_bindlink_is_directory(session->bind_backing[i])){(void)snprintf(err,err_size,"bind link backingPath must be an existing directory");return 0;}
    }
    return 1;
}
/* sandbox.proxyAddr lexical shape: a "host:port" token - non-empty, at most
 * 128 bytes, contains a colon, and carries no whitespace or control
 * characters.  Whether anything listens there is the sidecar's concern. */
static int valid_proxy_addr(const char *value){size_t i,n;int colon=0;if(!value)return 0;n=strlen(value);if(!n||n>128)return 0;for(i=0;i<n;i++){unsigned char c=(unsigned char)value[i];if(c<=' '||c==0x7f)return 0;if(c==':')colon=1;}return colon;}
static int configure_policy(session_config *session,const owc_json *sandbox,char *err,size_t err_size){const owc_json *denies,*allows,*reads,*writes,*enabled,*network,*mode,*job_memory,*job_processes;if(!session)return 0;session->sandbox_enabled=1;session->allow_network=1;session->sandbox_mode=(int)OWC_SANDBOX_MODE_APPCONTAINER;session->job_memory_mb=OWC_JOB_DEFAULT_MEMORY_MB;session->job_max_processes=OWC_JOB_DEFAULT_MAX_PROCESSES;if(!sandbox)return (session->read_roots[session->read_root_count++]=copy_text(session->cwd))!=NULL&&(session->write_roots[session->write_root_count++]=copy_text(session->cwd))!=NULL;if(sandbox->type!=OWC_JSON_OBJECT)return 0;{static const char *sandbox_keys[]={"enabled","network","mode","jobMemoryMB","jobMaxProcesses","allowPaths","denyPaths","readRoots","writeRoots","bindLinks","proxyAddr","readOnlyPaths"};if(!allowed_keys(sandbox,sandbox_keys,sizeof(sandbox_keys)/sizeof(sandbox_keys[0]))){(void)snprintf(err,err_size,"sandbox contains unknown fields");return 0;}}enabled=owc_json_object_get(sandbox,"enabled");network=owc_json_object_get(sandbox,"network");mode=owc_json_object_get(sandbox,"mode");if(enabled){if(enabled->type!=OWC_JSON_BOOL)return 0;session->sandbox_enabled=enabled->value.boolean;}if(network){const char *value=owc_json_get_string(network);if(!value||(strcmp(value,"allow")&&strcmp(value,"deny")&&strcmp(value,"filtered")))return 0;if(!strcmp(value,"filtered")){
#ifndef _WIN32
 (void)snprintf(err,err_size,"network \"filtered\" is only supported on Windows");return 0;
#else
 /* Filtered: the business executions get no network capability at all and
    reach the network only through the in-sandbox proxy sidecar, which runs
    with a per-exec network "allow" override inside the shared profile. */
 session->allow_network=0;session->network_filtered=1;
#endif
 }else session->allow_network=!strcmp(value,"allow");}if(mode){const char *value=owc_json_get_string(mode);if(!value)return 0;if(!strcmp(value,"appcontainer"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_APPCONTAINER;else if(!strcmp(value,"jobobject"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_JOBOBJECT;else if(!strcmp(value,"off"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_OFF;else if(!strcmp(value,"landlock")||!strcmp(value,"bubblewrap")){
#ifdef _WIN32
 (void)snprintf(err,err_size,"sandbox mode \"%s\" is only supported on POSIX builds",value);return 0;
#else
 session->sandbox_mode=!strcmp(value,"landlock")?(int)OWC_SANDBOX_MODE_LANDLOCK:(int)OWC_SANDBOX_MODE_BUBBLEWRAP;
#endif
}else return 0;/* POSIX accepts but ignores the Windows appcontainer/jobobject values: both select the default backend (bubblewrap preferred, Landlock fallback). */if(session->sandbox_mode==(int)OWC_SANDBOX_MODE_OFF)session->sandbox_enabled=0;}job_memory=owc_json_object_get(sandbox,"jobMemoryMB");if(job_memory&&!parse_job_limit(job_memory,1048576ul,&session->job_memory_mb))return 0;job_processes=owc_json_object_get(sandbox,"jobMaxProcesses");if(job_processes&&!parse_job_limit(job_processes,4096ul,&session->job_max_processes))return 0;allows=owc_json_object_get(sandbox,"allowPaths");denies=owc_json_object_get(sandbox,"denyPaths");reads=owc_json_object_get(sandbox,"readRoots");writes=owc_json_object_get(sandbox,"writeRoots");if(!reads){session->read_roots[session->read_root_count++]=copy_text(session->cwd);if(!session->read_roots[0])return 0;}if(!writes){session->write_roots[session->write_root_count++]=copy_text(session->cwd);if(!session->write_roots[0])return 0;}if(!copy_string_array(allows,session->allow_paths,&session->allow_count)||!copy_string_array(denies,session->deny_paths,&session->deny_count)||!copy_string_array(reads,session->read_roots,&session->read_root_count)||!copy_string_array(writes,session->write_roots,&session->write_root_count))return 0;{const owc_json *proxy=owc_json_object_get(sandbox,"proxyAddr");const char *proxy_value=proxy?owc_json_get_string(proxy):NULL;if(proxy&&!valid_proxy_addr(proxy_value)){(void)snprintf(err,err_size,"sandbox.proxyAddr must be a \"host:port\" string of at most 128 bytes without whitespace");return 0;}if(proxy_value)(void)snprintf(session->proxy_addr,sizeof(session->proxy_addr),"%s",proxy_value);}{const owc_json *read_only=owc_json_object_get(sandbox,"readOnlyPaths");if(read_only){size_t k;if(read_only->type!=OWC_JSON_ARRAY||read_only->value.children.count>16){(void)snprintf(err,err_size,"sandbox.readOnlyPaths must be an array of at most 16 entries");return 0;}for(k=0;k<read_only->value.children.count;k++){const char *entry=owc_json_get_string(read_only->value.children.items[k]);if(!entry||!entry[0]){(void)snprintf(err,err_size,"sandbox.readOnlyPaths entries must be non-empty strings");return 0;}}if(!copy_string_array(read_only,session->read_only_paths,&session->read_only_count))return 0;}}return parse_bind_links(session,owc_json_object_get(sandbox,"bindLinks"),err,err_size);}
/* Build and validate the complete replacement before touching the live slot.
 * Failed configurations therefore preserve an existing session and cannot
 * consume one of the bounded session slots.  Bind link creation failures are
 * the one exception: the previous links were already removed (a rebuilt
 * virtPath cannot be created while the old link exists), so the stale slot is
 * dropped instead of describing links that no longer exist. */
static int configure_session(const char *id,const char *cwd,const owc_json *sandbox,char *err,size_t err_size,int *code){
    session_config candidate;size_t i;
    memset(&candidate,0,sizeof(candidate));
    candidate.session_id=copy_text(id);candidate.cwd=copy_text(cwd);
    if(!candidate.session_id||!candidate.cwd){clear_session_config(&candidate);(void)snprintf(err,err_size,"out of memory");*code=-32000;return 0;}
    if(!configure_policy(&candidate,sandbox,err,err_size)){if(!err[0]){(void)snprintf(err,err_size,"failed to configure session");*code=-32000;}else *code=-32602;clear_session_config(&candidate);return 0;}
    if(!validate_bind_links(&candidate,err,err_size)){*code=-32602;clear_session_config(&candidate);return 0;}
    if(candidate.bind_count&&!owc_bindlink_supported()){(void)snprintf(err,err_size,"bind_link_unavailable: the Bind Link API (bindlink.dll / bindfltapi.dll) is not present on this system");*code=-32000;clear_session_config(&candidate);return 0;}
    for(i=0;i<session_count;i++)if(!strcmp(sessions[i].session_id,id))break;
    if(i==session_count&&session_count>=sizeof(sessions)/sizeof(sessions[0])){clear_session_config(&candidate);(void)snprintf(err,err_size,"failed to configure session");*code=-32000;return 0;}
    if(i<session_count){remove_session_watches(id);remove_session_ptys(id);remove_session_bind_links(&sessions[i]);sessions[i].bind_count=0;}
    if(candidate.bind_count){size_t created=0;for(;created<candidate.bind_count;created++){char link_err[160];if(!owc_bindlink_create(candidate.bind_virt[created],candidate.bind_backing[created],candidate.bind_read_only[created],link_err,sizeof(link_err))){while(created)owc_bindlink_remove(candidate.bind_virt[--created]);(void)snprintf(err,err_size,"bind_link_unavailable: %s",link_err);*code=-32000;clear_session_config(&candidate);if(i<session_count){size_t last=session_count-1;clear_session_config(&sessions[i]);if(i!=last)sessions[i]=sessions[last];memset(&sessions[last],0,sizeof(sessions[last]));session_count--;}return 0;}}}
#ifdef _WIN32
    /* A filtered session holds one fixed AppContainer profile plus its ACL
       grants for the whole session (shared with the proxy sidecar).  A
       reconfigure away from filtered revokes the old grant first; a grant
       failure keeps the previous session slot (the old grant itself is
       already revoked by the idempotent re-grant, matching the bindLinks
       failure precedent). */
    if(i<session_count&&sessions[i].network_filtered&&!candidate.network_filtered)owc_sandbox_session_revoke(id);
    if(candidate.network_filtered){
        owc_sandbox_options grant_options;const char *grant_writes[32];size_t grant_write_count=0,g;char grant_reason[192];
        memset(&grant_options,0,sizeof(grant_options));
        /* The shared profile must carry both network capabilities even
           though business executions request none: a process can only claim
           capabilities its profile was created with, and a zero-capability
           profile silently drops every request.  The sidecar claims
           internetClient + privateNetworkClientServer through its per-exec
           allow override; the grant object itself never spawns a process. */
        grant_options.allow_network=1;grant_options.private_network=1;
        /* allowPaths are configured write roots too: with per-command grants
           skipped under the shared profile, the session grant must cover
           them or filtered sessions would silently lose that write tier. */
        for(g=0;g<candidate.write_root_count;g++)grant_writes[grant_write_count++]=candidate.write_roots[g];
        for(g=0;g<candidate.allow_count;g++)grant_writes[grant_write_count++]=candidate.allow_paths[g];
        grant_options.session_id=id;
        grant_options.write_roots=grant_writes;grant_options.write_root_count=grant_write_count;
        grant_options.read_only_paths=(const char *const *)candidate.read_only_paths;grant_options.read_only_count=candidate.read_only_count;
        grant_options.bind_backing=(const char *const *)candidate.bind_backing;grant_options.bind_read_only=(const int *)candidate.bind_read_only;grant_options.bind_count=candidate.bind_count;
        if(!owc_sandbox_session_grant(id,&grant_options,grant_reason,sizeof(grant_reason))){(void)snprintf(err,err_size,"%s",grant_reason);*code=-32000;clear_session_config(&candidate);return 0;}
    }
#endif
    if(i<session_count){clear_session_config(&sessions[i]);sessions[i]=candidate;}else sessions[session_count++]=candidate;return 1;
}
static int cleanup_session(const char *id){size_t i;remove_session_watches(id);remove_session_ptys(id);cancel_session_jobs(id);for(i=0;i<session_count;i++)if(!strcmp(sessions[i].session_id,id)){size_t last=session_count-1;
#ifdef _WIN32
 if(sessions[i].network_filtered)owc_sandbox_session_revoke(id);
#endif
 clear_session_config(&sessions[i]);if(i!=last)sessions[i]=sessions[last];memset(&sessions[last],0,sizeof(sessions[last]));session_count--;return 1;}return 0;}
/* Process exit path: undo every bind link and filtered-session AppContainer
 * grant still owned by a session.  Bind links are system-wide and survive
 * this process otherwise (until reboot); the session profiles and their ACL
 * grants would likewise outlive the process. */
void owc_rpc_release_sessions(void){size_t i;
#ifdef _WIN32
 owc_sandbox_session_revoke_all();
#endif
 for(i=0;i<session_count;i++){remove_session_bind_links(&sessions[i]);sessions[i].bind_count=0;}}

#ifndef _WIN32
/* The backend a POSIX session will actually run under: an explicit landlock
 * mode forces Landlock; every other mode prefers bubblewrap and reports its
 * probe when usable, else the Landlock probe (the exec/pty children fall
 * back the same way).  The bwrap probe is one-shot cached, so this is cheap. */
static void session_posix_capability(const session_config *session,owc_sandbox_result *probe){if(session->sandbox_mode!=(int)OWC_SANDBOX_MODE_LANDLOCK){owc_bwrap_probe(probe);if(probe->status==OWC_SANDBOX_ENFORCED)return;}owc_landlock_probe(session->allow_network,probe);}
#endif
static int reply_session_capability(owc_rpc *rpc,const owc_json *id,const char *sid){session_config *session=session_find(sid);char reason[192],detail[192];char *escaped,*escaped_detail=NULL;owc_sandbox_status status;int ok;char result[4096];if(!session)return reply_error(rpc,id,-32000,"session was not configured");detail[0]='\0';if(!session->sandbox_enabled){status=OWC_SANDBOX_ADVISORY;(void)snprintf(reason,sizeof(reason),"sandbox disabled by session policy");}else if(session->sandbox_mode==(int)OWC_SANDBOX_MODE_JOBOBJECT){
#ifdef _WIN32
 status=OWC_SANDBOX_PARTIAL;(void)snprintf(reason,sizeof(reason),"Job Object compatibility mode requested by session policy");(void)snprintf(detail,sizeof(detail),"Job Object limits active processes to %lu and committed memory to %lu MB; no filesystem or network isolation (requires AppContainer)",session->job_max_processes,session->job_memory_mb);
#else
 /* POSIX ignores the requested Windows mode, so report the real backend
  * capability instead of the Windows Job Object wording. */
 {owc_sandbox_result probe;session_posix_capability(session,&probe);status=probe.status;(void)snprintf(reason,sizeof(reason),"%s",probe.reason);}
#endif
}else if(session->network_filtered){
 /* Only reachable on Windows (POSIX rejects "filtered" at configure): the
    session grant succeeded or configure would have failed, so the fixed
    profile is in place and business executions run capability-less behind
    the in-sandbox proxy. */
 status=OWC_SANDBOX_ENFORCED;(void)snprintf(reason,sizeof(reason),"AppContainer enforced; network filtered via in-sandbox proxy");if(session->proxy_addr[0])(void)snprintf(detail,sizeof(detail),"network filtered; in-sandbox proxy at %s",session->proxy_addr);
}else{
#ifdef _WIN32
 status=owc_sandbox_probe(reason,sizeof(reason));
#else
 owc_sandbox_result probe;session_posix_capability(session,&probe);status=probe.status;(void)snprintf(reason,sizeof(reason),"%s",probe.reason);
#endif
}escaped=owc_json_escape_string(reason);if(escaped&&detail[0])escaped_detail=owc_json_escape_string(detail);if(!escaped||(detail[0]&&!escaped_detail)){free(escaped);free(escaped_detail);return reply_error(rpc,id,-32000,"failed to encode sandbox capability");}if(escaped_detail)(void)snprintf(result,sizeof(result),"{\"sandboxCapability\":\"%s\",\"sandboxReason\":%s,\"sandboxDetail\":%s}",owc_sandbox_status_name(status),escaped,escaped_detail);else(void)snprintf(result,sizeof(result),"{\"sandboxCapability\":\"%s\",\"sandboxReason\":%s}",owc_sandbox_status_name(status),escaped);free(escaped);free(escaped_detail);ok=reply_result(rpc,id,result);return ok;}

static int fs_code(owc_fs_error e) { if(e==OWC_FS_INVALID_ARGUMENT||e==OWC_FS_INVALID_UTF8||e==OWC_FS_NO_MATCH||e==OWC_FS_MULTIPLE_MATCHES)return -32602;if(e==OWC_FS_OUTSIDE_ROOT||e==OWC_FS_PERMISSION_DENIED)return -32002;if(e==OWC_FS_NOT_FOUND)return -32003;return -32000; }
static int allowed_keys(const owc_json *p,const char *const *keys,size_t count) { size_t i,j;if(!p||p->type!=OWC_JSON_OBJECT)return 0;for(i=0;i<p->value.children.count;i++){const char*k=p->value.children.items[i]->key;for(j=0;j<count;j++)if(!strcmp(k,keys[j]))break;if(j==count)return 0;}return 1; }
static int json_size(const owc_json*v,size_t *n){double d;if(!v||v->type!=OWC_JSON_NUMBER)return 0;d=v->value.number;if(d<0||d>(double)SIZE_MAX||d!=(double)(size_t)d)return 0;*n=(size_t)d;return 1;}
static int json_bool(const owc_json *v,int fallback,int *result){if(!v){*result=fallback;return 1;}if(v->type!=OWC_JSON_BOOL)return 0;*result=v->value.boolean;return 1;}
static const char *type_name(owc_fs_type t){return t==OWC_FS_TYPE_FILE?"file":t==OWC_FS_TYPE_DIRECTORY?"directory":"other";}

static int base64_digit(unsigned char value) {
    if(value>='A'&&value<='Z') return value-'A';
    if(value>='a'&&value<='z') return value-'a'+26;
    if(value>='0'&&value<='9') return value-'0'+52;
    if(value=='+') return 62;
    if(value=='/') return 63;
    return -1;
}

/* Keep binary ingress deliberately narrow: strict conventional base64, a
 * bounded decoded payload, and no implicit text conversion. The server
 * validates PDF magic before it calls this RPC; core repeats the base64 and
 * size validation because the RPC boundary is independently reachable. */
static int base64_decode_bounded(const char *encoded,unsigned char **result,size_t *result_length) {
    size_t input_length,padding=0,output_length,index,at=0;
    unsigned char *decoded=NULL;
    if(!encoded||!result||!result_length) return 0;
    *result=NULL;*result_length=0;
    input_length=strlen(encoded);
    if(!input_length||input_length%4u||input_length>4u*((OWC_FS_MAX_BINARY_FILE_SIZE+2u)/3u)) return 0;
    if(encoded[input_length-1]=='=') {
        padding=1;
        if(input_length>=2u&&encoded[input_length-2]=='=') padding=2;
    }
    output_length=input_length/4u*3u-padding;
    if(!output_length||output_length>OWC_FS_MAX_BINARY_FILE_SIZE) return 0;
    decoded=(unsigned char*)malloc(output_length);
    if(!decoded) return 0;
    for(index=0;index<input_length;index+=4u) {
        int a=base64_digit((unsigned char)encoded[index]);
        int b=base64_digit((unsigned char)encoded[index+1]);
        int c,d;
        int final_group=index+4u==input_length;
        if(a<0||b<0) goto invalid;
        if(encoded[index+2]=='=') {
            if(!final_group||encoded[index+3]!='=') goto invalid;
            c=0;d=0;
            if((b&15)!=0) goto invalid;
        } else {
            c=base64_digit((unsigned char)encoded[index+2]);
            if(c<0) goto invalid;
            if(encoded[index+3]=='=') {
                if(!final_group||(c&3)!=0) goto invalid;
                d=0;
            } else {
                d=base64_digit((unsigned char)encoded[index+3]);
                if(d<0) goto invalid;
            }
        }
        if(at>=output_length) goto invalid;
        decoded[at++]=(unsigned char)((a<<2)|(b>>4));
        if(encoded[index+2]!='=') {
            if(at>=output_length) goto invalid;
            decoded[at++]=(unsigned char)((b<<4)|(c>>2));
            if(encoded[index+3]!='=') {
                if(at>=output_length) goto invalid;
                decoded[at++]=(unsigned char)((c<<6)|d);
            }
        }
    }
    if(at!=output_length) goto invalid;
    *result=decoded;*result_length=output_length;return 1;
invalid:
    free(decoded);return 0;
}

#define OWC_FS_STAT_MANY_MAX_PATHS 128u
#define OWC_FS_STAT_MANY_MAX_PATH_BYTES 4096u
#define OWC_FS_STAT_MANY_MAX_TOTAL_PATH_BYTES (256u * 1024u)
#define OWC_FS_SCAN_DEFAULT_LIMIT 128u
#define OWC_FS_SCAN_MAX_LIMIT 256u
#define OWC_FS_SCAN_DEFAULT_DEPTH 8u
#define OWC_FS_SCAN_MAX_DEPTH 16u
#define OWC_FS_SCAN_MAX_NODES 2048u

/* path.normalize: pure lexical normalization plus policy verdict, no IO.
 * Lets the Node layer key permission rules and pre-map WSB paths on the
 * exact canonical form the fs primitives will use, instead of re-implementing
 * path handling outside C. */
static int handle_path_normalize(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"sessionId","path","purpose"};
    const char *session_id,*path,*purpose;
    session_config *session;
    owc_path_permission permission=OWC_PATH_READ;
    char *canonical,*escaped_path,*escaped_root,*result;
    int allowed,needed;
    if(!allowed_keys(p,keys,3))return reply_error(rpc,id,-32602,"path.normalize contains unknown fields");
    session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));
    path=owc_json_get_string(owc_json_object_get(p,"path"));
    purpose=owc_json_get_string(owc_json_object_get(p,"purpose"));
    if(purpose){if(!strcmp(purpose,"write"))permission=OWC_PATH_WRITE;else if(strcmp(purpose,"read"))return reply_error(rpc,id,-32602,"purpose must be read or write");}
    session=session_id?session_find(session_id):NULL;
    if(!session||!path||!path[0])return reply_error(rpc,id,-32602,"path.normalize requires a configured sessionId and a non-empty path");
    canonical=session_policy_path(session->cwd,path);
    if(!canonical)return reply_error(rpc,id,-32602,"path cannot be normalized (relative traversal, drive-relative, or UNC form)");
    allowed=session_path_check(session,path,permission);
    escaped_path=owc_json_escape_string(canonical);
    escaped_root=owc_json_escape_string(session->cwd);
    if(!escaped_path||!escaped_root){free(canonical);free(escaped_path);free(escaped_root);return reply_error(rpc,id,-32000,"out of memory");}
    needed=snprintf(NULL,0,"{\"path\":%s,\"allowed\":%s,\"root\":%s%s}",escaped_path,allowed?"true":"false",escaped_root,allowed?"":",\"reason\":\"path is denied by session policy\"");
    result=(char*)malloc((size_t)needed+1);
    if(result)(void)snprintf(result,(size_t)needed+1,"{\"path\":%s,\"allowed\":%s,\"root\":%s%s}",escaped_path,allowed?"true":"false",escaped_root,allowed?"":",\"reason\":\"path is denied by session policy\"");
    free(canonical);free(escaped_path);free(escaped_root);
    if(!result)return reply_error(rpc,id,-32000,"out of memory");
    needed=reply_result(rpc,id,result);free(result);return needed;
}

static int handle_fs_stat_many(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"sessionId","paths"};
    const char *session_id,*cwd;
    const owc_json *paths;
    char *result;
    size_t i,total_path_bytes=0;
    if(!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"fs.statMany contains unknown fields");
    session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));
    paths=owc_json_object_get(p,"paths");
    cwd=session_id?session_root(session_id):NULL;
    if(!cwd||!paths||paths->type!=OWC_JSON_ARRAY||!paths->value.children.count||paths->value.children.count>OWC_FS_STAT_MANY_MAX_PATHS)return reply_error(rpc,id,-32602,"fs.statMany requires a configured sessionId and 1 to 128 paths");
    result=(char*)malloc(13);if(!result)return reply_error(rpc,id,-32000,"out of memory");strcpy(result,"{\"entries\":[");
    for(i=0;i<paths->value.children.count;i++){
        const char *path=owc_json_get_string(paths->value.children.items[i]);
        owc_fs_stat_result stat;
        owc_fs_error error;
        char *escaped,*grown;
        size_t used,add;
        if(!path||!path[0]||strlen(path)>OWC_FS_STAT_MANY_MAX_PATH_BYTES||(total_path_bytes+=strlen(path))>OWC_FS_STAT_MANY_MAX_TOTAL_PATH_BYTES){free(result);return reply_error(rpc,id,-32602,"fs.statMany paths must be non-empty strings within the request budget");}
        if(!session_path_allowed(session_id,path,OWC_PATH_READ)){free(result);return reply_error(rpc,id,-32002,"path is denied by session policy");}
        error=owc_fs_stat(cwd,path,&stat);if(error){free(result);return reply_error(rpc,id,fs_code(error),owc_fs_error_message(error));}
        escaped=owc_json_escape_string(path);if(!escaped){free(result);return reply_error(rpc,id,-32000,"out of memory");}
        used=strlen(result);add=(size_t)snprintf(NULL,0,"%s{\"path\":%s,\"type\":\"%s\",\"size\":%llu,\"modifiedMs\":%lld}",i?",":"",escaped,type_name(stat.type),stat.size,stat.modified_ms);
        grown=(char*)realloc(result,used+add+3);if(!grown){free(escaped);free(result);return reply_error(rpc,id,-32000,"out of memory");}result=grown;
        snprintf(result+used,add+1,"%s{\"path\":%s,\"type\":\"%s\",\"size\":%llu,\"modifiedMs\":%lld}",i?",":"",escaped,type_name(stat.type),stat.size,stat.modified_ms);free(escaped);
    }
    strcat(result,"]}");i=reply_result(rpc,id,result);free(result);return (int)i;
}

/* fs.scan deliberately stays at the Core boundary: every directory read goes
 * through the existing root-bound/no-follow list primitive.  The result is
 * collected under fixed traversal budgets, sorted by UTF-8 byte path for a
 * stable integer cursor, and only then paged. */
typedef struct { char *path; owc_fs_type type; unsigned long long size; } fs_scan_item;
typedef struct { char *relative; size_t depth; } fs_scan_directory;
typedef struct { fs_scan_item *items; size_t count,capacity,nodes; int budget_truncated,depth_truncated,list_truncated; } fs_scan_collection;
static char *scan_join(const char *left,const char *right){size_t a=strlen(left),b=strlen(right),offset=a;char *joined=(char*)malloc(a+b+2);if(!joined)return NULL;if(a){memcpy(joined,left,a);joined[offset++]='/';}memcpy(joined+offset,right,b+1);return joined;}
static void scan_free(fs_scan_collection *scan){size_t i;if(!scan)return;for(i=0;i<scan->count;i++)free(scan->items[i].path);free(scan->items);memset(scan,0,sizeof(*scan));}
static int scan_add_item(fs_scan_collection *scan,char *path,owc_fs_type type,unsigned long long size){fs_scan_item *grown;if(scan->count==scan->capacity){size_t cap=scan->capacity?scan->capacity*2u:128u;grown=(fs_scan_item*)realloc(scan->items,cap*sizeof(*grown));if(!grown)return 0;scan->items=grown;scan->capacity=cap;}scan->items[scan->count].path=path;scan->items[scan->count].type=type;scan->items[scan->count].size=size;scan->count++;return 1;}
static int scan_compare(const void *left,const void *right){const fs_scan_item *a=(const fs_scan_item*)left,*b=(const fs_scan_item*)right;return strcmp(a->path,b->path);}
static int scan_push_directory(fs_scan_directory **stack,size_t *count,size_t *capacity,char *relative,size_t depth){fs_scan_directory *grown;if(*count==*capacity){size_t cap=*capacity?*capacity*2u:32u;grown=(fs_scan_directory*)realloc(*stack,cap*sizeof(*grown));if(!grown)return 0;*stack=grown;*capacity=cap;}(*stack)[*count].relative=relative;(*stack)[*count].depth=depth;(*count)++;return 1;}

static owc_fs_error scan_collect(const char *root,const char *session_id,const char *base,size_t max_depth,fs_scan_collection *scan){
    fs_scan_directory *stack=NULL;size_t stack_count=0,stack_capacity=0;owc_fs_error error=OWC_FS_OK;
    memset(scan,0,sizeof(*scan));
    if(!scan_push_directory(&stack,&stack_count,&stack_capacity,copy_text(""),0)){free(stack);return OWC_FS_NO_MEMORY;}
    if(!stack[0].relative){free(stack);return OWC_FS_NO_MEMORY;}
    while(stack_count&&error==OWC_FS_OK&&!scan->budget_truncated){
        fs_scan_directory directory=stack[--stack_count];owc_fs_list_result list;char *full=directory.relative[0]?scan_join(base,directory.relative):copy_text(base);size_t i;
        if(!full){free(directory.relative);error=OWC_FS_NO_MEMORY;break;}
        error=owc_fs_list(root,full,&list);free(full);
        /* Skip protected subdirectories (for example System Volume Information)
         * rather than failing the entire scan. The initial directory (depth 0)
         * still reports errors so callers learn about inaccessible roots. */
        if(error&&directory.depth>0&&(error==OWC_FS_PERMISSION_DENIED||error==OWC_FS_NOT_FOUND)){
            free(directory.relative);
            error=OWC_FS_OK;
            continue;
        }
        if(error){free(directory.relative);break;}
        if(list.truncated)scan->list_truncated=1;
        for(i=0;i<list.count;i++){
            char *child;
            if(scan->nodes++>=OWC_FS_SCAN_MAX_NODES){scan->budget_truncated=1;break;}
            child=directory.relative[0]?scan_join(directory.relative,list.entries[i].name):copy_text(list.entries[i].name);
            if(!child){error=OWC_FS_NO_MEMORY;break;}
            /* A denied directory is neither returned nor traversed. The
             * result path is relative to base, while policy paths are rooted
             * at the session workspace, so check the full request-relative
             * path. */
            {char *policy_path=!strcmp(base,".")?copy_text(child):scan_join(base,child);int denied=!policy_path||!session_path_allowed(session_id,policy_path,OWC_PATH_READ);free(policy_path);if(denied){free(child);continue;}}
            /* Directory metadata sizes vary by filesystem (for example 0 on
             * NTFS and 4096 on ext4).  fs.scan reports content sizes, so make
             * directory entries deterministic across platforms. */
            if(!scan_add_item(scan,child,list.entries[i].type,list.entries[i].type==OWC_FS_TYPE_DIRECTORY?0:list.entries[i].size)){free(child);error=OWC_FS_NO_MEMORY;break;}
            if(list.entries[i].type==OWC_FS_TYPE_DIRECTORY){
                if(directory.depth>=max_depth)scan->depth_truncated=1;
                else {char *next=copy_text(child);if(!next||!scan_push_directory(&stack,&stack_count,&stack_capacity,next,directory.depth+1)){free(next);error=OWC_FS_NO_MEMORY;break;}}
            }
        }
        owc_fs_list_free(&list);free(directory.relative);
    }
    while(stack_count)free(stack[--stack_count].relative);
    free(stack);
    if(error){scan_free(scan);return error;}
    qsort(scan->items,scan->count,sizeof(*scan->items),scan_compare);return OWC_FS_OK;
}

static int handle_fs_scan(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"sessionId","path","cursor","limit","maxDepth"};
    const char *session_id,*cwd,*path;const owc_json *value;size_t cursor=0,limit=OWC_FS_SCAN_DEFAULT_LIMIT,max_depth=OWC_FS_SCAN_DEFAULT_DEPTH,end,i;fs_scan_collection scan;owc_fs_error error;char *result;
    if(!allowed_keys(p,keys,5))return reply_error(rpc,id,-32602,"fs.scan contains unknown fields");
    session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));path=owc_json_get_string(owc_json_object_get(p,"path"));cwd=session_id?session_root(session_id):NULL;
    if(!cwd||!path||!path[0])return reply_error(rpc,id,-32602,"fs.scan requires a configured sessionId and non-empty path");
    if(!session_path_allowed(session_id,path,OWC_PATH_READ))return reply_error(rpc,id,-32002,"path is denied by session policy");
    value=owc_json_object_get(p,"cursor");if(value&&(!json_size(value,&cursor)||cursor>OWC_FS_SCAN_MAX_NODES))return reply_error(rpc,id,-32602,"fs.scan cursor must be a non-negative integer within the scan budget");
    value=owc_json_object_get(p,"limit");if(value&&(!json_size(value,&limit)||!limit||limit>OWC_FS_SCAN_MAX_LIMIT))return reply_error(rpc,id,-32602,"fs.scan limit must be an integer from 1 to 256");
    value=owc_json_object_get(p,"maxDepth");if(value&&(!json_size(value,&max_depth)||max_depth>OWC_FS_SCAN_MAX_DEPTH))return reply_error(rpc,id,-32602,"fs.scan maxDepth must be an integer from 0 to 16");
    error=scan_collect(cwd,session_id,path,max_depth,&scan);if(error)return reply_error(rpc,id,fs_code(error),owc_fs_error_message(error));
    end=cursor>scan.count?cursor:scan.count-cursor<limit?scan.count:cursor+limit;
    result=(char*)malloc(13);if(!result){scan_free(&scan);return reply_error(rpc,id,-32000,"out of memory");}strcpy(result,"{\"entries\":[");
    for(i=cursor;i<end;i++){char *escaped=owc_json_escape_string(scan.items[i].path),*grown;size_t used,add;if(!escaped){free(result);scan_free(&scan);return reply_error(rpc,id,-32000,"out of memory");}used=strlen(result);add=(size_t)snprintf(NULL,0,"%s{\"path\":%s,\"type\":\"%s\",\"size\":%llu}",i==cursor?"":",",escaped,type_name(scan.items[i].type),scan.items[i].size);grown=(char*)realloc(result,used+add+64);if(!grown){free(escaped);free(result);scan_free(&scan);return reply_error(rpc,id,-32000,"out of memory");}result=grown;snprintf(result+used,add+1,"%s{\"path\":%s,\"type\":\"%s\",\"size\":%llu}",i==cursor?"":",",escaped,type_name(scan.items[i].type),scan.items[i].size);free(escaped);}
    i=strlen(result);if(end<scan.count)snprintf(result+i,64,"],\"nextCursor\":%zu,\"truncated\":%s}",end,(scan.budget_truncated||scan.depth_truncated||scan.list_truncated)?"true":"false");else snprintf(result+i,48,"],\"truncated\":%s}",(scan.budget_truncated||scan.depth_truncated||scan.list_truncated)?"true":"false");
    scan_free(&scan);i=reply_result(rpc,id,result);free(result);return (int)i;
}

#define OWC_FS_MAX_WATCHES 16u
#define OWC_FS_WATCH_MAX_EVENTS 128u
/* Burst folding threshold: a single directory contributing this many events
 * in one poll batch collapses into one directory-level "changed" event. */
#define OWC_FS_WATCH_FOLD_MIN 4u
typedef struct { unsigned id; char *session_id,*base; owc_fs_watch *watch; } fs_watch_record;
static fs_watch_record fs_watches[OWC_FS_MAX_WATCHES];
static unsigned next_watch_id=1;
static void clear_watch(fs_watch_record *record){if(!record)return;owc_fs_watch_close(record->watch);free(record->session_id);free(record->base);memset(record,0,sizeof(*record));}
static void remove_session_watches(const char *session_id){size_t i;for(i=0;i<OWC_FS_MAX_WATCHES;i++)if(fs_watches[i].watch&&!strcmp(fs_watches[i].session_id,session_id))clear_watch(&fs_watches[i]);}
static fs_watch_record *find_watch(const char *session_id,unsigned id){size_t i;for(i=0;i<OWC_FS_MAX_WATCHES;i++)if(fs_watches[i].watch&&fs_watches[i].id==id&&!strcmp(fs_watches[i].session_id,session_id))return &fs_watches[i];return NULL;}
static char *watch_policy_path(const char *base,const char *relative){return !strcmp(base,".")?copy_text(relative):scan_join(base,relative);}
static int watch_is_internal_temp(const char *path){const char *name=strrchr(path,'/');size_t length=strlen(path);name=name?name+1:path;return name[0]=='.'&&strstr(name,".owc-")&&length>=4&&!strcmp(path+length-4,".tmp");}

static int handle_fs_watch_start(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"sessionId","path","recursive"};const char *session_id,*cwd,*path;int recursive=0;size_t i;owc_fs_error error;
    if(!allowed_keys(p,keys,3))return reply_error(rpc,id,-32602,"fs.watch contains unknown fields");
    session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));path=owc_json_get_string(owc_json_object_get(p,"path"));cwd=session_id?session_root(session_id):NULL;
    if(!cwd||!path||!path[0])return reply_error(rpc,id,-32602,"fs.watch requires a configured sessionId and non-empty path");
    if(!json_bool(owc_json_object_get(p,"recursive"),0,&recursive))return reply_error(rpc,id,-32602,"fs.watch recursive must be a boolean");
    if(!session_path_allowed(session_id,path,OWC_PATH_READ))return reply_error(rpc,id,-32002,"path is denied by session policy");
    for(i=0;i<OWC_FS_MAX_WATCHES;i++)if(!fs_watches[i].watch)break;
    if(i==OWC_FS_MAX_WATCHES)return reply_error(rpc,id,-32000,"watch limit reached");
    error=owc_fs_watch_open(cwd,path,recursive,&fs_watches[i].watch);if(error)return reply_error(rpc,id,fs_code(error),owc_fs_error_message(error));fs_watches[i].session_id=copy_text(session_id);fs_watches[i].base=copy_text(path);if(!fs_watches[i].session_id||!fs_watches[i].base){clear_watch(&fs_watches[i]);return reply_error(rpc,id,-32000,"out of memory");}fs_watches[i].id=next_watch_id++;if(!next_watch_id)next_watch_id=1;{char result[64];snprintf(result,sizeof(result),"{\"watchId\":%u}",fs_watches[i].id);return reply_result(rpc,id,result);}
}

static int handle_fs_watch_poll(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"sessionId","watchId","limit"};const char *session_id;const owc_json *value;size_t limit=OWC_FS_WATCH_MAX_EVENTS,i,j;unsigned watch_id;fs_watch_record *record;owc_fs_watch_result events;owc_fs_error error;char *result;
    if(!allowed_keys(p,keys,3))return reply_error(rpc,id,-32602,"fs.watch.poll contains unknown fields");
    session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));value=owc_json_object_get(p,"watchId");
    if(!session_id||!value||!json_size(value,&i)||!i||i>UINT_MAX)return reply_error(rpc,id,-32602,"fs.watch.poll requires sessionId and positive watchId");
    watch_id=(unsigned)i;value=owc_json_object_get(p,"limit");
    if(value&&(!json_size(value,&limit)||!limit||limit>OWC_FS_WATCH_MAX_EVENTS))return reply_error(rpc,id,-32602,"fs.watch.poll limit must be an integer from 1 to 128");
    record=find_watch(session_id,watch_id);if(!record)return reply_error(rpc,id,-32003,"watch not found");
    error=owc_fs_watch_poll(record->watch,limit,&events);if(error)return reply_error(rpc,id,fs_code(error),owc_fs_error_message(error));
    /* Hide policy-denied descendants and merge repeated path events from the
     * same kernel batch so a busy editor cannot amplify RPC/event traffic. */
    for(i=0;i<events.count;){char *policy_path=watch_policy_path(record->base,events.events[i].path);int denied=!policy_path||!session_path_allowed(session_id,policy_path,OWC_PATH_READ);free(policy_path);if(denied||watch_is_internal_temp(events.events[i].path)){free(events.events[i].path);events.count--;if(i!=events.count)events.events[i]=events.events[events.count];continue;}for(j=0;j<i;j++)if(!strcmp(events.events[j].path,events.events[i].path)){free(events.events[j].path);events.events[j]=events.events[i];events.count--;if(i!=events.count)events.events[i]=events.events[events.count];break;}if(j==i)i++;}
    /* Burst folding (for example a build directory rewriting many files
     * between polls): collapse directories with many same-batch events into
     * one directory-level "changed" event. The parent of a root-level path is
     * the watched root itself (""). Folding can repeat upwards when several
     * folded siblings share a parent; each pass strictly shrinks the batch,
     * so it terminates. */
    for(i=0;i<events.count;){
        char *slash=strrchr(events.events[i].path,'/');size_t parent_length=slash?(size_t)(slash-events.events[i].path):0;size_t same=0;
        for(j=0;j<events.count;j++){char *other=strrchr(events.events[j].path,'/');size_t other_length=other?(size_t)(other-events.events[j].path):0;if(other_length==parent_length&&!strncmp(events.events[j].path,events.events[i].path,parent_length))same++;}
        if(same<OWC_FS_WATCH_FOLD_MIN){i++;continue;}
        {char *directory=(char*)malloc(parent_length+1);owc_fs_watch_event *grown;
        if(!directory){owc_fs_watch_result_free(&events);return reply_error(rpc,id,-32000,"out of memory");}
        memcpy(directory,events.events[i].path,parent_length);directory[parent_length]='\0';
        for(j=0;j<events.count;){char *other=strrchr(events.events[j].path,'/');size_t other_length=other?(size_t)(other-events.events[j].path):0;if(other_length==parent_length&&!strncmp(events.events[j].path,directory,parent_length)){free(events.events[j].path);events.count--;if(j!=events.count)events.events[j]=events.events[events.count];}else j++;}
        grown=(owc_fs_watch_event*)realloc(events.events,(events.count+1)*sizeof(*grown));
        if(!grown){free(directory);owc_fs_watch_result_free(&events);return reply_error(rpc,id,-32000,"out of memory");}
        events.events=grown;events.events[events.count].path=directory;events.events[events.count].kind="changed";events.count++;}
    }
    result=(char*)malloc(12);if(!result){owc_fs_watch_result_free(&events);return reply_error(rpc,id,-32000,"out of memory");}strcpy(result,"{\"events\":[");for(i=0;i<events.count;i++){char *path=owc_json_escape_string(events.events[i].path),*grown;size_t used,add;if(!path){free(result);owc_fs_watch_result_free(&events);return reply_error(rpc,id,-32000,"out of memory");}used=strlen(result);add=(size_t)snprintf(NULL,0,"%s{\"path\":%s,\"kind\":\"%s\"}",i?",":"",path,events.events[i].kind);grown=(char*)realloc(result,used+add+48);if(!grown){free(path);free(result);owc_fs_watch_result_free(&events);return reply_error(rpc,id,-32000,"out of memory");}result=grown;snprintf(result+used,add+1,"%s{\"path\":%s,\"kind\":\"%s\"}",i?",":"",path,events.events[i].kind);free(path);}i=strlen(result);snprintf(result+i,48,"],\"overflow\":%s}",events.overflow?"true":"false");owc_fs_watch_result_free(&events);i=reply_result(rpc,id,result);free(result);return (int)i;
}

static int handle_fs_watch_cancel(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"sessionId","watchId"};const char *session_id;const owc_json *value;size_t number;if(!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"fs.watch.cancel contains unknown fields");session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));value=owc_json_object_get(p,"watchId");if(!session_id||!value||!json_size(value,&number)||!number||number>UINT_MAX)return reply_error(rpc,id,-32602,"fs.watch.cancel requires sessionId and positive watchId");{fs_watch_record *record=find_watch(session_id,(unsigned)number);if(!record)return reply_error(rpc,id,-32003,"watch not found");clear_watch(record);}return reply_result(rpc,id,"{\"ok\":true}");
}

#define OWC_JOB_MAX_RUNNING 4u
#define OWC_JOB_OUTPUT_CHUNKS 128u
#define OWC_JOB_OUTPUT_CHUNK_BYTES 4096u
typedef enum { OWC_JOB_EMPTY,OWC_JOB_RUNNING,OWC_JOB_COMPLETED,OWC_JOB_FAILED,OWC_JOB_CANCELLED,OWC_JOB_TIMED_OUT } owc_job_state;
typedef enum { OWC_JOB_EXEC,OWC_JOB_INDEX_SCAN,OWC_JOB_GREP,OWC_JOB_GLOB,OWC_JOB_INDEX_EXTRACT } owc_job_kind;
typedef struct {unsigned sequence;char stream[7];size_t length;unsigned char data[OWC_JOB_OUTPUT_CHUNK_BYTES];} owc_job_chunk;
#define OWC_INDEX_MAX_PATTERNS 64u
typedef struct {char *id,*session,*cmd,*cwd;char *allow_paths[16];size_t allow_path_count;char *bind_backing[16];int bind_read_only[16];size_t bind_count;char *read_roots[16];size_t read_root_count;char *write_roots[16];size_t write_root_count;char *deny_paths[16];size_t deny_path_count;int network_filtered;char proxy_addr[144];char *read_only_paths[16];size_t read_only_count;int sandbox_enabled,allow_network,sandbox_mode,shell_backend;unsigned long memory,processes;int timeout;volatile int cancel;owc_job_state state;owc_job_kind kind;owc_exec_result result;HANDLE thread;owc_job_chunk output[OWC_JOB_OUTPUT_CHUNKS];size_t output_start,output_count;unsigned next_output_sequence;int output_truncated;char *scan_path;char *scan_include[OWC_INDEX_MAX_PATTERNS];size_t scan_include_count;char *scan_exclude[OWC_INDEX_MAX_PATTERNS];size_t scan_exclude_count;unsigned long scan_max_nodes,scan_max_depth;unsigned long long scan_max_bytes;int scan_max_ms;char *search_pattern;char *shell_path;char **extract_files;size_t extract_file_count;unsigned long extract_max_symbols;char *scan_read_roots[16];size_t scan_read_root_count;char *scan_deny_roots[16];size_t scan_deny_root_count;} owc_job;
static owc_job jobs[OWC_JOB_MAX_RUNNING];static CRITICAL_SECTION jobs_mutex;static int jobs_ready=0;
static void jobs_init(void){if(!jobs_ready){InitializeCriticalSection(&jobs_mutex);jobs_ready=1;}}
static void job_free(owc_job *job){size_t i;if(job->thread)CloseHandle(job->thread);free(job->id);free(job->session);free(job->cmd);free(job->cwd);free(job->scan_path);free(job->search_pattern);free(job->shell_path);for(i=0;i<job->allow_path_count;i++)free(job->allow_paths[i]);for(i=0;i<job->bind_count;i++)free(job->bind_backing[i]);for(i=0;i<job->read_root_count;i++)free(job->read_roots[i]);for(i=0;i<job->write_root_count;i++)free(job->write_roots[i]);for(i=0;i<job->deny_path_count;i++)free(job->deny_paths[i]);for(i=0;i<job->read_only_count;i++)free(job->read_only_paths[i]);for(i=0;i<job->scan_include_count;i++)free(job->scan_include[i]);for(i=0;i<job->scan_exclude_count;i++)free(job->scan_exclude[i]);for(i=0;i<job->scan_read_root_count;i++)free(job->scan_read_roots[i]);for(i=0;i<job->scan_deny_root_count;i++)free(job->scan_deny_roots[i]);for(i=0;i<job->extract_file_count;i++)free(job->extract_files[i]);free(job->extract_files);memset(job,0,sizeof(*job));}
static void job_output(void *data,const char *stream,const unsigned char *bytes,size_t length,unsigned sequence){owc_job *job=(owc_job*)data;size_t offset=0;(void)sequence;EnterCriticalSection(&jobs_mutex);while(offset<length){owc_job_chunk *chunk;size_t take=length-offset,index;if(job->output_count==OWC_JOB_OUTPUT_CHUNKS){job->output_start=(job->output_start+1u)%OWC_JOB_OUTPUT_CHUNKS;job->output_count--;job->output_truncated=1;}if(take>OWC_JOB_OUTPUT_CHUNK_BYTES)take=OWC_JOB_OUTPUT_CHUNK_BYTES;index=(job->output_start+job->output_count)%OWC_JOB_OUTPUT_CHUNKS;chunk=&job->output[index];chunk->sequence=++job->next_output_sequence;(void)snprintf(chunk->stream,sizeof(chunk->stream),"%s",stream);memcpy(chunk->data,bytes+offset,take);chunk->length=take;job->output_count++;offset+=take;}LeaveCriticalSection(&jobs_mutex);}
/* ------------------------------------------------------------------ */
/* index.scan: bounded, cancellable workspace file-manifest scan.
 *
 * Traversal reuses the same root-bound/no-follow list primitive and the same
 * session path policy as fs.scan; hashing reuses owc_fs_hash (SHA-256 with
 * the existing 16 MiB per-file read budget). Entries are collected, sorted by
 * UTF-8 path for deterministic output, and only then streamed as JSONL to the
 * job output ring. The scan always reports complete entries; incremental
 * change sets are computed by the Node layer from successive manifests.
 *
 * The worker thread never dereferences the live session_config (cleanup or
 * reconfigure could free it mid-scan); job.start snapshots the read/deny
 * policy roots into the job, and index_path_allowed checks that snapshot.
 * Enumeration-supplied real names cannot carry the 8.3/trailing-dot aliases
 * the platform deny-root re-check exists to catch, and reparse points are
 * rejected structurally by the platform traversal.  The worker still
 * publishes its snapshot into the platform layer's thread-local policy so
 * root opens and parallel file reads cannot inherit another session's roots. */
#define OWC_INDEX_SCAN_DEFAULT_NODES 200000ul
#define OWC_INDEX_SCAN_NODES_LIMIT 1000000ul
#define OWC_INDEX_SCAN_DEFAULT_DEPTH 32ul
#define OWC_INDEX_SCAN_DEPTH_LIMIT 64ul
#define OWC_INDEX_SCAN_DEFAULT_BYTES (1024ull*1024ull*1024ull)
#define OWC_INDEX_SCAN_BYTES_LIMIT (16ull*1024ull*1024ull*1024ull)
#define OWC_INDEX_SCAN_DEFAULT_MS 60000
#define OWC_INDEX_SCAN_MS_LIMIT 600000
#define OWC_INDEX_SCAN_CHECK_INTERVAL 64u

typedef struct { char *path; unsigned long long size; long long modified_ms; char sha256[65]; int hashed; } index_scan_item;
typedef struct { index_scan_item *items; size_t count,capacity,nodes; unsigned long long hashed_bytes; int truncated,halt,hash_truncated; const char *reason; } index_scan_collection;
static void index_scan_free(index_scan_collection *scan){size_t i;if(!scan)return;for(i=0;i<scan->count;i++)free(scan->items[i].path);free(scan->items);memset(scan,0,sizeof(*scan));}
static int index_scan_add(index_scan_collection *scan,char *path,unsigned long long size,long long modified_ms,const char *sha256,int hashed){index_scan_item *grown;if(scan->count==scan->capacity){size_t cap=scan->capacity?scan->capacity*2u:256u;grown=(index_scan_item*)realloc(scan->items,cap*sizeof(*grown));if(!grown)return 0;scan->items=grown;scan->capacity=cap;}scan->items[scan->count].path=path;scan->items[scan->count].size=size;scan->items[scan->count].modified_ms=modified_ms;scan->items[scan->count].hashed=hashed;if(hashed)memcpy(scan->items[scan->count].sha256,sha256,65);else scan->items[scan->count].sha256[0]='\0';scan->count++;return 1;}
static int index_scan_compare(const void *left,const void *right){const index_scan_item *a=(const index_scan_item*)left,*b=(const index_scan_item*)right;return strcmp(a->path,b->path);}
static int index_pattern_match(char **patterns,size_t count,const char *path){size_t i;for(i=0;i<count;i++)if(owc_fs_match_pattern(patterns[i],path))return 1;return 0;}
static int index_scan_halted(owc_job *job,index_scan_collection *scan,unsigned long long deadline){if(job->cancel)return 1;if(monotonic_ms()>=deadline){scan->truncated=1;scan->halt=1;scan->reason="time";return 1;}return 0;}
/* Policy check against the policy snapshot taken at job.start: the worker
 * thread must never dereference the live session_config, because
 * session.cleanup / session.configure can free or rebuild it mid-scan. */
static int index_path_allowed(const owc_job *job,const char *path){owc_path_policy policy;char *canonical;int allowed;canonical=session_policy_path(job->cwd,path);if(!canonical)return 0;memset(&policy,0,sizeof(policy));policy.read_roots=(const char *const *)job->scan_read_roots;policy.read_root_count=job->scan_read_root_count;policy.deny_roots=(const char *const *)job->scan_deny_roots;policy.deny_root_count=job->scan_deny_root_count;allowed=owc_path_policy_check(&policy,canonical,OWC_PATH_READ);free(canonical);return allowed;}

static owc_fs_error index_scan_collect(owc_job *job,index_scan_collection *scan){
    fs_scan_directory *stack=NULL;size_t stack_count=0,stack_capacity=0;owc_fs_error error=OWC_FS_OK;
    unsigned long long deadline=monotonic_ms()+(unsigned long long)job->scan_max_ms;
    const char *base=job->scan_path,*root=job->cwd;
    memset(scan,0,sizeof(*scan));
    if(!scan_push_directory(&stack,&stack_count,&stack_capacity,copy_text(""),0)){free(stack);return OWC_FS_NO_MEMORY;}
    if(!stack[0].relative){free(stack);return OWC_FS_NO_MEMORY;}
    while(stack_count&&error==OWC_FS_OK&&!scan->halt&&!job->cancel){
        fs_scan_directory directory=stack[--stack_count];owc_fs_list_result list;char *full=directory.relative[0]?scan_join(base,directory.relative):copy_text(base);size_t i;
        if(!full){free(directory.relative);error=OWC_FS_NO_MEMORY;break;}
        error=owc_fs_list(root,full,&list);free(full);
        /* Same protected-directory tolerance as fs.scan (depth 0 still fails). */
        if(error&&directory.depth>0&&(error==OWC_FS_PERMISSION_DENIED||error==OWC_FS_NOT_FOUND)){free(directory.relative);error=OWC_FS_OK;continue;}
        if(error){free(directory.relative);break;}
        /* Same single-directory enumeration cap as fs.scan: flagged, but the
         * rest of the tree is still traversed. */
        if(list.truncated){scan->truncated=1;if(!scan->reason)scan->reason="list";}
        for(i=0;i<list.count;i++){
            char *child,*policy_path;
            if(scan->nodes%OWC_INDEX_SCAN_CHECK_INTERVAL==0&&index_scan_halted(job,scan,deadline))break;
            if(scan->nodes++>=job->scan_max_nodes){scan->truncated=1;scan->halt=1;scan->reason="nodes";break;}
            child=directory.relative[0]?scan_join(directory.relative,list.entries[i].name):copy_text(list.entries[i].name);
            if(!child){error=OWC_FS_NO_MEMORY;break;}
            /* Excluded paths are neither listed nor traversed. */
            if(index_pattern_match(job->scan_exclude,job->scan_exclude_count,child)){free(child);continue;}
            /* Same deny-descendant rule as fs.scan: check the full
             * workspace-relative path, never just the scan-relative one. */
            policy_path=!strcmp(base,".")?copy_text(child):scan_join(base,child);
            if(!policy_path){free(child);error=OWC_FS_NO_MEMORY;break;}
            if(!index_path_allowed(job,policy_path)){free(policy_path);free(child);continue;}
            free(policy_path);
            if(list.entries[i].type==OWC_FS_TYPE_DIRECTORY){
                if(directory.depth>=job->scan_max_depth){scan->truncated=1;if(!scan->reason)scan->reason="depth";}
                else {char *next=copy_text(child);if(!next||!scan_push_directory(&stack,&stack_count,&stack_capacity,next,directory.depth+1)){free(next);free(child);error=OWC_FS_NO_MEMORY;break;}}
                free(child);continue;
            }
            if(list.entries[i].type!=OWC_FS_TYPE_FILE){free(child);continue;}
            /* Include rules constrain files only; directories are always
             * traversed so a TypeScript glob below src can still match. */
            if(job->scan_include_count&&!index_pattern_match(job->scan_include,job->scan_include_count,child)){free(child);continue;}
            {
                char *relative=!strcmp(base,".")?copy_text(child):scan_join(base,child);owc_fs_stat_result stat;
                if(!relative){free(child);error=OWC_FS_NO_MEMORY;break;}
                /* Files deleted or replaced mid-scan are skipped honestly. */
                if(owc_fs_stat(root,relative,&stat)){free(relative);free(child);continue;}
                {char digest[65];size_t hashed_size=0;int hashed=0;
                if(stat.size<=OWC_FS_MAX_FILE_SIZE&&scan->hashed_bytes+stat.size<=job->scan_max_bytes){
                    if(!owc_fs_hash(root,relative,digest,&hashed_size)){scan->hashed_bytes+=hashed_size;hashed=1;}
                } else scan->hash_truncated=1;
                if(!index_scan_add(scan,child,stat.size,stat.modified_ms,digest,hashed)){free(relative);error=OWC_FS_NO_MEMORY;break;}}
                free(relative);
            }
        }
        owc_fs_list_free(&list);free(directory.relative);
    }
    while(stack_count)free(stack[--stack_count].relative);
    free(stack);
    if(error){index_scan_free(scan);return error;}
    qsort(scan->items,scan->count,sizeof(*scan->items),index_scan_compare);return OWC_FS_OK;
}

static DWORD WINAPI index_scan_worker(void *data){
    owc_job *job=(owc_job*)data;index_scan_collection scan;owc_fs_error error;size_t i;unsigned long long started=monotonic_ms();
    error=index_scan_collect(job,&scan);
    if(error){EnterCriticalSection(&jobs_mutex);job->state=OWC_JOB_FAILED;LeaveCriticalSection(&jobs_mutex);return 0;}
    if(!job->cancel){
        /* Batch JSONL lines into ~3.5 KiB writes: one chunk slot per line
         * would cap the manifest at 128 entries (the output ring depth),
         * while batching lets the 512 KiB ring carry thousands of entries. */
        char batch[3584];size_t used=0;
        for(i=0;i<scan.count;i++){
            char *escaped=owc_json_escape_string(scan.items[i].path),*line;int length;
            if(!escaped)break;
            if(scan.items[i].hashed)length=snprintf(NULL,0,"{\"path\":%s,\"size\":%llu,\"modifiedMs\":%lld,\"sha256\":\"%s\"}\n",escaped,scan.items[i].size,scan.items[i].modified_ms,scan.items[i].sha256);
            else length=snprintf(NULL,0,"{\"path\":%s,\"size\":%llu,\"modifiedMs\":%lld}\n",escaped,scan.items[i].size,scan.items[i].modified_ms);
            line=length<0?NULL:(char*)malloc((size_t)length+1);
            if(!line){free(escaped);break;}
            if(scan.items[i].hashed)(void)snprintf(line,(size_t)length+1,"{\"path\":%s,\"size\":%llu,\"modifiedMs\":%lld,\"sha256\":\"%s\"}\n",escaped,scan.items[i].size,scan.items[i].modified_ms,scan.items[i].sha256);
            else (void)snprintf(line,(size_t)length+1,"{\"path\":%s,\"size\":%llu,\"modifiedMs\":%lld}\n",escaped,scan.items[i].size,scan.items[i].modified_ms);
            free(escaped);
            if((size_t)length>sizeof(batch)-used){job_output(job,"stdout",(const unsigned char*)batch,used,0);used=0;}
            if((size_t)length>=sizeof(batch))job_output(job,"stdout",(const unsigned char*)line,(size_t)length,0);
            else {memcpy(batch+used,line,(size_t)length);used+=(size_t)length;}
            free(line);
            if(job->cancel)break;
        }
        if(!job->cancel){
            char summary[256];int length=snprintf(summary,sizeof(summary),"{\"summary\":{\"entries\":%zu,\"truncated\":%s,\"reason\":%s%s%s,\"hashTruncated\":%s}}\n",scan.count,scan.truncated?"true":"false",scan.reason?"\"":"",scan.reason?scan.reason:"null",scan.reason?"\"":"",scan.hash_truncated?"true":"false");
            if(length>0&&(size_t)length<sizeof(summary)){
                if(sizeof(batch)-used>(size_t)length){memcpy(batch+used,summary,(size_t)length);used+=(size_t)length;}
                else {job_output(job,"stdout",(const unsigned char*)batch,used,0);used=0;memcpy(batch,summary,(size_t)length);used=(size_t)length;}
            }
        }
        if(used)job_output(job,"stdout",(const unsigned char*)batch,used,0);
    }
    EnterCriticalSection(&jobs_mutex);
    job->result.exit_code=0;
    job->result.duration_ms=(long long)(monotonic_ms()-started);
    job->state=job->cancel?OWC_JOB_CANCELLED:OWC_JOB_COMPLETED;
    LeaveCriticalSection(&jobs_mutex);
    index_scan_free(&scan);
    return 0;
}

/* ------------------------------------------------------------------ */
/* grep / glob jobs: bounded, cancellable, parallel file search.
 *
 * Both reuse the index.scan traversal skeleton (stack DFS, budget
 * checks, policy snapshot, no-follow via owc_fs_list).  grep
 * additionally parallelises file reads through a shared-cursor
 * worker pool: one traversal collects candidate paths, then N
 * joinable threads search files concurrently, each writing into a
 * thread-local match buffer.  Results are merged and sorted by path
 * for deterministic output, then streamed as JSONL to the job output
 * ring - the same pattern as index.scan.  glob matches names during
 * the walk (trivially fast) and needs no pool. */
#define OWC_SEARCH_DEFAULT_NODES 200000ul
#define OWC_SEARCH_NODES_LIMIT 1000000ul
#define OWC_SEARCH_DEFAULT_DEPTH 32ul
#define OWC_SEARCH_DEPTH_LIMIT 64ul
#define OWC_SEARCH_DEFAULT_MS 30000
#define OWC_SEARCH_MS_LIMIT 300000
#define OWC_SEARCH_CHECK_INTERVAL 64u
#define OWC_SEARCH_PARALLELISM 4u
#define OWC_SEARCH_MAX_RESULTS 100000u
#define OWC_SEARCH_TEXT_LIMIT 512u

typedef struct { char *path; char *text; size_t line; } search_match;
typedef struct { search_match *items; size_t count, capacity; } search_match_list;

static void search_match_list_free(search_match_list *list) {
    size_t i; if(!list) return;
    for(i=0;i<list->count;i++){free(list->items[i].path);free(list->items[i].text);}
    free(list->items); memset(list,0,sizeof(*list));
}
static int search_match_add(search_match_list *list, char *path, char *text, size_t line) {
    search_match *grown;
    if(list->count==list->capacity) {
        size_t cap=list->capacity?list->capacity*2u:128u;
        grown=(search_match*)realloc(list->items,cap*sizeof(*grown));
        if(!grown) return 0;
        list->items=grown; list->capacity=cap;
    }
    list->items[list->count].path=path;
    list->items[list->count].text=text;
    list->items[list->count].line=line;
    list->count++; return 1;
}
static int search_match_compare(const void *left, const void *right) {
    const search_match *a=(const search_match*)left, *b=(const search_match*)right;
    int cmp=strcmp(a->path,b->path);
    if(cmp) return cmp;
    return a->line<b->line?-1:a->line>b->line?1:0;
}

typedef struct { char **displays; char **fulls; size_t count, capacity, nodes; int truncated, halt; const char *reason; } search_collection;

static void search_collection_free(search_collection *col) {
    size_t i; if(!col) return;
    for(i=0;i<col->count;i++){free(col->displays[i]);free(col->fulls[i]);}
    free(col->displays); free(col->fulls); memset(col,0,sizeof(*col));
}
static int search_collection_add(search_collection *col, char *display, char *full) {
    char **d_grown, **f_grown;
    if(col->count==col->capacity) {
        size_t cap=col->capacity?col->capacity*2u:256u;
        d_grown=(char**)realloc(col->displays,cap*sizeof(*d_grown));
        if(!d_grown) return 0;
        col->displays=d_grown;
        f_grown=(char**)realloc(col->fulls,cap*sizeof(*f_grown));
        if(!f_grown) return 0;
        col->fulls=f_grown; col->capacity=cap;
    }
    col->displays[col->count]=display;
    col->fulls[col->count]=full;
    col->count++; return 1;
}
static int search_path_compare(const void *left, const void *right) {
    const char *const *a=(const char *const *)left, *const *b=(const char *const *)right;
    return strcmp(*a,*b);
}

/* Traversal skeleton shared by grep and glob.  Reuses the same root-bound
 * no-follow list, policy snapshot, and budget semantics as index.scan.
 * For glob (is_glob!=0) only paths matching job->search_pattern are
 * collected; for grep all files passing include/exclude are collected
 * for later parallel content search. */
static owc_fs_error search_collect(owc_job *job, search_collection *col, int is_glob) {
    fs_scan_directory *stack=NULL; size_t stack_count=0, stack_capacity=0;
    owc_fs_error error=OWC_FS_OK;
    unsigned long long deadline=monotonic_ms()+(unsigned long long)job->scan_max_ms;
    const char *base=job->scan_path, *root=job->cwd;
    memset(col,0,sizeof(*col));
    if(!scan_push_directory(&stack,&stack_count,&stack_capacity,copy_text(""),0)){free(stack);return OWC_FS_NO_MEMORY;}
    if(!stack[0].relative){free(stack);return OWC_FS_NO_MEMORY;}
    while(stack_count&&error==OWC_FS_OK&&!col->halt&&!job->cancel) {
        if(col->nodes>0&&monotonic_ms()>=deadline){col->truncated=1;col->halt=1;col->reason="time";break;}
        fs_scan_directory directory=stack[--stack_count]; owc_fs_list_result list;
        char *full=directory.relative[0]?scan_join(base,directory.relative):copy_text(base); size_t i;
        if(!full){free(directory.relative);error=OWC_FS_NO_MEMORY;break;}
        error=owc_fs_list(root,full,&list); free(full);
        if(error&&directory.depth>0&&(error==OWC_FS_PERMISSION_DENIED||error==OWC_FS_NOT_FOUND)){free(directory.relative);error=OWC_FS_OK;continue;}
        if(error){free(directory.relative);break;}
        if(list.truncated){col->truncated=1;if(!col->reason)col->reason="list";}
        for(i=0;i<list.count;i++) {
            char *child, *policy_path;
            if(col->nodes%OWC_SEARCH_CHECK_INTERVAL==0) {
                if(job->cancel) break;
                if(monotonic_ms()>=deadline){col->truncated=1;col->halt=1;col->reason="time";break;}
            }
            if(col->nodes++>=job->scan_max_nodes){col->truncated=1;col->halt=1;col->reason="nodes";break;}
            child=directory.relative[0]?scan_join(directory.relative,list.entries[i].name):copy_text(list.entries[i].name);
            if(!child){error=OWC_FS_NO_MEMORY;break;}
            if(index_pattern_match(job->scan_exclude,job->scan_exclude_count,child)){free(child);continue;}
            policy_path=!strcmp(base,".")?copy_text(child):scan_join(base,child);
            if(!policy_path){free(child);error=OWC_FS_NO_MEMORY;break;}
            if(!index_path_allowed(job,policy_path)){free(policy_path);free(child);continue;}
            free(policy_path);
            if(list.entries[i].type==OWC_FS_TYPE_DIRECTORY) {
                if(directory.depth>=job->scan_max_depth){col->truncated=1;if(!col->reason)col->reason="depth";}
                else {char *next=copy_text(child);if(!next||!scan_push_directory(&stack,&stack_count,&stack_capacity,next,directory.depth+1)){free(next);free(child);error=OWC_FS_NO_MEMORY;break;}}
                free(child); continue;
            }
            if(list.entries[i].type!=OWC_FS_TYPE_FILE){free(child);continue;}
            if(job->scan_include_count&&!index_pattern_match(job->scan_include,job->scan_include_count,child)){free(child);continue;}
            if(is_glob&&!owc_fs_match_pattern(job->search_pattern,child)){free(child);continue;}
            {char *display=copy_text(child);char *fullpath=!strcmp(base,".")?copy_text(child):scan_join(base,child);
            if(!display||!fullpath){free(display);free(fullpath);free(child);error=OWC_FS_NO_MEMORY;break;}
            if(!search_collection_add(col,display,fullpath)){free(display);free(fullpath);free(child);error=OWC_FS_NO_MEMORY;break;}}
            free(child);
        }
        owc_fs_list_free(&list); free(directory.relative);
    }
    while(stack_count)free(stack[--stack_count].relative);
    free(stack);
    if(error){search_collection_free(col);return error;}
    return OWC_FS_OK;
}

/* Parallel grep context: shared cursor + per-thread match lists.
 * displays/fulls/file_count are borrowed from search_collection
 * (immutable during parallel search).  cursor and total_matches are
 * protected by lock; cancel is the volatile job flag. */
typedef struct {
    char **displays; char **fulls; size_t file_count;
    size_t cursor; CRITICAL_SECTION *lock;
    const char *root; const char *pattern; volatile int *cancel;
    const char *const *deny_roots; size_t deny_root_count;
    search_match_list *lists; size_t total_matches; int truncated;
} grep_ctx;
typedef struct { grep_ctx *ctx; size_t tid; } grep_thread_arg;

static DWORD WINAPI grep_file_worker(void *arg) {
    grep_thread_arg *ta=(grep_thread_arg*)arg; grep_ctx *ctx=ta->ctx; size_t tid=ta->tid;
    owc_fs_platform_set_deny_roots(ctx->deny_roots,ctx->deny_root_count);
    for(;;) {
        size_t idx; owc_fs_bytes bytes={0}; owc_fs_error e;
        EnterCriticalSection(ctx->lock);
        if(*ctx->cancel){LeaveCriticalSection(ctx->lock);break;}
        if(ctx->total_matches>=OWC_SEARCH_MAX_RESULTS){ctx->truncated=1;LeaveCriticalSection(ctx->lock);break;}
        idx=ctx->cursor++;
        if(idx>=ctx->file_count){LeaveCriticalSection(ctx->lock);break;}
        LeaveCriticalSection(ctx->lock);
        e=owc_fs_platform_read(ctx->root,ctx->fulls[idx],&bytes);
        if(e==OWC_FS_OK&&bytes.data&&owc_fs_utf8_valid((char*)bytes.data,bytes.length)) {
            size_t start=0,line=1,i,plen=strlen(ctx->pattern);
            for(i=0;i<=bytes.length;i++) {
                if(i==bytes.length||bytes.data[i]=='\n') {
                    size_t llen=i-start;
                    if(plen&&plen<=llen) {
                        size_t j; int found=0;
                        for(j=0;j+plen<=llen;j++) if(!memcmp(bytes.data+start+j,ctx->pattern,plen)){found=1;break;}
                        if(found) {
                            size_t tlen=llen>OWC_SEARCH_TEXT_LIMIT?OWC_SEARCH_TEXT_LIMIT:llen;
                            while(tlen>0&&(bytes.data[start+tlen]&0xC0)==0x80)tlen--;
                            char *text=(char*)malloc(tlen+1); char *path=copy_text(ctx->displays[idx]);
                            if(text&&path) {
                                memcpy(text,bytes.data+start,tlen); text[tlen]=0;
                                if(!search_match_add(&ctx->lists[tid],path,text,line)) {free(path);free(text);}
                                else {EnterCriticalSection(ctx->lock);ctx->total_matches++;LeaveCriticalSection(ctx->lock);}
                            } else {free(path);free(text);}
                        }
                    }
                    line++; start=i+1;
                }
            }
        }
        free(bytes.data);
    }
    owc_fs_platform_set_deny_roots(NULL,0);
    return 0;
}

static DWORD WINAPI grep_job_worker(void *data) {
    owc_job *job=(owc_job*)data; search_collection col; owc_fs_error error;
    unsigned long long started=monotonic_ms(); search_match_list merged;
    size_t i;
    error=search_collect(job,&col,0);
    if(error){EnterCriticalSection(&jobs_mutex);job->state=OWC_JOB_FAILED;LeaveCriticalSection(&jobs_mutex);return 0;}
    memset(&merged,0,sizeof(merged));
    if(!job->cancel&&col.count>0) {
        size_t n=OWC_SEARCH_PARALLELISM; if(n>col.count) n=col.count;
        CRITICAL_SECTION lock; grep_ctx ctx; search_match_list *lists;
        HANDLE *threads; grep_thread_arg *args; size_t t;
        lists=(search_match_list*)calloc(n,sizeof(*lists));
        threads=(HANDLE*)calloc(n,sizeof(*threads));
        args=(grep_thread_arg*)calloc(n,sizeof(*args));
        if(lists&&threads&&args) {
            InitializeCriticalSection(&lock);
            memset(&ctx,0,sizeof(ctx));
            ctx.displays=col.displays; ctx.fulls=col.fulls; ctx.file_count=col.count;
            ctx.cursor=0; ctx.lock=&lock; ctx.root=job->cwd; ctx.pattern=job->search_pattern;
            ctx.deny_roots=(const char *const *)job->scan_deny_roots; ctx.deny_root_count=job->scan_deny_root_count;
            ctx.cancel=&job->cancel; ctx.lists=lists; ctx.total_matches=0; ctx.truncated=0;
            for(t=0;t<n;t++) {
                args[t].ctx=&ctx; args[t].tid=t;
                threads[t]=owc_create_joinable_thread(grep_file_worker,&args[t]);
            }
            for(t=0;t<n;t++) if(threads[t]) owc_join_thread(threads[t]);
            DeleteCriticalSection(&lock);
            for(t=0;t<n;t++) {
                size_t j;
                for(j=0;j<lists[t].count;j++) {
                    if(search_match_add(&merged,lists[t].items[j].path,lists[t].items[j].text,lists[t].items[j].line)) {
                        lists[t].items[j].path=NULL; lists[t].items[j].text=NULL;
                    }
                }
                search_match_list_free(&lists[t]);
            }
            if(ctx.truncated){col.truncated=1;if(!col.reason)col.reason="matches";}
        }
        free(lists); free(threads); free(args);
    }
    qsort(merged.items,merged.count,sizeof(*merged.items),search_match_compare);
    if(!job->cancel) {
        char batch[3584]; size_t used=0;
        for(i=0;i<merged.count;i++) {
            char *ep=owc_json_escape_string(merged.items[i].path),*et=owc_json_escape_string(merged.items[i].text); int length;
            if(!ep||!et){free(ep);free(et);break;}
            length=snprintf(NULL,0,"{\"path\":%s,\"line\":%zu,\"text\":%s}\n",ep,merged.items[i].line,et);
            if(length>0){char *line=malloc((size_t)length+1);
            if(line){snprintf(line,(size_t)length+1,"{\"path\":%s,\"line\":%zu,\"text\":%s}\n",ep,merged.items[i].line,et);
            if((size_t)length>sizeof(batch)-used){job_output(job,"stdout",(const unsigned char*)batch,used,0);used=0;}
            if((size_t)length>=sizeof(batch))job_output(job,"stdout",(const unsigned char*)line,(size_t)length,0);
            else{memcpy(batch+used,line,(size_t)length);used+=(size_t)length;}free(line);}}
            free(ep); free(et);
            if(job->cancel) break;
        }
        if(!job->cancel){char summary[256];int slen=snprintf(summary,sizeof(summary),"{\"summary\":{\"matches\":%zu,\"truncated\":%s,\"reason\":%s%s%s}}\n",merged.count,col.truncated?"true":"false",col.reason?"\"":"",col.reason?col.reason:"null",col.reason?"\"":"");
        if(slen>0&&(size_t)slen<sizeof(summary)){if(sizeof(batch)-used>(size_t)slen){memcpy(batch+used,summary,(size_t)slen);used+=(size_t)slen;}else{job_output(job,"stdout",(const unsigned char*)batch,used,0);used=0;memcpy(batch,summary,(size_t)slen);used=(size_t)slen;}}}
        if(used)job_output(job,"stdout",(const unsigned char*)batch,used,0);
    }
    EnterCriticalSection(&jobs_mutex);
    job->result.exit_code=0;
    job->result.duration_ms=(long long)(monotonic_ms()-started);
    job->state=job->cancel?OWC_JOB_CANCELLED:OWC_JOB_COMPLETED;
    LeaveCriticalSection(&jobs_mutex);
    search_match_list_free(&merged);
    search_collection_free(&col);
    return 0;
}

static DWORD WINAPI glob_job_worker(void *data) {
    owc_job *job=(owc_job*)data; search_collection col; owc_fs_error error;
    unsigned long long started=monotonic_ms(); size_t i;
    error=search_collect(job,&col,1);
    if(error){EnterCriticalSection(&jobs_mutex);job->state=OWC_JOB_FAILED;LeaveCriticalSection(&jobs_mutex);return 0;}
    qsort(col.displays,col.count,sizeof(char*),search_path_compare);
    if(!job->cancel) {
        char batch[3584]; size_t used=0;
        for(i=0;i<col.count;i++) {
            char *ep=owc_json_escape_string(col.displays[i]); int length;
            if(!ep) break;
            length=snprintf(NULL,0,"{\"path\":%s}\n",ep);
            if(length>0){char *line=malloc((size_t)length+1);
            if(line){snprintf(line,(size_t)length+1,"{\"path\":%s}\n",ep);
            if((size_t)length>sizeof(batch)-used){job_output(job,"stdout",(const unsigned char*)batch,used,0);used=0;}
            if((size_t)length>=sizeof(batch))job_output(job,"stdout",(const unsigned char*)line,(size_t)length,0);
            else{memcpy(batch+used,line,(size_t)length);used+=(size_t)length;}free(line);}}
            free(ep);
            if(job->cancel) break;
        }
        if(!job->cancel){char summary[256];int slen=snprintf(summary,sizeof(summary),"{\"summary\":{\"entries\":%zu,\"truncated\":%s,\"reason\":%s%s%s}}\n",col.count,col.truncated?"true":"false",col.reason?"\"":"",col.reason?col.reason:"null",col.reason?"\"":"");
        if(slen>0&&(size_t)slen<sizeof(summary)){if(sizeof(batch)-used>(size_t)slen){memcpy(batch+used,summary,(size_t)slen);used+=(size_t)slen;}else{job_output(job,"stdout",(const unsigned char*)batch,used,0);used=0;memcpy(batch,summary,(size_t)slen);used=(size_t)slen;}}}
        if(used)job_output(job,"stdout",(const unsigned char*)batch,used,0);
    }
    EnterCriticalSection(&jobs_mutex);
    job->result.exit_code=0;
    job->result.duration_ms=(long long)(monotonic_ms()-started);
    job->state=job->cancel?OWC_JOB_CANCELLED:OWC_JOB_COMPLETED;
    LeaveCriticalSection(&jobs_mutex);
    search_collection_free(&col);
    return 0;
}


/* ------------------------------------------------------------------ */
/* index.extract: bounded, cancellable symbol extraction over an
 * explicit file list (the Node side computes the changed set from
 * successive manifests).  Files are processed in the given order; each
 * file is policy-checked against the same read/deny snapshot as
 * index.scan, read through the root-bound platform primitive, and
 * matched by the pure-C engine in symbol_extract.c.  Output is JSONL:
 * one object per processed file, then a trailing summary line. */
#define OWC_EXTRACT_MAX_FILES 4096u
#define OWC_EXTRACT_PATH_BYTES 1024u
#define OWC_EXTRACT_DEFAULT_BYTES (64ull*1024ull*1024ull)
#define OWC_EXTRACT_BYTES_LIMIT (1024ull*1024ull*1024ull)
#define OWC_EXTRACT_DEFAULT_MS 30000
#define OWC_EXTRACT_MS_LIMIT 300000
#define OWC_EXTRACT_DEFAULT_SYMBOLS 200ul
#define OWC_EXTRACT_SYMBOLS_LIMIT 10000ul

typedef struct { char *data; size_t length, capacity; } extract_strbuf;
static void extract_sb_free(extract_strbuf *sb){free(sb->data);memset(sb,0,sizeof(*sb));}
static int extract_sb_append(extract_strbuf *sb,const char *text,size_t length){
    if(sb->length+length+1>sb->capacity){
        size_t cap=sb->capacity?sb->capacity:256u;char *grown;
        while(cap<sb->length+length+1)cap*=2u;
        grown=(char*)realloc(sb->data,cap);
        if(!grown)return 0;
        sb->data=grown;sb->capacity=cap;
    }
    memcpy(sb->data+sb->length,text,length);sb->length+=length;sb->data[sb->length]='\0';
    return 1;
}
static int extract_sb_printf(extract_strbuf *sb,const char *format,...){
    va_list args,copy;int length;char *text;int ok;
    va_start(args,format);va_copy(copy,args);
    length=vsnprintf(NULL,0,format,args);va_end(args);
    if(length<0){va_end(copy);return 0;}
    text=(char*)malloc((size_t)length+1);
    if(!text){va_end(copy);return 0;}
    (void)vsnprintf(text,(size_t)length+1,format,copy);va_end(copy);
    ok=extract_sb_append(sb,text,(size_t)length);
    free(text);
    return ok;
}

static DWORD WINAPI index_extract_worker(void *data){
    owc_job *job=(owc_job*)data;
    unsigned long long started=monotonic_ms();
    unsigned long long deadline=started+(unsigned long long)job->scan_max_ms;
    unsigned long long bytes_read=0;
    size_t files_done=0,symbols_total=0,file_index;
    int truncated=0,failed=0;
    const char *reason=NULL;
    char batch[3584];size_t used=0;
    for(file_index=0;file_index<job->extract_file_count&&!job->cancel;file_index++){
        const char *file=job->extract_files[file_index];
        const char *language;
        char *full;
        owc_fs_bytes bytes;
        owc_fs_error error;
        if(monotonic_ms()>=deadline){truncated=1;reason="time";break;}
        /* Unsupported extensions are skipped entirely (no output line). */
        language=owc_symbol_language_for_path(file);
        if(!language)continue;
        full=!strcmp(job->scan_path,".")?copy_text(file):scan_join(job->scan_path,file);
        if(!full){failed=1;break;}
        /* Same read/deny policy snapshot as index.scan; traversal and
         * absolute spellings are rejected by session_policy_path. */
        if(!index_path_allowed(job,full)){free(full);continue;}
        memset(&bytes,0,sizeof(bytes));
        error=owc_fs_platform_read(job->cwd,full,&bytes);
        free(full);
        /* Files deleted or unreadable mid-job are skipped honestly. */
        if(error||!bytes.data){free(bytes.data);continue;}
        if(bytes.length>OWC_SYMBOL_MAX_FILE_BYTES){free(bytes.data);continue;}
        if(bytes_read+bytes.length>job->scan_max_bytes){free(bytes.data);truncated=1;reason="bytes";break;}
        bytes_read+=bytes.length;
        if(!owc_fs_utf8_valid((const char*)bytes.data,bytes.length)){free(bytes.data);continue;}
        {
            owc_symbol_record *records=NULL;size_t record_count=0,i;
            extract_strbuf line;
            if(owc_symbol_extract(language,(const char*)bytes.data,bytes.length,(size_t)job->extract_max_symbols,&records,&record_count)){free(bytes.data);failed=1;break;}
            free(bytes.data);
            memset(&line,0,sizeof(line));
            {
                char *escaped=owc_json_escape_string(file);
                int ok=escaped&&extract_sb_append(&line,"{\"path\":",8)&&extract_sb_append(&line,escaped,strlen(escaped))&&extract_sb_append(&line,",\"symbols\":[",12);
                free(escaped);
                if(!ok){extract_sb_free(&line);owc_symbol_records_free(records,record_count);failed=1;break;}
            }
            for(i=0;i<record_count;i++){
                char *ename=owc_json_escape_string(records[i].name);
                char *esig=owc_json_escape_string(records[i].signature);
                int ok=ename&&esig&&extract_sb_printf(&line,"%s{\"name\":%s,\"kind\":\"%s\",\"startLine\":%zu,\"endLine\":%zu,\"signature\":%s}",i?",":"",ename,records[i].kind,records[i].start_line,records[i].end_line,esig);
                free(ename);free(esig);
                if(!ok){extract_sb_free(&line);owc_symbol_records_free(records,record_count);failed=1;break;}
            }
            if(failed)break;
            if(!extract_sb_append(&line,"]}\n",3)){extract_sb_free(&line);owc_symbol_records_free(records,record_count);failed=1;break;}
            owc_symbol_records_free(records,record_count);
            /* Same ~3.5 KiB batching as index.scan: one chunk slot per
             * line would cap output at the 128-slot ring depth. */
            if(line.length>sizeof(batch)-used){job_output(job,"stdout",(const unsigned char*)batch,used,0);used=0;}
            if(line.length>=sizeof(batch))job_output(job,"stdout",(const unsigned char*)line.data,line.length,0);
            else{memcpy(batch+used,line.data,line.length);used+=line.length;}
            extract_sb_free(&line);
            files_done++;symbols_total+=record_count;
        }
    }
    if(failed){EnterCriticalSection(&jobs_mutex);job->state=OWC_JOB_FAILED;LeaveCriticalSection(&jobs_mutex);return 0;}
    if(!job->cancel){
        char summary[256];int slen=snprintf(summary,sizeof(summary),"{\"summary\":{\"files\":%zu,\"symbols\":%zu,\"truncated\":%s,\"reason\":%s%s%s}}\n",files_done,symbols_total,truncated?"true":"false",reason?"\"":"",reason?reason:"null",reason?"\"":"");
        if(slen>0&&(size_t)slen<sizeof(summary)){if(sizeof(batch)-used>(size_t)slen){memcpy(batch+used,summary,(size_t)slen);used+=(size_t)slen;}else{job_output(job,"stdout",(const unsigned char*)batch,used,0);used=0;memcpy(batch,summary,(size_t)slen);used=(size_t)slen;}}
    }
    if(used)job_output(job,"stdout",(const unsigned char*)batch,used,0);
    EnterCriticalSection(&jobs_mutex);
    job->result.exit_code=0;
    job->result.duration_ms=(long long)(monotonic_ms()-started);
    job->state=job->cancel?OWC_JOB_CANCELLED:OWC_JOB_COMPLETED;
    LeaveCriticalSection(&jobs_mutex);
    return 0;
}

static DWORD WINAPI job_worker(void *data){owc_job *job=(owc_job*)data;owc_exec_request request;owc_exec_result result;if(job->kind==OWC_JOB_INDEX_SCAN||job->kind==OWC_JOB_GREP||job->kind==OWC_JOB_GLOB||job->kind==OWC_JOB_INDEX_EXTRACT){DWORD worker_result;owc_fs_platform_set_deny_roots((const char *const *)job->scan_deny_roots,job->scan_deny_root_count);if(job->kind==OWC_JOB_INDEX_SCAN)worker_result=index_scan_worker(job);else if(job->kind==OWC_JOB_GREP)worker_result=grep_job_worker(job);else if(job->kind==OWC_JOB_INDEX_EXTRACT)worker_result=index_extract_worker(job);else worker_result=glob_job_worker(job);owc_fs_platform_set_deny_roots(NULL,0);return worker_result;}memset(&request,0,sizeof(request));request.command=job->cmd;request.cwd=job->cwd;request.session_id=job->session;request.allow_paths=(const char *const *)job->allow_paths;request.allow_path_count=job->allow_path_count;request.bind_backing=(const char *const *)job->bind_backing;request.bind_read_only=job->bind_read_only;request.bind_count=job->bind_count;request.read_roots=(const char *const *)job->read_roots;request.read_root_count=job->read_root_count;request.write_roots=(const char *const *)job->write_roots;request.write_root_count=job->write_root_count;request.deny_paths=(const char *const *)job->deny_paths;request.deny_path_count=job->deny_path_count;request.network_filtered=job->network_filtered;request.proxy_addr=job->proxy_addr[0]?job->proxy_addr:NULL;request.read_only_paths=(const char *const *)job->read_only_paths;request.read_only_count=job->read_only_count;request.sandbox_enabled=job->sandbox_enabled;request.allow_network=job->allow_network;request.sandbox_mode=job->sandbox_mode;request.shell_backend=job->shell_backend;request.shell_path=job->shell_path;request.job_memory_mb=job->memory;request.job_max_processes=job->processes;request.timeout_ms=job->timeout;request.output_limit=1024u*1024u;request.cancel_requested=&job->cancel;request.on_output=job_output;request.user_data=job;(void)owc_exec_run(&request,&result);EnterCriticalSection(&jobs_mutex);job->result=result;if(result.cancelled)job->state=OWC_JOB_CANCELLED;else if(result.timed_out)job->state=OWC_JOB_TIMED_OUT;else if(!result.system_error)job->state=OWC_JOB_COMPLETED;else job->state=OWC_JOB_FAILED;LeaveCriticalSection(&jobs_mutex);return 0;}
static const char *job_state_name(owc_job_state state){return state==OWC_JOB_RUNNING?"running":state==OWC_JOB_COMPLETED?"completed":state==OWC_JOB_CANCELLED?"cancelled":state==OWC_JOB_TIMED_OUT?"timed_out":"failed";}
static owc_job *find_job(const char *session,const char *id){size_t i;for(i=0;i<OWC_JOB_MAX_RUNNING;i++)if(jobs[i].state!=OWC_JOB_EMPTY&&!strcmp(jobs[i].session,session)&&!strcmp(jobs[i].id,id))return &jobs[i];return NULL;}
static void cancel_session_jobs(const char *session_id){size_t i;if(!jobs_ready)return;EnterCriticalSection(&jobs_mutex);for(i=0;i<OWC_JOB_MAX_RUNNING;i++)if(jobs[i].state==OWC_JOB_RUNNING&&!strcmp(jobs[i].session,session_id))jobs[i].cancel=1;LeaveCriticalSection(&jobs_mutex);}
static int copy_patterns(const owc_json *array,char **values,size_t *count){
    size_t i;
    if(!array)return 1;
    if(array->type!=OWC_JSON_ARRAY||array->value.children.count>OWC_INDEX_MAX_PATTERNS)return 0;
    for(i=0;i<array->value.children.count;i++){
        const char *value=owc_json_get_string(array->value.children.items[i]);
        if(!value||!value[0]||strlen(value)>512)return 0;
        values[*count]=copy_text(value);
        if(!values[*count])return 0;
        (*count)++;
    }
    return 1;
}
static int handle_job_start(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *exec_keys[]={"sessionId","jobId","kind","cmd","cwd","timeoutMs","shellBackend","shellPath","network"};
    static const char *scan_keys[]={"sessionId","jobId","kind","cwd","path","include","exclude","maxDepth","maxNodes","maxBytes","maxMs","timeoutMs"};
    static const char *search_keys[]={"sessionId","jobId","kind","cwd","path","pattern","include","exclude","maxDepth","maxNodes","maxMs","timeoutMs"};
    static const char *extract_keys[]={"sessionId","jobId","kind","cwd","path","files","maxBytes","maxMs","maxSymbolsPerFile","timeoutMs"};
    const char *session,*job_id,*kind,*cmd,*cwd,*shell_path,*const *allow_paths,*const *bind_backing;
    const int *bind_read_only;
    const char *const *read_roots,*const *write_roots,*const *deny_paths;
    const char *proxy_addr,*const *read_only_paths;
    int enabled,network,mode,shell_backend,is_scan,is_search,is_extract,network_filtered;
    unsigned long memory,processes;
    size_t allow_count,bind_count,read_root_count,write_root_count,deny_path_count,read_only_count,i;
    owc_job *job=NULL;
    session=owc_json_get_string(owc_json_object_get(p,"sessionId"));
    job_id=owc_json_get_string(owc_json_object_get(p,"jobId"));
    kind=owc_json_get_string(owc_json_object_get(p,"kind"));
    if(!session||!job_id||!job_id[0]||strlen(job_id)>128||!kind)return reply_error(rpc,id,-32602,"job.start requires sessionId, jobId, and kind");
    is_scan=!strcmp(kind,"index.scan");
    is_search=!strcmp(kind,"grep")||!strcmp(kind,"glob");
    is_extract=!strcmp(kind,"index.extract");
    if(!is_scan&&!is_search&&!is_extract&&strcmp(kind,"exec"))return reply_error(rpc,id,-32602,"job.start kind must be exec, index.scan, index.extract, grep, or glob");
    {const char *const *keys;size_t nkeys;
    if(is_scan){keys=scan_keys;nkeys=sizeof(scan_keys)/sizeof(scan_keys[0]);}
    else if(is_search){keys=search_keys;nkeys=sizeof(search_keys)/sizeof(search_keys[0]);}
    else if(is_extract){keys=extract_keys;nkeys=sizeof(extract_keys)/sizeof(extract_keys[0]);}
    else{keys=exec_keys;nkeys=sizeof(exec_keys)/sizeof(exec_keys[0]);}
    if(!allowed_keys(p,keys,nkeys))return reply_error(rpc,id,-32602,"job.start contains unknown fields");}
    cmd=owc_json_get_string(owc_json_object_get(p,"cmd"));
    cwd=owc_json_get_string(owc_json_object_get(p,"cwd"));
    if(!cwd)return reply_error(rpc,id,-32602,"job.start requires cwd");
    if(!is_scan&&!is_search&&!is_extract&&(!cmd||!cmd[0]))return reply_error(rpc,id,-32602,"job.start kind exec requires a non-empty cmd");
    if(!parse_shell_backend(p,&shell_backend))return reply_error(rpc,id,-32602,"shellBackend must be default, pwsh, or bash");
    if(!parse_shell_path(p,&shell_path))return reply_error(rpc,id,-32602,"shellPath must be a non-empty string of at most 1024 bytes");
    if(!session_exec_policy(session,cwd,&enabled,&network,&mode,&allow_paths,&allow_count,&memory,&processes,&bind_backing,&bind_read_only,&bind_count,&read_roots,&read_root_count,&write_roots,&write_root_count,&deny_paths,&deny_path_count,&network_filtered,&proxy_addr,&read_only_paths,&read_only_count))return reply_error(rpc,id,-32002,"session cwd is not configured");
    if(!parse_network_override(p,&network))return reply_error(rpc,id,-32602,"network must be \"allow\" or \"deny\"");
    jobs_init();EnterCriticalSection(&jobs_mutex);
    if(find_job(session,job_id)){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"jobId already exists in this session");}
    for(i=0;i<OWC_JOB_MAX_RUNNING;i++)if(jobs[i].state!=OWC_JOB_RUNNING)break;
    if(i==OWC_JOB_MAX_RUNNING){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"job limit reached");}
    job=&jobs[i];job_free(job);
    job->id=copy_text(job_id);job->session=copy_text(session);job->cwd=copy_text(cwd);
    job->kind=is_scan?OWC_JOB_INDEX_SCAN:is_search?(!strcmp(kind,"grep")?OWC_JOB_GREP:OWC_JOB_GLOB):is_extract?OWC_JOB_INDEX_EXTRACT:OWC_JOB_EXEC;
    if(is_scan){
        const char *path=owc_json_get_string(owc_json_object_get(p,"path"));const owc_json *value;size_t number=0;
        if(!path||!path[0]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"job.start kind index.scan requires a non-empty path");}
        if(!session_path_check(session_find(session),path,OWC_PATH_READ)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32002,"path is denied by session policy");}
        job->scan_path=copy_text(path);
        job->scan_max_nodes=OWC_INDEX_SCAN_DEFAULT_NODES;job->scan_max_depth=OWC_INDEX_SCAN_DEFAULT_DEPTH;job->scan_max_bytes=OWC_INDEX_SCAN_DEFAULT_BYTES;job->scan_max_ms=OWC_INDEX_SCAN_DEFAULT_MS;
        value=owc_json_object_get(p,"maxNodes");if(value&&(!json_size(value,&number)||!number||number>OWC_INDEX_SCAN_NODES_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxNodes must be an integer from 1 to 1000000");}if(value)job->scan_max_nodes=(unsigned long)number;
        value=owc_json_object_get(p,"maxDepth");if(value&&(!json_size(value,&number)||number>OWC_INDEX_SCAN_DEPTH_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxDepth must be an integer from 0 to 64");}if(value)job->scan_max_depth=(unsigned long)number;
        value=owc_json_object_get(p,"maxBytes");if(value&&(!json_size(value,&number)||!number||number>OWC_INDEX_SCAN_BYTES_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxBytes must be an integer from 1 to 17179869184");}if(value)job->scan_max_bytes=(unsigned long long)number;
        value=owc_json_object_get(p,"maxMs");if(value&&(!json_size(value,&number)||!number||number>OWC_INDEX_SCAN_MS_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxMs must be an integer from 1 to 600000");}if(value)job->scan_max_ms=(int)number;
        if(!copy_patterns(owc_json_object_get(p,"include"),job->scan_include,&job->scan_include_count)||!copy_patterns(owc_json_object_get(p,"exclude"),job->scan_exclude,&job->scan_exclude_count)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"include/exclude must be arrays of up to 64 non-empty glob patterns (512 bytes each)");}
        /* Snapshot the session read/deny roots so the scan worker never
         * dereferences the live session_config (see index_path_allowed). */
        {session_config *snapshot=session_find(session);size_t r;
        for(r=0;snapshot&&r<snapshot->read_root_count;r++){job->scan_read_roots[job->scan_read_root_count]=copy_text(snapshot->read_roots[r]);if(!job->scan_read_roots[job->scan_read_root_count])break;job->scan_read_root_count++;}
        for(r=0;snapshot&&r<snapshot->deny_count;r++){job->scan_deny_roots[job->scan_deny_root_count]=copy_text(snapshot->deny_paths[r]);if(!job->scan_deny_roots[job->scan_deny_root_count])break;job->scan_deny_root_count++;}
        if(!snapshot||job->scan_read_root_count!=snapshot->read_root_count||job->scan_deny_root_count!=snapshot->deny_count){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}}
    } else if(is_search) {
        const char *path=owc_json_get_string(owc_json_object_get(p,"path"));const char *pattern=owc_json_get_string(owc_json_object_get(p,"pattern"));const owc_json *value;size_t number=0;
        if(!path||!path[0]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"job.start requires a non-empty path");}
        if(!pattern||!pattern[0]||!owc_fs_utf8_valid(pattern,strlen(pattern))){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"job.start requires a non-empty pattern");}
        if(!session_path_check(session_find(session),path,OWC_PATH_READ)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32002,"path is denied by session policy");}
        job->scan_path=copy_text(path);job->search_pattern=copy_text(pattern);
        job->scan_max_nodes=OWC_SEARCH_DEFAULT_NODES;job->scan_max_depth=OWC_SEARCH_DEFAULT_DEPTH;job->scan_max_ms=OWC_SEARCH_DEFAULT_MS;
        value=owc_json_object_get(p,"maxNodes");if(value&&(!json_size(value,&number)||!number||number>OWC_SEARCH_NODES_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxNodes must be an integer from 1 to 1000000");}if(value)job->scan_max_nodes=(unsigned long)number;
        value=owc_json_object_get(p,"maxDepth");if(value&&(!json_size(value,&number)||number>OWC_SEARCH_DEPTH_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxDepth must be an integer from 0 to 64");}if(value)job->scan_max_depth=(unsigned long)number;
        value=owc_json_object_get(p,"maxMs");if(value&&(!json_size(value,&number)||!number||number>OWC_SEARCH_MS_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxMs must be an integer from 1 to 300000");}if(value)job->scan_max_ms=(int)number;
        if(!copy_patterns(owc_json_object_get(p,"include"),job->scan_include,&job->scan_include_count)||!copy_patterns(owc_json_object_get(p,"exclude"),job->scan_exclude,&job->scan_exclude_count)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"include/exclude must be arrays of up to 64 non-empty glob patterns (512 bytes each)");}
        {session_config *snapshot=session_find(session);size_t r;
        for(r=0;snapshot&&r<snapshot->read_root_count;r++){job->scan_read_roots[job->scan_read_root_count]=copy_text(snapshot->read_roots[r]);if(!job->scan_read_roots[job->scan_read_root_count])break;job->scan_read_root_count++;}
        for(r=0;snapshot&&r<snapshot->deny_count;r++){job->scan_deny_roots[job->scan_deny_root_count]=copy_text(snapshot->deny_paths[r]);if(!job->scan_deny_roots[job->scan_deny_root_count])break;job->scan_deny_root_count++;}
        if(!snapshot||job->scan_read_root_count!=snapshot->read_root_count||job->scan_deny_root_count!=snapshot->deny_count){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}}
    } else if(is_extract) {
        const char *path=owc_json_get_string(owc_json_object_get(p,"path"));const owc_json *files=owc_json_object_get(p,"files");const owc_json *value;size_t number=0,f;
        if(!path||!path[0]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"job.start kind index.extract requires a non-empty path");}
        if(!session_path_check(session_find(session),path,OWC_PATH_READ)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32002,"path is denied by session policy");}
        if(!files||files->type!=OWC_JSON_ARRAY||files->value.children.count>OWC_EXTRACT_MAX_FILES){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"job.start kind index.extract requires files to be an array of up to 4096 paths");}
        job->scan_path=copy_text(path);
        job->extract_files=(char**)calloc(files->value.children.count?files->value.children.count:1u,sizeof(char*));
        if(!job->extract_files){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}
        for(f=0;f<files->value.children.count;f++){
            const char *entry=owc_json_get_string(files->value.children.items[f]);
            if(!entry||!entry[0]||strlen(entry)>OWC_EXTRACT_PATH_BYTES||!owc_fs_utf8_valid(entry,strlen(entry))){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"files entries must be non-empty strings of at most 1024 bytes");}
            job->extract_files[job->extract_file_count]=copy_text(entry);
            if(!job->extract_files[job->extract_file_count]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}
            job->extract_file_count++;
        }
        job->scan_max_bytes=OWC_EXTRACT_DEFAULT_BYTES;job->scan_max_ms=OWC_EXTRACT_DEFAULT_MS;job->extract_max_symbols=OWC_EXTRACT_DEFAULT_SYMBOLS;
        value=owc_json_object_get(p,"maxBytes");if(value&&(!json_size(value,&number)||!number||number>OWC_EXTRACT_BYTES_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxBytes must be an integer from 1 to 1073741824");}if(value)job->scan_max_bytes=(unsigned long long)number;
        value=owc_json_object_get(p,"maxMs");if(value&&(!json_size(value,&number)||!number||number>OWC_EXTRACT_MS_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxMs must be an integer from 1 to 300000");}if(value)job->scan_max_ms=(int)number;
        value=owc_json_object_get(p,"maxSymbolsPerFile");if(value&&(!json_size(value,&number)||!number||number>OWC_EXTRACT_SYMBOLS_LIMIT)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"maxSymbolsPerFile must be an integer from 1 to 10000");}if(value)job->extract_max_symbols=(unsigned long)number;
        /* Same read/deny policy snapshot as index.scan (see index_path_allowed). */
        {session_config *snapshot=session_find(session);size_t r;
        for(r=0;snapshot&&r<snapshot->read_root_count;r++){job->scan_read_roots[job->scan_read_root_count]=copy_text(snapshot->read_roots[r]);if(!job->scan_read_roots[job->scan_read_root_count])break;job->scan_read_root_count++;}
        for(r=0;snapshot&&r<snapshot->deny_count;r++){job->scan_deny_roots[job->scan_deny_root_count]=copy_text(snapshot->deny_paths[r]);if(!job->scan_deny_roots[job->scan_deny_root_count])break;job->scan_deny_root_count++;}
        if(!snapshot||job->scan_read_root_count!=snapshot->read_root_count||job->scan_deny_root_count!=snapshot->deny_count){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}}
    } else {
        job->cmd=copy_text(cmd);if(shell_path)job->shell_path=copy_text(shell_path);
        for(i=0;i<allow_count;i++){job->allow_paths[i]=copy_text(allow_paths[i]);if(!job->allow_paths[i]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}job->allow_path_count++;}
        /* Same copy_text snapshot as allow_paths: the worker must never
         * dereference the live session_config after this handler returns. */
        for(i=0;i<bind_count;i++){job->bind_backing[i]=copy_text(bind_backing[i]);if(!job->bind_backing[i]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}job->bind_read_only[i]=bind_read_only[i];job->bind_count++;}
        for(i=0;i<read_root_count;i++){job->read_roots[i]=copy_text(read_roots[i]);if(!job->read_roots[i]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}job->read_root_count++;}
        for(i=0;i<write_root_count;i++){job->write_roots[i]=copy_text(write_roots[i]);if(!job->write_roots[i]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}job->write_root_count++;}
        for(i=0;i<deny_path_count;i++){job->deny_paths[i]=copy_text(deny_paths[i]);if(!job->deny_paths[i]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}job->deny_path_count++;}
        /* Filtered-session state snapshots for the worker, same copy_text
           discipline as the roots above. */
        for(i=0;i<read_only_count;i++){job->read_only_paths[i]=copy_text(read_only_paths[i]);if(!job->read_only_paths[i]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}job->read_only_count++;}
        if(proxy_addr)(void)snprintf(job->proxy_addr,sizeof(job->proxy_addr),"%s",proxy_addr);
    }
    job->sandbox_enabled=enabled;job->allow_network=network;job->sandbox_mode=mode;job->shell_backend=shell_backend;job->memory=memory;job->processes=processes;job->network_filtered=network_filtered;
    job->timeout=120000;{const owc_json *timeout=owc_json_object_get(p,"timeoutMs");if(timeout&&!parse_timeout(timeout,&job->timeout)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"timeoutMs must be a positive integer");}}
    if(!job->id||!job->session||!job->cwd||(!is_scan&&!is_search&&!is_extract&&!job->cmd)||((is_scan||is_search||is_extract)&&!job->scan_path)||(is_search&&!job->search_pattern)||(is_extract&&!job->extract_files)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}
    job->state=OWC_JOB_RUNNING;
    job->thread=CreateThread(NULL,0,job_worker,job,0,NULL);
    if(!job->thread){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"failed to start job");}
    LeaveCriticalSection(&jobs_mutex);
    {char *escaped=owc_json_escape_string(job_id);char result[192];int ok;if(!escaped)return reply_error(rpc,id,-32000,"out of memory");snprintf(result,sizeof(result),"{\"jobId\":%s,\"state\":\"running\"}",escaped);free(escaped);ok=reply_result(rpc,id,result);return ok;}
}
static int handle_job_cancel(owc_rpc *rpc,const owc_json *id,const owc_json *p){static const char *keys[]={"sessionId","jobId"};const char *session,*job_id;owc_job *job;char *escaped;char result[192];if(!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"job.cancel contains unknown fields");session=owc_json_get_string(owc_json_object_get(p,"sessionId"));job_id=owc_json_get_string(owc_json_object_get(p,"jobId"));if(!session||!job_id)return reply_error(rpc,id,-32602,"job.cancel requires sessionId and jobId");jobs_init();EnterCriticalSection(&jobs_mutex);job=find_job(session,job_id);if(!job){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32003,"job not found");}if(job->state==OWC_JOB_RUNNING)job->cancel=1;escaped=owc_json_escape_string(job->id);if(!escaped){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}snprintf(result,sizeof(result),"{\"jobId\":%s,\"accepted\":true}",escaped);free(escaped);LeaveCriticalSection(&jobs_mutex);return reply_result(rpc,id,result);}
static int handle_job_status(owc_rpc *rpc,const owc_json *id,const owc_json *p){static const char *keys[]={"sessionId","jobId"};const char *session,*job_id;owc_job *job;char *escaped,*result;int needed;char error_suffix[128];if(!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"job.status contains unknown fields");session=owc_json_get_string(owc_json_object_get(p,"sessionId"));job_id=owc_json_get_string(owc_json_object_get(p,"jobId"));if(!session||!job_id)return reply_error(rpc,id,-32602,"job.status requires sessionId and jobId");jobs_init();EnterCriticalSection(&jobs_mutex);job=find_job(session,job_id);if(!job){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32003,"job not found");}escaped=owc_json_escape_string(job->id);if(!escaped){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}error_suffix[0]=0;if(job->result.shell_unavailable)(void)snprintf(error_suffix,sizeof(error_suffix),",\"error\":\"%s executable was not found\"",shell_backend_name(job->shell_backend));else if(job->state==OWC_JOB_FAILED&&job->result.system_error)(void)snprintf(error_suffix,sizeof(error_suffix),",\"error\":\"failed to start or monitor command (system error %lu)\"",job->result.system_error);needed=snprintf(NULL,0,"{\"jobId\":%s,\"state\":\"%s\",\"exitCode\":%d,\"durationMs\":%lld,\"truncated\":%s%s}",escaped,job_state_name(job->state),job->result.exit_code,job->result.duration_ms,(job->result.truncated||job->output_truncated)?"true":"false",error_suffix);if(needed<0){free(escaped);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"failed to encode job status");}result=(char*)malloc((size_t)needed+1);if(!result){free(escaped);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}(void)snprintf(result,(size_t)needed+1,"{\"jobId\":%s,\"state\":\"%s\",\"exitCode\":%d,\"durationMs\":%lld,\"truncated\":%s%s}",escaped,job_state_name(job->state),job->result.exit_code,job->result.duration_ms,(job->result.truncated||job->output_truncated)?"true":"false",error_suffix);free(escaped);LeaveCriticalSection(&jobs_mutex);{int ok=reply_result(rpc,id,result);free(result);return ok;}}
static int handle_job_output(owc_rpc *rpc,const owc_json *id,const owc_json *p){static const char *keys[]={"sessionId","jobId","afterSeq","limit"};const char *session,*job_id;const owc_json *value;size_t after=0,limit=64,i,emitted=0;unsigned next_sequence;owc_job *job;char *result;if(!allowed_keys(p,keys,4))return reply_error(rpc,id,-32602,"job.output contains unknown fields");session=owc_json_get_string(owc_json_object_get(p,"sessionId"));job_id=owc_json_get_string(owc_json_object_get(p,"jobId"));value=owc_json_object_get(p,"afterSeq");if(!session||!job_id||!value||!json_size(value,&after)||after>UINT_MAX)return reply_error(rpc,id,-32602,"job.output requires sessionId, jobId, and non-negative afterSeq");value=owc_json_object_get(p,"limit");if(value&&(!json_size(value,&limit)||!limit||limit>OWC_JOB_OUTPUT_CHUNKS))return reply_error(rpc,id,-32602,"job.output limit must be an integer from 1 to 128");jobs_init();EnterCriticalSection(&jobs_mutex);job=find_job(session,job_id);if(!job){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32003,"job not found");}next_sequence=(unsigned)after;result=(char*)malloc(12);if(!result){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}strcpy(result,"{\"chunks\":[");for(i=0;i<job->output_count&&emitted<limit;i++){owc_job_chunk *chunk=&job->output[(job->output_start+i)%OWC_JOB_OUTPUT_CHUNKS];char *data;if(chunk->sequence<=after)continue;data=base64_encode(chunk->data,chunk->length);if(!data){free(result);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}{char *grown;size_t used=strlen(result),add=(size_t)snprintf(NULL,0,"%s{\"seq\":%u,\"stream\":\"%s\",\"data\":\"%s\"}",emitted?",":"",chunk->sequence,chunk->stream,data);grown=(char*)realloc(result,used+add+1);if(!grown){free(data);free(result);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}result=grown;snprintf(result+used,add+1,"%s{\"seq\":%u,\"stream\":\"%s\",\"data\":\"%s\"}",emitted?",":"",chunk->sequence,chunk->stream,data);free(data);emitted++;next_sequence=chunk->sequence;}}{char *grown;size_t used=strlen(result),suffix=(size_t)snprintf(NULL,0,"],\"nextSeq\":%u,\"truncated\":%s}",next_sequence,job->output_truncated?"true":"false");grown=(char*)realloc(result,used+suffix+1);if(!grown){free(result);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}result=grown;snprintf(result+used,suffix+1,"],\"nextSeq\":%u,\"truncated\":%s}",next_sequence,job->output_truncated?"true":"false");}LeaveCriticalSection(&jobs_mutex);i=reply_result(rpc,id,result);free(result);return (int)i;}

/* ------------------------------------------------------------------ */
/* pty.*: interactive pseudo-terminal channels (human terminal and future
 * persistent agent shells).  One reader thread per PTY streams pty.output
 * notifications (exec.output precedent); a final pty.exit notification
 * carries the exit code.  Reader threads write frames concurrently with
 * the main dispatch loop, so all frame writes go through the serialized
 * owc_rpc_write. */
typedef struct { unsigned id; char *session_id; owc_pty *handle; unsigned next_seq; int exited; int exit_code; owc_rpc *rpc; } pty_record;
static pty_record ptys[OWC_PTY_MAX_CONCURRENT];
static unsigned next_pty_id=1;
static pty_record *pty_find(unsigned id){size_t i;for(i=0;i<OWC_PTY_MAX_CONCURRENT;i++)if(ptys[i].handle&&ptys[i].id==id)return &ptys[i];return NULL;}
static void pty_release(pty_record *record){if(record->handle)owc_pty_close(record->handle);free(record->session_id);memset(record,0,sizeof(*record));}
static void remove_session_ptys(const char *session_id){size_t i;for(i=0;i<OWC_PTY_MAX_CONCURRENT;i++)if(ptys[i].handle&&!strcmp(ptys[i].session_id,session_id))pty_release(&ptys[i]);}
static int parse_pty_id(const owc_json *value,unsigned *pty_id){size_t number;if(!value||!json_size(value,&number)||!number||number>UINT_MAX)return 0;*pty_id=(unsigned)number;return 1;}

/* Runs on the reader thread.  The record stays alive until owc_pty_close
 * has joined this thread, so the callback can never touch a freed record. */
static void pty_output_callback(void *user_data,const unsigned char *data,size_t length){
    pty_record *record=(pty_record*)user_data;char *encoded,*body;size_t body_length;int head;unsigned seq=record->next_seq++;
    encoded=base64_encode(data,length);if(!encoded)return;
    head=snprintf(NULL,0,"{\"jsonrpc\":\"2.0\",\"method\":\"pty.output\",\"params\":{\"ptyId\":%u,\"seq\":%u,\"data\":\"%s\"}}",record->id,seq,encoded);
    if(head<0){free(encoded);return;}
    body_length=(size_t)head;
    body=(char*)malloc(body_length+1);
    if(body){(void)snprintf(body,body_length+1,"{\"jsonrpc\":\"2.0\",\"method\":\"pty.output\",\"params\":{\"ptyId\":%u,\"seq\":%u,\"data\":\"%s\"}}",record->id,seq,encoded);(void)owc_rpc_write(record->rpc,body,body_length);free(body);}
    free(encoded);
}
static void pty_exit_callback(void *user_data,int exit_code){
    pty_record *record=(pty_record*)user_data;char body[160];int length;
    record->exited=1;record->exit_code=exit_code;
    length=snprintf(body,sizeof(body),"{\"jsonrpc\":\"2.0\",\"method\":\"pty.exit\",\"params\":{\"ptyId\":%u,\"exitCode\":%d}}",record->id,exit_code);
    if(length>0&&(size_t)length<sizeof(body))(void)owc_rpc_write(record->rpc,body,(size_t)length);
}

static int handle_pty_open(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"session","shell","cwd","cols","rows","sandbox"};
    const char *session,*shell=NULL,*cwd;const owc_json *value;
    size_t cols,rows,i;int sandbox_requested,enabled,network,mode,network_filtered;
    const char *const *allow_paths,*const *bind_backing;const int *bind_read_only;size_t allow_count,bind_count;unsigned long memory,processes,system_error=0;
    const char *const *read_roots,*const *write_roots,*const *deny_paths;size_t read_root_count,write_root_count,deny_path_count;
    const char *proxy_addr,*const *read_only_paths;size_t read_only_count;
    owc_pty_options options;owc_pty_open_result open_result;owc_pty *handle=NULL;
    pty_record *record;
    if(!allowed_keys(p,keys,6))return reply_error(rpc,id,-32602,"pty.open contains unknown fields");
    session=owc_json_get_string(owc_json_object_get(p,"session"));
    cwd=owc_json_get_string(owc_json_object_get(p,"cwd"));
    if(!session||!session[0]||!cwd||!cwd[0])return reply_error(rpc,id,-32602,"pty.open requires non-empty string session and cwd");
    if(owc_json_object_get(p,"shell")){shell=owc_json_get_string(owc_json_object_get(p,"shell"));if(!shell||!shell[0]||strlen(shell)>1024)return reply_error(rpc,id,-32602,"pty.open shell must be a non-empty string of at most 1024 bytes");}
    value=owc_json_object_get(p,"cols");if(!value||!json_size(value,&cols)||!cols||cols>OWC_PTY_MAX_COLS)return reply_error(rpc,id,-32602,"pty.open cols must be an integer from 1 to 512");
    value=owc_json_object_get(p,"rows");if(!value||!json_size(value,&rows)||!rows||rows>OWC_PTY_MAX_ROWS)return reply_error(rpc,id,-32602,"pty.open rows must be an integer from 1 to 512");
    value=owc_json_object_get(p,"sandbox");if(!value||value->type!=OWC_JSON_BOOL)return reply_error(rpc,id,-32602,"pty.open requires boolean sandbox");
    sandbox_requested=value->value.boolean;
    /* cwd must be the configured session root: the session path policy owns
     * what a PTY may start in, same gate as exec.run. */
    if(!session_exec_policy(session,cwd,&enabled,&network,&mode,&allow_paths,&allow_count,&memory,&processes,&bind_backing,&bind_read_only,&bind_count,&read_roots,&read_root_count,&write_roots,&write_root_count,&deny_paths,&deny_path_count,&network_filtered,&proxy_addr,&read_only_paths,&read_only_count))return reply_error(rpc,id,-32002,"session cwd is not configured");
    if(!owc_pty_supported())return reply_error(rpc,id,-32000,"pty is not supported on this platform");
    for(i=0;i<OWC_PTY_MAX_CONCURRENT;i++)if(!ptys[i].handle)break;
    if(i==OWC_PTY_MAX_CONCURRENT)return reply_error(rpc,id,-32000,"pty limit reached");
    record=&ptys[i];
    /* Populate the record before open: the reader thread can fire the output
     * callback the moment it starts. */
    record->id=next_pty_id++;if(!next_pty_id)next_pty_id=1;
    record->rpc=rpc;record->next_seq=0;record->exited=0;
    record->session_id=copy_text(session);
    if(!record->session_id){memset(record,0,sizeof(*record));return reply_error(rpc,id,-32000,"out of memory");}
    memset(&options,0,sizeof(options));memset(&open_result,0,sizeof(open_result));
    options.shell=shell;
    options.cwd=cwd;options.session_id=session;
    options.cols=(int)cols;options.rows=(int)rows;
    /* sandbox=1 的语义是"按会话策略沙盒化"：策略 enabled=false（sandboxMode=off）
     * 时必须回落到未沙盒化，否则 pty 通道会绕过 exec.run/job.start 都遵守的关闭语义。 */
    options.sandbox=sandbox_requested&&enabled;
    options.allow_network=network;options.sandbox_mode=mode;
    options.allow_paths=allow_paths;options.allow_path_count=allow_count;
    options.read_roots=read_roots;options.read_root_count=read_root_count;
    options.write_roots=write_roots;options.write_root_count=write_root_count;
    options.deny_paths=deny_paths;options.deny_path_count=deny_path_count;
    options.bind_backing=bind_backing;options.bind_read_only=bind_read_only;options.bind_count=bind_count;
    options.network_filtered=network_filtered;options.proxy_addr=proxy_addr;
    options.read_only_paths=read_only_paths;options.read_only_count=read_only_count;
    options.job_memory_mb=memory;options.job_max_processes=processes;
    if(!owc_pty_open(&options,pty_output_callback,pty_exit_callback,record,&handle,&open_result,&system_error)){
        char message[96];(void)snprintf(message,sizeof(message),"failed to open pty (system error %lu)",system_error);
        free(record->session_id);memset(record,0,sizeof(*record));
        return reply_error(rpc,id,-32000,message);
    }
    record->handle=handle;
    {char *reason=owc_json_escape_string(open_result.sandbox_reason[0]?open_result.sandbox_reason:"sandbox not requested");char result_text[512];int ok;
    if(!reason)return reply_error(rpc,id,-32000,"failed to encode sandbox status");
    (void)snprintf(result_text,sizeof(result_text),"{\"ptyId\":%u,\"sandboxCapability\":\"%s\",\"sandboxReason\":%s}",record->id,owc_sandbox_status_name((owc_sandbox_status)open_result.sandbox_status),reason);free(reason);
    ok=reply_result(rpc,id,result_text);return ok;}
}

static int handle_pty_input(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"ptyId","data"};const char *encoded;unsigned pty_id;pty_record *record;unsigned char *decoded=NULL;size_t decoded_length=0;
    if(!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"pty.input contains unknown fields");
    if(!parse_pty_id(owc_json_object_get(p,"ptyId"),&pty_id))return reply_error(rpc,id,-32602,"pty.input requires positive ptyId");
    encoded=owc_json_get_string(owc_json_object_get(p,"data"));
    if(!encoded||!base64_decode_bounded(encoded,&decoded,&decoded_length))return reply_error(rpc,id,-32602,"pty.input data must be canonical base64");
    if(decoded_length>OWC_PTY_MAX_INPUT_BYTES){free(decoded);return reply_error(rpc,id,-32602,"pty.input data must decode to at most 8192 bytes");}
    record=pty_find(pty_id);if(!record){free(decoded);return reply_error(rpc,id,-32003,"pty not found");}
    if(record->exited){free(decoded);return reply_error(rpc,id,-32000,"pty has exited");}
    if(!owc_pty_write(record->handle,decoded,decoded_length)){free(decoded);return reply_error(rpc,id,-32000,"failed to write to pty");}
    free(decoded);
    return reply_result(rpc,id,"{\"ok\":true}");
}

static int handle_pty_resize(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"ptyId","cols","rows"};const owc_json *value;size_t cols,rows;unsigned pty_id;pty_record *record;
    if(!allowed_keys(p,keys,3))return reply_error(rpc,id,-32602,"pty.resize contains unknown fields");
    if(!parse_pty_id(owc_json_object_get(p,"ptyId"),&pty_id))return reply_error(rpc,id,-32602,"pty.resize requires positive ptyId");
    value=owc_json_object_get(p,"cols");if(!value||!json_size(value,&cols)||!cols||cols>OWC_PTY_MAX_COLS)return reply_error(rpc,id,-32602,"pty.resize cols must be an integer from 1 to 512");
    value=owc_json_object_get(p,"rows");if(!value||!json_size(value,&rows)||!rows||rows>OWC_PTY_MAX_ROWS)return reply_error(rpc,id,-32602,"pty.resize rows must be an integer from 1 to 512");
    record=pty_find(pty_id);if(!record)return reply_error(rpc,id,-32003,"pty not found");
    if(record->exited)return reply_error(rpc,id,-32000,"pty has exited");
    if(!owc_pty_resize(record->handle,(int)cols,(int)rows))return reply_error(rpc,id,-32000,"failed to resize pty");
    return reply_result(rpc,id,"{\"ok\":true}");
}

static int handle_pty_close(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"ptyId"};unsigned pty_id;pty_record *record;int exited,exit_code;
    if(!allowed_keys(p,keys,1))return reply_error(rpc,id,-32602,"pty.close contains unknown fields");
    if(!parse_pty_id(owc_json_object_get(p,"ptyId"),&pty_id))return reply_error(rpc,id,-32602,"pty.close requires positive ptyId");
    record=pty_find(pty_id);if(!record)return reply_error(rpc,id,-32003,"pty not found");
    exited=record->exited;exit_code=record->exit_code;
    pty_release(record);
    if(exited){char result_text[96];(void)snprintf(result_text,sizeof(result_text),"{\"ok\":true,\"exitCode\":%d}",exit_code);return reply_result(rpc,id,result_text);}
    return reply_result(rpc,id,"{\"ok\":true}");
}

/* ------------------------------------------------------------------ */
/* overlay.*: Linux overlayfs snapshot primitives for the server snapshot
 * backend.  Trusted host-level operations (same trust boundary as pty.*):
 * no session sandbox applies, so every path argument is validated here
 * (absolute, no dot components, UTF-8, root-bound strictly below the
 * caller-supplied stateRoot; lower only needs to exist as a directory),
 * and the POSIX implementation re-resolves with realpath before touching
 * the fs so symlink escapes are refused as well. */
#define OWC_OVERLAY_MAX_PATH 4096u
static int overlay_path_form(const char *path) {
    /* Absolute POSIX path without any "." or ".." component.  Backslashes
     * are refused outright: they are legitimate Linux filename bytes but
     * never appear in state directories, and refusing them keeps
     * Windows-style path tricks out of the trusted boundary. */
    const char *cursor;
    if(!path||path[0]!='/'||strlen(path)>OWC_OVERLAY_MAX_PATH||strchr(path,'\\')) return 0;
    if(!owc_fs_utf8_valid(path,strlen(path))) return 0;
    cursor=path;
    while(*cursor) {
        const char *end;size_t length;
        while(*cursor=='/') cursor++;
        if(!*cursor) break;
        end=cursor;
        while(*end&&*end!='/') end++;
        length=(size_t)(end-cursor);
        if((length==1&&cursor[0]=='.')||(length==2&&cursor[0]=='.'&&cursor[1]=='.')) return 0;
        cursor=end;
    }
    return 1;
}
/* Strictly-below check on the lexical form (both inputs already passed
 * overlay_path_form): path must sit under root and must not be root. */
static int overlay_within_root(const char *path,const char *root) {
    size_t root_length=strlen(root);
    while(root_length>1&&root[root_length-1]=='/') root_length--;
    if(root_length<strlen(root)){char buf[OWC_OVERLAY_MAX_PATH+1];if(root_length>=sizeof(buf))return 0;memcpy(buf,root,root_length);buf[root_length]='\0';root=buf;return overlay_within_root(path,root);}
    if(!owc_path_is_within(path,root)) return 0;
    return strlen(path)>root_length;
}
static int overlay_reply_supported(owc_rpc *rpc,const owc_json *id) {
    if(owc_overlay_supported()) return 1;
    (void)reply_error(rpc,id,-32000,"overlay snapshot primitives are not supported on this platform");
    return 0;
}
static int handle_overlay_mount(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"stateRoot","lower","upper","work","merged"};
    const char *state_root,*lower,*upper,*work,*merged;char err[256];int method=0;char result[64];
    if(!p||p->type!=OWC_JSON_OBJECT||!allowed_keys(p,keys,5))return reply_error(rpc,id,-32602,"overlay.mount contains unknown fields");
    state_root=owc_json_get_string(owc_json_object_get(p,"stateRoot"));
    lower=owc_json_get_string(owc_json_object_get(p,"lower"));
    upper=owc_json_get_string(owc_json_object_get(p,"upper"));
    work=owc_json_get_string(owc_json_object_get(p,"work"));
    merged=owc_json_get_string(owc_json_object_get(p,"merged"));
    if(!overlay_path_form(state_root)||!overlay_path_form(lower)||!overlay_path_form(upper)||!overlay_path_form(work)||!overlay_path_form(merged))return reply_error(rpc,id,-32602,"overlay.mount paths must be absolute UTF-8 without dot components");
    if(!overlay_within_root(upper,state_root)||!overlay_within_root(work,state_root)||!overlay_within_root(merged,state_root))return reply_error(rpc,id,-32002,"upper, work, and merged must be strictly below stateRoot");
    if(!strcmp(lower,merged))return reply_error(rpc,id,-32602,"merged must differ from lower");
    if(!overlay_reply_supported(rpc,id))return 1;
    if(!owc_overlay_mount(state_root,lower,upper,work,merged,&method,err,sizeof(err)))return reply_error(rpc,id,-32000,err);
    (void)snprintf(result,sizeof(result),"{\"ok\":true,\"method\":\"%s\"}",method==OWC_OVERLAY_METHOD_KERNEL?"kernel":"fuse");
    return reply_result(rpc,id,result);
}
static int handle_overlay_checkpoint(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"stateRoot","upper","dest"};
    const char *state_root,*upper,*dest;char err[256];owc_overlay_copy_summary summary;char result[128];
    if(!p||p->type!=OWC_JSON_OBJECT||!allowed_keys(p,keys,3))return reply_error(rpc,id,-32602,"overlay.checkpoint contains unknown fields");
    state_root=owc_json_get_string(owc_json_object_get(p,"stateRoot"));
    upper=owc_json_get_string(owc_json_object_get(p,"upper"));
    dest=owc_json_get_string(owc_json_object_get(p,"dest"));
    if(!overlay_path_form(state_root)||!overlay_path_form(upper)||!overlay_path_form(dest))return reply_error(rpc,id,-32602,"overlay.checkpoint paths must be absolute UTF-8 without dot components");
    if(!overlay_within_root(upper,state_root)||!overlay_within_root(dest,state_root))return reply_error(rpc,id,-32002,"upper and dest must be strictly below stateRoot");
    if(!overlay_reply_supported(rpc,id))return 1;
    if(!owc_overlay_copy_tree(state_root,upper,dest,&summary,err,sizeof(err)))return reply_error(rpc,id,-32000,err);
    (void)snprintf(result,sizeof(result),"{\"ok\":true,\"files\":%llu,\"bytes\":%llu,\"skipped\":%llu}",summary.files,summary.bytes,summary.skipped);
    return reply_result(rpc,id,result);
}
static int handle_overlay_restore(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"stateRoot","lower","upper","work","merged","sourceUpper"};
    const char *state_root,*lower,*upper,*work,*merged,*source_upper;char err[256];owc_overlay_copy_summary summary;char result[128];size_t i;
    if(!p||p->type!=OWC_JSON_OBJECT||!allowed_keys(p,keys,6))return reply_error(rpc,id,-32602,"overlay.restore contains unknown fields");
    state_root=owc_json_get_string(owc_json_object_get(p,"stateRoot"));
    lower=owc_json_get_string(owc_json_object_get(p,"lower"));
    upper=owc_json_get_string(owc_json_object_get(p,"upper"));
    work=owc_json_get_string(owc_json_object_get(p,"work"));
    merged=owc_json_get_string(owc_json_object_get(p,"merged"));
    source_upper=owc_json_get_string(owc_json_object_get(p,"sourceUpper"));
    if(!overlay_path_form(state_root)||!overlay_path_form(lower)||!overlay_path_form(upper)||!overlay_path_form(work)||!overlay_path_form(merged)||!overlay_path_form(source_upper))return reply_error(rpc,id,-32602,"overlay.restore paths must be absolute UTF-8 without dot components");
    if(!overlay_within_root(upper,state_root)||!overlay_within_root(work,state_root)||!overlay_within_root(merged,state_root)||!overlay_within_root(source_upper,state_root))return reply_error(rpc,id,-32002,"upper, work, merged, and sourceUpper must be strictly below stateRoot");
    if(!strcmp(lower,merged))return reply_error(rpc,id,-32602,"merged must differ from lower");
    if(!strcmp(source_upper,upper))return reply_error(rpc,id,-32602,"sourceUpper must differ from upper");
    /* Restoring while a job (exec/index scan/search) still walks the tree
     * would tear the fs under it.  Refuse with a stable conflict code. */
    jobs_init();EnterCriticalSection(&jobs_mutex);
    for(i=0;i<OWC_JOB_MAX_RUNNING&&jobs[i].state!=OWC_JOB_RUNNING;i++);
    LeaveCriticalSection(&jobs_mutex);
    if(i<OWC_JOB_MAX_RUNNING)return reply_error(rpc,id,-32005,"overlay.restore requires no running jobs");
    if(!overlay_reply_supported(rpc,id))return 1;
    if(!owc_overlay_unmount(merged,err,sizeof(err)))return reply_error(rpc,id,-32000,err);
    /* Kernel/fuse overlayfs can leave artifacts in the work dir; it must be
     * empty for the remount below.  Safe to clear only after the unmount. */
    if(!owc_overlay_clear_dir(state_root,work,err,sizeof(err)))return reply_error(rpc,id,-32000,err);
    if(!owc_overlay_clear_dir(state_root,upper,err,sizeof(err)))return reply_error(rpc,id,-32000,err);
    if(!owc_overlay_copy_tree(state_root,source_upper,upper,&summary,err,sizeof(err)))return reply_error(rpc,id,-32000,err);
    {int method=0;char mount_err[256];
    if(!owc_overlay_mount(state_root,lower,upper,work,merged,&method,mount_err,sizeof(mount_err)))return reply_error(rpc,id,-32000,mount_err);
    (void)snprintf(result,sizeof(result),"{\"ok\":true,\"files\":%llu,\"bytes\":%llu,\"skipped\":%llu,\"method\":\"%s\"}",summary.files,summary.bytes,summary.skipped,method==OWC_OVERLAY_METHOD_KERNEL?"kernel":"fuse");}
    return reply_result(rpc,id,result);
}
static int handle_overlay_unmount(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"stateRoot","merged"};
    const char *state_root,*merged;char err[256];
    if(!p||p->type!=OWC_JSON_OBJECT||!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"overlay.unmount contains unknown fields");
    state_root=owc_json_get_string(owc_json_object_get(p,"stateRoot"));
    merged=owc_json_get_string(owc_json_object_get(p,"merged"));
    if(!overlay_path_form(state_root)||!overlay_path_form(merged))return reply_error(rpc,id,-32602,"overlay.unmount paths must be absolute UTF-8 without dot components");
    if(!overlay_within_root(merged,state_root))return reply_error(rpc,id,-32002,"merged must be strictly below stateRoot");
    if(!overlay_reply_supported(rpc,id))return 1;
    if(!owc_overlay_unmount(merged,err,sizeof(err)))return reply_error(rpc,id,-32000,err);
    return reply_result(rpc,id,"{\"ok\":true}");
}

static int handle_fs(owc_rpc *rpc,const owc_json *id,const char *method,const owc_json *p){
    const char *cwd,*path,*content,*old,*replacement,*session_id; owc_fs_error e; char *a,*b; char canon[4096]; size_t off=0,lim=OWC_FS_DEFAULT_READ_LINES,i,matches=0; int option;
    static const char *rp[]={"sessionId","path","offset","limit"},*wp[]={"sessionId","path","content","createDirs","expectedSha256"},*bp[]={"sessionId","path","data","createDirs"},*ep[]={"sessionId","path","oldText","newText","replaceAll"},*searchp[]={"sessionId","path","pattern"},*sp[]={"sessionId","path"};
    session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));path=owc_json_get_string(owc_json_object_get(p,"path"));cwd=session_id?session_root(session_id):NULL;if(!cwd||!path)return reply_error(rpc,id,-32602,"sessionId must identify a configured session and path must be a string");if(!session_path_allowed(session_id,path,(!strcmp(method,"fs.write")||!strcmp(method,"fs.writeBase64")||!strcmp(method,"fs.edit"))?OWC_PATH_WRITE:OWC_PATH_READ))return reply_error(rpc,id,-32002,"path is denied by session policy");    /* Path compatibility lives here in C, not in the model: absolute paths
       and dot-segment forms are rewritten to their resolved canonical path
       (the policy gate above already approved the same resolution), so the
       platform layer always sees a clean in-root path it already accepts. */
    if(path[0]=='/'||path[0]=='\\'||(path[0]&&path[1]==':')||strstr(path,"..")){char *resolved=session_policy_path(cwd,path);if(resolved){if(strlen(resolved)<sizeof(canon)){memcpy(canon,resolved,strlen(resolved)+1);path=canon;}free(resolved);}}
    if(!strcmp(method,"fs.read")){owc_fs_read_result r;const owc_json *value;if(!allowed_keys(p,rp,4))return reply_error(rpc,id,-32602,"fs.read contains unknown fields");value=owc_json_object_get(p,"offset");if(value&&!json_size(value,&off))return reply_error(rpc,id,-32602,"offset must be a non-negative integer");value=owc_json_object_get(p,"limit");if(value&&(!json_size(value,&lim)||!lim))return reply_error(rpc,id,-32602,"limit must be a positive integer");e=owc_fs_read(cwd,path,off,lim,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));a=owc_json_escape_string(r.content);if(!a){owc_fs_read_free(&r);return reply_error(rpc,id,-32000,"out of memory");}i=(size_t)snprintf(NULL,0,"{\"content\":%s,\"totalLines\":%zu,\"encoding\":\"utf-8\",\"truncated\":%s}",a,r.total_lines,r.truncated?"true":"false");b=(char*)malloc(i+1);if(b)snprintf(b,i+1,"{\"content\":%s,\"totalLines\":%zu,\"encoding\":\"utf-8\",\"truncated\":%s}",a,r.total_lines,r.truncated?"true":"false");free(a);owc_fs_read_free(&r);if(!b)return reply_error(rpc,id,-32000,"out of memory");i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.write")){const char *expected=owc_json_get_string(owc_json_object_get(p,"expectedSha256"));if(!allowed_keys(p,wp,5)||(content=owc_json_get_string(owc_json_object_get(p,"content")))==NULL||!json_bool(owc_json_object_get(p,"createDirs"),0,&option))return reply_error(rpc,id,-32602,"fs.write requires string sessionId, path, content, and optional createDirs/expectedSha256");if(owc_json_object_get(p,"expectedSha256")){char digest[65];size_t hashed_size=0,j;if(!expected||strlen(expected)!=64)return reply_error(rpc,id,-32602,"expectedSha256 must be a 64-character lowercase hex digest");for(j=0;j<64;j++)if(!((expected[j]>='0'&&expected[j]<='9')||(expected[j]>='a'&&expected[j]<='f')))return reply_error(rpc,id,-32602,"expectedSha256 must be a 64-character lowercase hex digest");e=owc_fs_hash(cwd,path,digest,&hashed_size);if(e==OWC_FS_NOT_FOUND||(!e&&strcmp(digest,expected)))return reply_error(rpc,id,-32004,"file changed since it was read");if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));}e=owc_fs_write(cwd,path,content,strlen(content),option);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));return reply_result(rpc,id,"{\"ok\":true}");}
    if(!strcmp(method,"fs.writeBase64")){const char *encoded;unsigned char *decoded=NULL;size_t decoded_length=0;if(!allowed_keys(p,bp,4)||(encoded=owc_json_get_string(owc_json_object_get(p,"data")))==NULL||!json_bool(owc_json_object_get(p,"createDirs"),0,&option))return reply_error(rpc,id,-32602,"fs.writeBase64 requires string sessionId, path, data, and optional boolean createDirs");if(!base64_decode_bounded(encoded,&decoded,&decoded_length))return reply_error(rpc,id,-32602,"fs.writeBase64 data must be canonical base64 no larger than 20 MiB");e=owc_fs_write_binary(cwd,path,decoded,decoded_length,option);free(decoded);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));return reply_result(rpc,id,"{\"ok\":true}");}
    if(!strcmp(method,"fs.edit")){if(!allowed_keys(p,ep,5)||(old=owc_json_get_string(owc_json_object_get(p,"oldText")))==NULL||(replacement=owc_json_get_string(owc_json_object_get(p,"newText")))==NULL||!json_bool(owc_json_object_get(p,"replaceAll"),0,&option))return reply_error(rpc,id,-32602,"fs.edit requires string sessionId, path, oldText, newText, and optional boolean replaceAll");e=owc_fs_edit(cwd,path,old,strlen(old),replacement,strlen(replacement),option,&matches);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(64);if(!b)return reply_error(rpc,id,-32000,"out of memory");snprintf(b,64,"{\"matches\":%zu}",matches);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.glob")){owc_fs_glob_result r;const char *pattern=owc_json_get_string(owc_json_object_get(p,"pattern"));if(!allowed_keys(p,searchp,3)||!pattern)return reply_error(rpc,id,-32602,"fs.glob requires string sessionId, path, and pattern");e=owc_fs_glob(cwd,path,pattern,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(12+32);if(!b){owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}strcpy(b,"{\"paths\":[");for(i=0;i<r.count;i++){char*q=owc_json_escape_string(r.paths[i]);size_t oldn=strlen(b),add;if(!q){free(b);owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}add=strlen(q)+(i?1u:0u);{char *grown=(char*)realloc(b,oldn+add+32);if(!grown){free(q);free(b);owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}b=grown;}snprintf(b+oldn,add+1,"%s%s",i?",":"",q);free(q);}i=strlen(b);snprintf(b+i,32,"],\"truncated\":%s}",r.truncated?"true":"false");owc_fs_glob_free(&r);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.grep")){owc_fs_grep_result r;const char *pattern=owc_json_get_string(owc_json_object_get(p,"pattern"));if(!allowed_keys(p,searchp,3)||!pattern)return reply_error(rpc,id,-32602,"fs.grep requires string sessionId, path, and pattern");e=owc_fs_grep(cwd,path,pattern,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(14+32);if(!b){owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}strcpy(b,"{\"matches\":[");for(i=0;i<r.count;i++){char*q=owc_json_escape_string(r.matches[i].path),*t=owc_json_escape_string(r.matches[i].text);size_t oldn=strlen(b),add;if(!q||!t){free(q);free(t);free(b);owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}add=(size_t)snprintf(NULL,0,"%s{\"path\":%s,\"line\":%zu,\"text\":%s}",i?",":"",q,r.matches[i].line,t);{char *grown=(char*)realloc(b,oldn+add+32);if(!grown){free(q);free(t);free(b);owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}b=grown;}snprintf(b+oldn,add+1,"%s{\"path\":%s,\"line\":%zu,\"text\":%s}",i?",":"",q,r.matches[i].line,t);free(q);free(t);}i=strlen(b);snprintf(b+i,32,"],\"truncated\":%s}",r.truncated?"true":"false");owc_fs_grep_free(&r);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!allowed_keys(p,sp,2))return reply_error(rpc,id,-32602,"operation contains unknown fields");
    if(!strcmp(method,"fs.stat")){owc_fs_stat_result r;e=owc_fs_stat(cwd,path,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(256);if(!b)return reply_error(rpc,id,-32000,"out of memory");snprintf(b,256,"{\"type\":\"%s\",\"size\":%llu,\"modifiedMs\":%lld}",type_name(r.type),r.size,r.modified_ms);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.hash")){char digest[65];size_t size=0;e=owc_fs_hash(cwd,path,digest,&size);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(128);if(!b)return reply_error(rpc,id,-32000,"out of memory");snprintf(b,128,"{\"sha256\":\"%s\",\"size\":%zu}",digest,size);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.readBase64")){owc_fs_binary_result r;char *encoded;size_t n;e=owc_fs_read_binary(cwd,path,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));encoded=base64_encode(r.data,r.size);if(!encoded){owc_fs_binary_free(&r);return reply_error(rpc,id,-32000,"out of memory");}n=(size_t)snprintf(NULL,0,"{\"base64\":\"%s\",\"size\":%zu,\"truncated\":%s}",encoded,r.size,r.truncated?"true":"false");b=(char*)malloc(n+1);if(b)snprintf(b,n+1,"{\"base64\":\"%s\",\"size\":%zu,\"truncated\":%s}",encoded,r.size,r.truncated?"true":"false");free(encoded);owc_fs_binary_free(&r);if(!b)return reply_error(rpc,id,-32000,"out of memory");i=reply_result(rpc,id,b);free(b);return (int)i;}
    {owc_fs_list_result r;e=owc_fs_list(cwd,path,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(13+32);if(!b){owc_fs_list_free(&r);return reply_error(rpc,id,-32000,"out of memory");}strcpy(b,"{\"entries\":[");for(i=0;i<r.count;i++){char*q=owc_json_escape_string(r.entries[i].name);size_t oldn=strlen(b),add;if(!q){free(b);owc_fs_list_free(&r);return reply_error(rpc,id,-32000,"out of memory");}add=(size_t)snprintf(NULL,0,"%s{\"name\":%s,\"type\":\"%s\",\"size\":%llu}",i?",":"",q,type_name(r.entries[i].type),r.entries[i].size);{char *grown=(char*)realloc(b,oldn+add+32);if(!grown){free(q);free(b);owc_fs_list_free(&r);return reply_error(rpc,id,-32000,"out of memory");}b=grown;}snprintf(b+oldn,add+1,"%s{\"name\":%s,\"type\":\"%s\",\"size\":%llu}",i?",":"",q,type_name(r.entries[i].type),r.entries[i].size);free(q);}i=strlen(b);snprintf(b+i,32,"],\"truncated\":%s}",r.truncated?"true":"false");owc_fs_list_free(&r);i=reply_result(rpc,id,b);free(b);return (int)i;}
}

int owc_rpc_dispatch(owc_rpc *rpc, const char *body, size_t length) {
    const char *error_at=NULL,*method,*version; owc_json *root=owc_json_parse(body,length,&error_at);
    const owc_json *id,*params;
    (void)error_at;
    if(!root) return reply_error(rpc,NULL,-32700,"parse error");
    id=owc_json_object_get(root,"id"); version=owc_json_get_string(owc_json_object_get(root,"jsonrpc")); method=owc_json_get_string(owc_json_object_get(root,"method")); params=owc_json_object_get(root,"params");
    rpc->suppress_responses=0;
    write_mutex_init();
    if(!version || strcmp(version,"2.0")!=0 || !method || (id && id->type!=OWC_JSON_NULL && id->type!=OWC_JSON_STRING && id->type!=OWC_JSON_NUMBER)) { int ok=reply_error(rpc,id,-32600,"invalid request"); owc_json_free(root); return ok; }
    rpc->suppress_responses=id==NULL;
    if(strcmp(method,"core.ping")==0) {
        if(params&&!allowed_keys(params,NULL,0))(void)reply_error(rpc,id,-32602,"core.ping accepts no params fields");else{
#ifdef _WIN32
        const char *platform="windows";
#else
        const char *platform="linux";
#endif
        char reason[192],*escaped,*result;size_t result_size;owc_sandbox_status capability=owc_sandbox_probe(reason,sizeof(reason));
#ifdef _WIN32
        const char *job_control="true";
#else
        const char *job_control="false";
#endif
        const char *pty_available=owc_pty_supported()?"true":"false";
        owc_overlay_capabilities overlay_caps;owc_overlay_probe(&overlay_caps);
        owc_sandbox_result bwrap_caps;char *escaped_bwrap;owc_bwrap_probe(&bwrap_caps);
        escaped_bwrap=owc_json_escape_string(bwrap_caps.reason);
        escaped=owc_json_escape_string(reason);if(!escaped||!escaped_bwrap){free(escaped);free(escaped_bwrap);(void)reply_error(rpc,id,-32000,"failed to encode sandbox capability");}else{result_size=(size_t)snprintf(NULL,0,"{\"version\":\"%s\",\"protocolVersion\":\"1.0\",\"platform\":\"%s\",\"sandboxCapability\":\"%s\",\"sandboxReason\":%s,\"features\":{\"fsStat\":true,\"fsStatMany\":true,\"fsWriteBase64\":true,\"fsReadBase64\":true,\"jobControl\":%s,\"fsHash\":true,\"fsScanPagination\":true,\"fsWatch\":true,\"indexScan\":true,\"grepJob\":true,\"globJob\":true,\"indexExtract\":true,\"pathNormalize\":true,\"shellBash\":true,\"pty\":%s,\"bindLink\":%s,\"overlay\":{\"supported\":%s,\"fuseOverlayfs\":%s,\"kernelMount\":%s},\"bwrap\":{\"available\":%s,\"reason\":%s}},\"limits\":{\"maxFrameBytes\":33554432,\"maxWriteBase64Bytes\":20971520,\"maxReadBase64Bytes\":20971520,\"maxHashBytes\":16777216,\"maxStatManyPaths\":128,\"maxStatManyPathBytes\":262144,\"maxScanEntries\":256,\"maxScanDepth\":16,\"maxScanNodes\":2048,\"maxWatches\":16,\"maxWatchEvents\":128,\"maxConcurrentJobs\":4,\"maxJobOutputBytes\":524288,\"maxIndexScanNodes\":1000000,\"maxIndexScanDepth\":64,\"maxIndexScanBytes\":17179869184,\"maxIndexScanMs\":600000,\"maxSearchNodes\":1000000,\"maxSearchDepth\":64,\"maxSearchMs\":300000,\"maxIndexExtractFiles\":4096,\"maxIndexExtractBytes\":1073741824,\"maxIndexExtractMs\":300000,\"indexExtractDefaultSymbolsPerFile\":200,\"maxIndexExtractSymbolsPerFile\":10000,\"maxConcurrentPtys\":16,\"maxPtyOutputChunkBytes\":65536,\"maxPtyInputBytes\":8192}}",OWC_CORE_VERSION,platform,owc_sandbox_status_name(capability),escaped,job_control,pty_available,owc_bindlink_supported()?"true":"false",overlay_caps.supported?"true":"false",overlay_caps.fuse_overlayfs?"true":"false",overlay_caps.kernel_mount?"true":"false",bwrap_caps.status==OWC_SANDBOX_ENFORCED?"true":"false",escaped_bwrap);result=(char*)malloc(result_size+1);if(!result)(void)reply_error(rpc,id,-32000,"failed to encode core capabilities");else{(void)snprintf(result,result_size+1,"{\"version\":\"%s\",\"protocolVersion\":\"1.0\",\"platform\":\"%s\",\"sandboxCapability\":\"%s\",\"sandboxReason\":%s,\"features\":{\"fsStat\":true,\"fsStatMany\":true,\"fsWriteBase64\":true,\"fsReadBase64\":true,\"jobControl\":%s,\"fsHash\":true,\"fsScanPagination\":true,\"fsWatch\":true,\"indexScan\":true,\"grepJob\":true,\"globJob\":true,\"indexExtract\":true,\"pathNormalize\":true,\"shellBash\":true,\"pty\":%s,\"bindLink\":%s,\"overlay\":{\"supported\":%s,\"fuseOverlayfs\":%s,\"kernelMount\":%s},\"bwrap\":{\"available\":%s,\"reason\":%s}},\"limits\":{\"maxFrameBytes\":33554432,\"maxWriteBase64Bytes\":20971520,\"maxReadBase64Bytes\":20971520,\"maxHashBytes\":16777216,\"maxStatManyPaths\":128,\"maxStatManyPathBytes\":262144,\"maxScanEntries\":256,\"maxScanDepth\":16,\"maxScanNodes\":2048,\"maxWatches\":16,\"maxWatchEvents\":128,\"maxConcurrentJobs\":4,\"maxJobOutputBytes\":524288,\"maxIndexScanNodes\":1000000,\"maxIndexScanDepth\":64,\"maxIndexScanBytes\":17179869184,\"maxIndexScanMs\":600000,\"maxSearchNodes\":1000000,\"maxSearchDepth\":64,\"maxSearchMs\":300000,\"maxIndexExtractFiles\":4096,\"maxIndexExtractBytes\":1073741824,\"maxIndexExtractMs\":300000,\"indexExtractDefaultSymbolsPerFile\":200,\"maxIndexExtractSymbolsPerFile\":10000,\"maxConcurrentPtys\":16,\"maxPtyOutputChunkBytes\":65536,\"maxPtyInputBytes\":8192}}",OWC_CORE_VERSION,platform,owc_sandbox_status_name(capability),escaped,job_control,pty_available,owc_bindlink_supported()?"true":"false",overlay_caps.supported?"true":"false",overlay_caps.fuse_overlayfs?"true":"false",overlay_caps.kernel_mount?"true":"false",bwrap_caps.status==OWC_SANDBOX_ENFORCED?"true":"false",escaped_bwrap);(void)reply_result(rpc,id,result);free(result);}free(escaped);free(escaped_bwrap);}}
    } else if(strcmp(method,"core.shutdown")==0) { if(params&&!allowed_keys(params,NULL,0))(void)reply_error(rpc,id,-32602,"core.shutdown accepts no params fields");else{(void)reply_result(rpc,id,"{\"ok\":true}"); rpc->shutting_down=1;} }
    else if(strcmp(method,"session.configure")==0) { static const char *keys[]={"sessionId","cwd","sandbox"};const char *sid=owc_json_get_string(owc_json_object_get(params,"sessionId")),*cwd=owc_json_get_string(owc_json_object_get(params,"cwd"));char err[192];int code=-32000;if(params&&!allowed_keys(params,keys,3))(void)reply_error(rpc,id,-32602,"session.configure contains unknown fields");else if(!sid||!sid[0]||!cwd||!cwd[0])(void)reply_error(rpc,id,-32602,"session.configure requires sessionId and cwd");else{err[0]='\0';if(!configure_session(sid,cwd,owc_json_object_get(params,"sandbox"),err,sizeof(err),&code))(void)reply_error(rpc,id,code,err);else(void)reply_session_capability(rpc,id,sid);} }
    else if(strcmp(method,"session.cleanup")==0) { static const char *keys[]={"sessionId"};const char *sid=owc_json_get_string(owc_json_object_get(params,"sessionId"));if(params&&!allowed_keys(params,keys,1))(void)reply_error(rpc,id,-32602,"session.cleanup contains unknown fields");else if(!sid||!sid[0])(void)reply_error(rpc,id,-32602,"session.cleanup requires sessionId");else{(void)cleanup_session(sid);(void)reply_result(rpc,id,"{\"ok\":true}");} }
    else if(strcmp(method,"exec.run")==0) (void)handle_exec_run(rpc,id,params);
    else if(strcmp(method,"job.start")==0) (void)handle_job_start(rpc,id,params);
    else if(strcmp(method,"job.cancel")==0) (void)handle_job_cancel(rpc,id,params);
    else if(strcmp(method,"job.status")==0) (void)handle_job_status(rpc,id,params);
    else if(strcmp(method,"job.output")==0) (void)handle_job_output(rpc,id,params);
    else if(strcmp(method,"path.normalize")==0) (void)handle_path_normalize(rpc,id,params);
    else if(strcmp(method,"fs.statMany")==0) (void)handle_fs_stat_many(rpc,id,params);
    else if(strcmp(method,"fs.scan")==0) (void)handle_fs_scan(rpc,id,params);
    else if(strcmp(method,"fs.watch")==0) (void)handle_fs_watch_start(rpc,id,params);
    else if(strcmp(method,"fs.watch.poll")==0) (void)handle_fs_watch_poll(rpc,id,params);
    else if(strcmp(method,"fs.watch.cancel")==0) (void)handle_fs_watch_cancel(rpc,id,params);
    else if(strcmp(method,"fs.read")==0 || strcmp(method,"fs.readBase64")==0 || strcmp(method,"fs.write")==0 || strcmp(method,"fs.writeBase64")==0 || strcmp(method,"fs.edit")==0 || strcmp(method,"fs.stat")==0 || strcmp(method,"fs.hash")==0 || strcmp(method,"fs.list")==0 || strcmp(method,"fs.glob")==0 || strcmp(method,"fs.grep")==0) (void)handle_fs(rpc,id,method,params);
    else if(strcmp(method,"pty.open")==0) (void)handle_pty_open(rpc,id,params);
    else if(strcmp(method,"pty.input")==0) (void)handle_pty_input(rpc,id,params);
    else if(strcmp(method,"pty.resize")==0) (void)handle_pty_resize(rpc,id,params);
    else if(strcmp(method,"pty.close")==0) (void)handle_pty_close(rpc,id,params);
    else if(strcmp(method,"overlay.mount")==0) (void)handle_overlay_mount(rpc,id,params);
    else if(strcmp(method,"overlay.checkpoint")==0) (void)handle_overlay_checkpoint(rpc,id,params);
    else if(strcmp(method,"overlay.restore")==0) (void)handle_overlay_restore(rpc,id,params);
    else if(strcmp(method,"overlay.unmount")==0) (void)handle_overlay_unmount(rpc,id,params);
    else (void)reply_error(rpc,id,-32601,"method not found");
    rpc->suppress_responses=0; owc_json_free(root); return 1;
}
