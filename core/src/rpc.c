#include "rpc.h"
#include "exec.h"
#include "fs.h"
#include "json.h"
#include "path_policy.h"
#include "sandbox.h"

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
#endif

static int write_format(owc_rpc *rpc, const char *format, ...) {
    va_list args, copy; int length; char *body;
    va_start(args,format); va_copy(copy,args); length=vsnprintf(NULL,0,format,args); va_end(args);
    if(length<0) { va_end(copy); return 0; }
    body=(char *)malloc((size_t)length+1); if(!body) { va_end(copy); return 0; }
    (void)vsnprintf(body,(size_t)length+1,format,copy); va_end(copy);
    { int ok=owc_rpc_write(rpc,body,(size_t)length); free(body); return ok; }
}

int owc_rpc_write(owc_rpc *rpc, const char *body, size_t length) {
    if(fprintf(rpc->output,"Content-Length: %zu\r\n\r\n",length)<0) return 0;
    if(length && fwrite(body,1,length,rpc->output)!=length) return 0;
    return fflush(rpc->output)==0;
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

static int session_exec_policy(const char *id,const char *cwd,int *enabled,int *allow_network,int *mode,const char *const **allow_paths,size_t *allow_path_count,unsigned long *job_memory_mb,unsigned long *job_max_processes);
static void remove_session_watches(const char *session_id);
static void cancel_session_jobs(const char *session_id);

static int parse_shell_backend(const owc_json *params, int *backend) {
    const owc_json *value=owc_json_object_get(params,"shellBackend");
    const char *name;
    *backend=(int)OWC_SHELL_DEFAULT;
    if(!value)return 1;
    name=owc_json_get_string(value);
    if(!name)return 0;
    if(!strcmp(name,"default"))return 1;
    if(!strcmp(name,"pwsh")){*backend=(int)OWC_SHELL_PWSH;return 1;}
    return 0;
}

static int handle_exec_run(owc_rpc *rpc,const owc_json *id,const owc_json *params) {
    const char *command=owc_json_get_string(owc_json_object_get(params,"cmd"));
    const char *cwd=owc_json_get_string(owc_json_object_get(params,"cwd"));
    const char *exec_id=owc_json_get_string(owc_json_object_get(params,"execId"));
    const char *session_id=owc_json_get_string(owc_json_object_get(params,"sessionId"));
    owc_exec_request request; owc_exec_result result; output_context context; int sandbox_enabled,allow_network,sandbox_mode; unsigned long job_memory_mb,job_max_processes;
    if(!params || params->type!=OWC_JSON_OBJECT || !command || !cwd || !exec_id || !session_id || !command[0] || !cwd[0] || !exec_id[0] || !session_id[0]) return reply_error(rpc,id,-32602,"exec.run requires non-empty string sessionId, execId, cmd, and cwd");
    memset(&request,0,sizeof(request)); context.rpc=rpc; context.exec_id=exec_id;
    if(!parse_shell_backend(params,&request.shell_backend))return reply_error(rpc,id,-32602,"shellBackend must be default or pwsh");
    if(!session_exec_policy(session_id,cwd,&sandbox_enabled,&allow_network,&sandbox_mode,&request.allow_paths,&request.allow_path_count,&job_memory_mb,&job_max_processes))return reply_error(rpc,id,-32002,"session cwd is not configured");
    request.command=command; request.cwd=cwd; request.session_id=session_id;request.sandbox_enabled=sandbox_enabled;request.allow_network=allow_network;request.sandbox_mode=sandbox_mode;
    request.job_memory_mb=job_memory_mb; request.job_max_processes=job_max_processes;
    if(!parse_timeout(owc_json_object_get(params,"timeoutMs"),&request.timeout_ms)) return reply_error(rpc,id,-32602,"timeoutMs must be a positive integer");
    request.output_limit=10u*1024u*1024u; request.on_output=output_notification; request.user_data=&context;
    if(!owc_exec_run(&request,&result)) { char message[96];if(result.shell_unavailable)return reply_error(rpc,id,-32000,"pwsh executable was not found");(void)snprintf(message,sizeof(message),"failed to start or monitor command (system error %lu)",result.system_error);return reply_error(rpc,id,-32000,message); }
    if(result.timed_out) return reply_error(rpc,id,-32001,"command timed out");
    {
        char result_text[640];char *reason=owc_json_escape_string(result.sandbox_reason[0]?result.sandbox_reason:"sandbox not requested");if(!reason)return reply_error(rpc,id,-32000,"failed to encode sandbox status");
        (void)snprintf(result_text,sizeof(result_text),"{\"exitCode\":%d,\"durationMs\":%lld,\"truncated\":%s,\"sandboxCapability\":\"%s\",\"sandboxReason\":%s}",
            result.exit_code,result.duration_ms,result.truncated?"true":"false",owc_sandbox_status_name((owc_sandbox_status)result.sandbox_status),reason);free(reason);
        return reply_result(rpc,id,result_text);
    }
}

typedef struct { char *session_id; char *cwd; char *deny_paths[16]; size_t deny_count; char *read_roots[16]; size_t read_root_count; char *write_roots[16]; size_t write_root_count; char *allow_paths[16]; size_t allow_count; int sandbox_enabled; int allow_network; int sandbox_mode; unsigned long job_memory_mb; unsigned long job_max_processes; } session_config;
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
static int session_exec_policy(const char *id,const char *cwd,int *enabled,int *allow_network,int *mode,const char *const **allow_paths,size_t *allow_path_count,unsigned long *job_memory_mb,unsigned long *job_max_processes){session_config *session=session_find(id);if(!session||!policy_path_equal(session->cwd,cwd))return 0;*enabled=session->sandbox_enabled;*allow_network=session->allow_network;*mode=session->sandbox_mode;*allow_paths=(const char *const *)session->allow_paths;*allow_path_count=session->allow_count;*job_memory_mb=session->job_memory_mb;*job_max_processes=session->job_max_processes;return 1;}
/* Filesystem primitives accept workspace-relative paths.  Normalize those
 * paths before comparing policy roots so cosmetic forms such as ./private do
 * not bypass an absolute deny root.  Traversal and absolute paths are denied
 * here as well as by the no-follow platform implementation. */
static char *session_policy_path(const session_config *session,const char *path){const char *cursor;char *out;size_t capacity,used,components=0;if(!session||!path||!path[0]||path[0]=='/'||path[0]=='\\'||(path[0]&&path[1]==':'))return NULL;capacity=strlen(session->cwd)+strlen(path)+3;out=(char*)malloc(capacity);if(!out)return NULL;used=strlen(session->cwd);memcpy(out,session->cwd,used);while(used&& (out[used-1]=='/'||out[used-1]=='\\'))used--;out[used]='\0';cursor=path;while(*cursor){const char *end;size_t length;while(*cursor=='/'||*cursor=='\\')cursor++;if(!*cursor)break;end=cursor;while(*end&&*end!='/'&&*end!='\\')end++;length=(size_t)(end-cursor);if(length==1&&cursor[0]=='.'){cursor=end;continue;}if(length==2&&cursor[0]=='.'&&cursor[1]=='.'){free(out);return NULL;}if(++components>256u){free(out);return NULL;}if(used&&out[used-1]!='/'&&out[used-1]!='\\')out[used++]='/';memcpy(out+used,cursor,length);used+=length;out[used]='\0';cursor=end;}return out;}
static int session_path_allowed(const char *id,const char *path,owc_path_permission permission){session_config *session=session_find(id);owc_path_policy policy;char *canonical;int allowed;if(!session)return 0;canonical=session_policy_path(session,path);if(!canonical)return 0;memset(&policy,0,sizeof(policy));policy.read_roots=(const char *const *)session->read_roots;policy.read_root_count=session->read_root_count;policy.write_roots=(const char *const *)session->write_roots;policy.write_root_count=session->write_root_count;policy.deny_roots=(const char *const *)session->deny_paths;policy.deny_root_count=session->deny_count;allowed=owc_path_policy_check(&policy,canonical,permission);free(canonical);return allowed;}
static int configure_session(const char *id,const char *cwd){size_t i;char *root=copy_text(cwd);if(!root)return 0;for(i=0;i<session_count;i++)if(!strcmp(sessions[i].session_id,id)){remove_session_watches(id);free(sessions[i].cwd);sessions[i].cwd=root;return 1;}if(session_count>=sizeof(sessions)/sizeof(sessions[0])){free(root);return 0;}memset(&sessions[session_count],0,sizeof(sessions[0]));sessions[session_count].session_id=copy_text(id);if(!sessions[session_count].session_id){free(root);return 0;}sessions[session_count].cwd=root;session_count++;return 1;}
static void clear_denies(session_config *session){size_t i;for(i=0;i<session->deny_count;i++)free(session->deny_paths[i]);session->deny_count=0;}
static void clear_allows(session_config *session){size_t i;for(i=0;i<session->allow_count;i++)free(session->allow_paths[i]);session->allow_count=0;}
static void clear_roots(char **roots,size_t *count){size_t i;for(i=0;i<*count;i++)free(roots[i]);*count=0;}
static int copy_string_array(const owc_json *array,char **values,size_t *count){size_t i;if(!array)return 1;if(array->type!=OWC_JSON_ARRAY||array->value.children.count>16)return 0;for(i=0;i<array->value.children.count;i++){const char *value=owc_json_get_string(array->value.children.items[i]);if(!value||!value[0])return 0;values[*count]=copy_text(value);if(!values[*count])return 0;(*count)++;}return 1;}
static int configure_policy(const char *id,const owc_json *sandbox){session_config *session=session_find(id);const owc_json *denies,*allows,*reads,*writes,*enabled,*network,*mode,*job_memory,*job_processes;if(!session)return 0;clear_denies(session);clear_allows(session);clear_roots(session->read_roots,&session->read_root_count);clear_roots(session->write_roots,&session->write_root_count);session->sandbox_enabled=1;session->allow_network=1;session->sandbox_mode=(int)OWC_SANDBOX_MODE_APPCONTAINER;session->job_memory_mb=OWC_JOB_DEFAULT_MEMORY_MB;session->job_max_processes=OWC_JOB_DEFAULT_MAX_PROCESSES;if(!sandbox)return (session->read_roots[session->read_root_count++]=copy_text(session->cwd))!=NULL&&(session->write_roots[session->write_root_count++]=copy_text(session->cwd))!=NULL;if(sandbox->type!=OWC_JSON_OBJECT)return 0;enabled=owc_json_object_get(sandbox,"enabled");network=owc_json_object_get(sandbox,"network");mode=owc_json_object_get(sandbox,"mode");if(enabled){if(enabled->type!=OWC_JSON_BOOL)return 0;session->sandbox_enabled=enabled->value.boolean;}if(network){const char *value=owc_json_get_string(network);if(!value||(strcmp(value,"allow")&&strcmp(value,"deny")))return 0;session->allow_network=!strcmp(value,"allow");}if(mode){const char *value=owc_json_get_string(mode);if(!value)return 0;if(!strcmp(value,"appcontainer"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_APPCONTAINER;else if(!strcmp(value,"jobobject"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_JOBOBJECT;else if(!strcmp(value,"off"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_OFF;else return 0;if(session->sandbox_mode==(int)OWC_SANDBOX_MODE_OFF)session->sandbox_enabled=0;}job_memory=owc_json_object_get(sandbox,"jobMemoryMB");if(job_memory&&!parse_job_limit(job_memory,1048576ul,&session->job_memory_mb))return 0;job_processes=owc_json_object_get(sandbox,"jobMaxProcesses");if(job_processes&&!parse_job_limit(job_processes,4096ul,&session->job_max_processes))return 0;allows=owc_json_object_get(sandbox,"allowPaths");denies=owc_json_object_get(sandbox,"denyPaths");reads=owc_json_object_get(sandbox,"readRoots");writes=owc_json_object_get(sandbox,"writeRoots");if(!reads){session->read_roots[session->read_root_count++]=copy_text(session->cwd);if(!session->read_roots[0])return 0;}if(!writes){session->write_roots[session->write_root_count++]=copy_text(session->cwd);if(!session->write_roots[0])return 0;}if(!copy_string_array(allows,session->allow_paths,&session->allow_count)||!copy_string_array(denies,session->deny_paths,&session->deny_count)||!copy_string_array(reads,session->read_roots,&session->read_root_count)||!copy_string_array(writes,session->write_roots,&session->write_root_count)){clear_allows(session);clear_denies(session);clear_roots(session->read_roots,&session->read_root_count);clear_roots(session->write_roots,&session->write_root_count);return 0;}return 1;}
static int cleanup_session(const char *id){size_t i;remove_session_watches(id);cancel_session_jobs(id);for(i=0;i<session_count;i++)if(!strcmp(sessions[i].session_id,id)){clear_denies(&sessions[i]);clear_allows(&sessions[i]);clear_roots(sessions[i].read_roots,&sessions[i].read_root_count);clear_roots(sessions[i].write_roots,&sessions[i].write_root_count);free(sessions[i].session_id);free(sessions[i].cwd);sessions[i]=sessions[session_count-1];session_count--;return 1;}return 0;}

static int reply_session_capability(owc_rpc *rpc,const owc_json *id,const char *sid){session_config *session=session_find(sid);char reason[192],detail[192],result[640];char *escaped,*escaped_detail=NULL;owc_sandbox_status status;int ok;if(!session)return reply_error(rpc,id,-32000,"session was not configured");detail[0]='\0';if(!session->sandbox_enabled){status=OWC_SANDBOX_ADVISORY;(void)snprintf(reason,sizeof(reason),"sandbox disabled by session policy");}else if(session->sandbox_mode==(int)OWC_SANDBOX_MODE_JOBOBJECT){status=OWC_SANDBOX_PARTIAL;(void)snprintf(reason,sizeof(reason),"Job Object compatibility mode requested by session policy");(void)snprintf(detail,sizeof(detail),"Job Object limits active processes to %lu and committed memory to %lu MB; no filesystem or network isolation (requires AppContainer)",session->job_max_processes,session->job_memory_mb);}else{
#ifdef _WIN32
 status=owc_sandbox_probe(reason,sizeof(reason));
#else
 owc_sandbox_result probe;owc_landlock_probe(session->allow_network,&probe);status=probe.status;(void)snprintf(reason,sizeof(reason),"%s",probe.reason);
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
    result=(char*)malloc(12);if(!result){owc_fs_watch_result_free(&events);return reply_error(rpc,id,-32000,"out of memory");}strcpy(result,"{\"events\":[");for(i=0;i<events.count;i++){char *path=owc_json_escape_string(events.events[i].path),*grown;size_t used,add;if(!path){free(result);owc_fs_watch_result_free(&events);return reply_error(rpc,id,-32000,"out of memory");}used=strlen(result);add=(size_t)snprintf(NULL,0,"%s{\"path\":%s,\"kind\":\"%s\"}",i?",":"",path,events.events[i].kind);grown=(char*)realloc(result,used+add+48);if(!grown){free(path);free(result);owc_fs_watch_result_free(&events);return reply_error(rpc,id,-32000,"out of memory");}result=grown;snprintf(result+used,add+1,"%s{\"path\":%s,\"kind\":\"%s\"}",i?",":"",path,events.events[i].kind);free(path);}i=strlen(result);snprintf(result+i,48,"],\"overflow\":%s}",events.overflow?"true":"false");owc_fs_watch_result_free(&events);i=reply_result(rpc,id,result);free(result);return (int)i;
}

static int handle_fs_watch_cancel(owc_rpc *rpc,const owc_json *id,const owc_json *p){
    static const char *keys[]={"sessionId","watchId"};const char *session_id;const owc_json *value;size_t number;if(!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"fs.watch.cancel contains unknown fields");session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));value=owc_json_object_get(p,"watchId");if(!session_id||!value||!json_size(value,&number)||!number||number>UINT_MAX)return reply_error(rpc,id,-32602,"fs.watch.cancel requires sessionId and positive watchId");{fs_watch_record *record=find_watch(session_id,(unsigned)number);if(!record)return reply_error(rpc,id,-32003,"watch not found");clear_watch(record);}return reply_result(rpc,id,"{\"ok\":true}");
}

#if 1
#define OWC_JOB_MAX_RUNNING 4u
#define OWC_JOB_OUTPUT_CHUNKS 128u
#define OWC_JOB_OUTPUT_CHUNK_BYTES 4096u
typedef enum { OWC_JOB_EMPTY,OWC_JOB_RUNNING,OWC_JOB_COMPLETED,OWC_JOB_FAILED,OWC_JOB_CANCELLED,OWC_JOB_TIMED_OUT } owc_job_state;
typedef struct {unsigned sequence;char stream[7];size_t length;unsigned char data[OWC_JOB_OUTPUT_CHUNK_BYTES];} owc_job_chunk;
typedef struct {char *id,*session,*cmd,*cwd;char *allow_paths[16];size_t allow_path_count;int sandbox_enabled,allow_network,sandbox_mode,shell_backend;unsigned long memory,processes;int timeout;volatile int cancel;owc_job_state state;owc_exec_result result;HANDLE thread;owc_job_chunk output[OWC_JOB_OUTPUT_CHUNKS];size_t output_start,output_count;unsigned next_output_sequence;int output_truncated;} owc_job;
static owc_job jobs[OWC_JOB_MAX_RUNNING];static CRITICAL_SECTION jobs_mutex;static int jobs_ready=0;
static void jobs_init(void){if(!jobs_ready){InitializeCriticalSection(&jobs_mutex);jobs_ready=1;}}
static void job_free(owc_job *job){size_t i;if(job->thread)CloseHandle(job->thread);free(job->id);free(job->session);free(job->cmd);free(job->cwd);for(i=0;i<job->allow_path_count;i++)free(job->allow_paths[i]);memset(job,0,sizeof(*job));}
static void job_output(void *data,const char *stream,const unsigned char *bytes,size_t length,unsigned sequence){owc_job *job=(owc_job*)data;size_t offset=0;(void)sequence;EnterCriticalSection(&jobs_mutex);while(offset<length){owc_job_chunk *chunk;size_t take=length-offset,index;if(job->output_count==OWC_JOB_OUTPUT_CHUNKS){job->output_start=(job->output_start+1u)%OWC_JOB_OUTPUT_CHUNKS;job->output_count--;job->output_truncated=1;}if(take>OWC_JOB_OUTPUT_CHUNK_BYTES)take=OWC_JOB_OUTPUT_CHUNK_BYTES;index=(job->output_start+job->output_count)%OWC_JOB_OUTPUT_CHUNKS;chunk=&job->output[index];chunk->sequence=++job->next_output_sequence;(void)snprintf(chunk->stream,sizeof(chunk->stream),"%s",stream);memcpy(chunk->data,bytes+offset,take);chunk->length=take;job->output_count++;offset+=take;}LeaveCriticalSection(&jobs_mutex);}
static DWORD WINAPI job_worker(void *data){owc_job *job=(owc_job*)data;owc_exec_request request;owc_exec_result result;memset(&request,0,sizeof(request));request.command=job->cmd;request.cwd=job->cwd;request.session_id=job->session;request.allow_paths=(const char *const *)job->allow_paths;request.allow_path_count=job->allow_path_count;request.sandbox_enabled=job->sandbox_enabled;request.allow_network=job->allow_network;request.sandbox_mode=job->sandbox_mode;request.shell_backend=job->shell_backend;request.job_memory_mb=job->memory;request.job_max_processes=job->processes;request.timeout_ms=job->timeout;request.output_limit=1024u*1024u;request.cancel_requested=&job->cancel;request.on_output=job_output;request.user_data=job;(void)owc_exec_run(&request,&result);EnterCriticalSection(&jobs_mutex);job->result=result;if(result.cancelled)job->state=OWC_JOB_CANCELLED;else if(result.timed_out)job->state=OWC_JOB_TIMED_OUT;else if(!result.system_error)job->state=OWC_JOB_COMPLETED;else job->state=OWC_JOB_FAILED;LeaveCriticalSection(&jobs_mutex);return 0;}
static const char *job_state_name(owc_job_state state){return state==OWC_JOB_RUNNING?"running":state==OWC_JOB_COMPLETED?"completed":state==OWC_JOB_CANCELLED?"cancelled":state==OWC_JOB_TIMED_OUT?"timed_out":"failed";}
static owc_job *find_job(const char *session,const char *id){size_t i;for(i=0;i<OWC_JOB_MAX_RUNNING;i++)if(jobs[i].state!=OWC_JOB_EMPTY&&!strcmp(jobs[i].session,session)&&!strcmp(jobs[i].id,id))return &jobs[i];return NULL;}
static void cancel_session_jobs(const char *session_id){size_t i;if(!jobs_ready)return;EnterCriticalSection(&jobs_mutex);for(i=0;i<OWC_JOB_MAX_RUNNING;i++)if(jobs[i].state==OWC_JOB_RUNNING&&!strcmp(jobs[i].session,session_id))jobs[i].cancel=1;LeaveCriticalSection(&jobs_mutex);}
static int handle_job_start(owc_rpc *rpc,const owc_json *id,const owc_json *p){static const char *keys[]={"sessionId","jobId","kind","cmd","cwd","timeoutMs","shellBackend"};const char *session,*job_id,*kind,*cmd,*cwd,*const *allow_paths;int enabled,network,mode,shell_backend;unsigned long memory,processes;size_t allow_count,i;owc_job *job=NULL;if(!allowed_keys(p,keys,7))return reply_error(rpc,id,-32602,"job.start contains unknown fields");session=owc_json_get_string(owc_json_object_get(p,"sessionId"));job_id=owc_json_get_string(owc_json_object_get(p,"jobId"));kind=owc_json_get_string(owc_json_object_get(p,"kind"));cmd=owc_json_get_string(owc_json_object_get(p,"cmd"));cwd=owc_json_get_string(owc_json_object_get(p,"cwd"));if(!session||!job_id||!cmd||!cwd||!job_id[0]||strlen(job_id)>128||!kind||strcmp(kind,"exec"))return reply_error(rpc,id,-32602,"job.start requires sessionId, jobId, kind exec, cmd, and cwd");if(!parse_shell_backend(p,&shell_backend))return reply_error(rpc,id,-32602,"shellBackend must be default or pwsh");if(!session_exec_policy(session,cwd,&enabled,&network,&mode,&allow_paths,&allow_count,&memory,&processes))return reply_error(rpc,id,-32002,"session cwd is not configured");jobs_init();EnterCriticalSection(&jobs_mutex);if(find_job(session,job_id)){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"jobId already exists in this session");}for(i=0;i<OWC_JOB_MAX_RUNNING;i++)if(jobs[i].state!=OWC_JOB_RUNNING)break;if(i==OWC_JOB_MAX_RUNNING){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"job limit reached");}job=&jobs[i];job_free(job);job->id=copy_text(job_id);job->session=copy_text(session);job->cmd=copy_text(cmd);job->cwd=copy_text(cwd);for(i=0;i<allow_count;i++){job->allow_paths[i]=copy_text(allow_paths[i]);if(!job->allow_paths[i]){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}job->allow_path_count++;}job->sandbox_enabled=enabled;job->allow_network=network;job->sandbox_mode=mode;job->shell_backend=shell_backend;job->memory=memory;job->processes=processes;job->timeout=120000;{const owc_json *timeout=owc_json_object_get(p,"timeoutMs");if(timeout&&!parse_timeout(timeout,&job->timeout)){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32602,"timeoutMs must be a positive integer");}}if(!job->id||!job->session||!job->cmd||!job->cwd){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}job->state=OWC_JOB_RUNNING;job->thread=CreateThread(NULL,0,job_worker,job,0,NULL);if(!job->thread){job_free(job);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"failed to start job");}LeaveCriticalSection(&jobs_mutex);{char *escaped=owc_json_escape_string(job_id);char result[192];int ok;if(!escaped)return reply_error(rpc,id,-32000,"out of memory");snprintf(result,sizeof(result),"{\"jobId\":%s,\"state\":\"running\"}",escaped);free(escaped);ok=reply_result(rpc,id,result);return ok;}}
static int handle_job_cancel(owc_rpc *rpc,const owc_json *id,const owc_json *p){static const char *keys[]={"sessionId","jobId"};const char *session,*job_id;owc_job *job;char *escaped;char result[192];if(!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"job.cancel contains unknown fields");session=owc_json_get_string(owc_json_object_get(p,"sessionId"));job_id=owc_json_get_string(owc_json_object_get(p,"jobId"));if(!session||!job_id)return reply_error(rpc,id,-32602,"job.cancel requires sessionId and jobId");jobs_init();EnterCriticalSection(&jobs_mutex);job=find_job(session,job_id);if(!job){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32003,"job not found");}if(job->state==OWC_JOB_RUNNING)job->cancel=1;escaped=owc_json_escape_string(job->id);if(!escaped){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}snprintf(result,sizeof(result),"{\"jobId\":%s,\"accepted\":true}",escaped);free(escaped);LeaveCriticalSection(&jobs_mutex);return reply_result(rpc,id,result);}
static int handle_job_status(owc_rpc *rpc,const owc_json *id,const owc_json *p){static const char *keys[]={"sessionId","jobId"};const char *session,*job_id;owc_job *job;char *escaped,*result;int needed;if(!allowed_keys(p,keys,2))return reply_error(rpc,id,-32602,"job.status contains unknown fields");session=owc_json_get_string(owc_json_object_get(p,"sessionId"));job_id=owc_json_get_string(owc_json_object_get(p,"jobId"));if(!session||!job_id)return reply_error(rpc,id,-32602,"job.status requires sessionId and jobId");jobs_init();EnterCriticalSection(&jobs_mutex);job=find_job(session,job_id);if(!job){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32003,"job not found");}escaped=owc_json_escape_string(job->id);if(!escaped){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}needed=snprintf(NULL,0,"{\"jobId\":%s,\"state\":\"%s\",\"exitCode\":%d,\"durationMs\":%lld,\"truncated\":%s%s}",escaped,job_state_name(job->state),job->result.exit_code,job->result.duration_ms,(job->result.truncated||job->output_truncated)?"true":"false",job->result.shell_unavailable?",\"error\":\"pwsh executable was not found\"":"");if(needed<0){free(escaped);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"failed to encode job status");}result=(char*)malloc((size_t)needed+1);if(!result){free(escaped);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}(void)snprintf(result,(size_t)needed+1,"{\"jobId\":%s,\"state\":\"%s\",\"exitCode\":%d,\"durationMs\":%lld,\"truncated\":%s%s}",escaped,job_state_name(job->state),job->result.exit_code,job->result.duration_ms,(job->result.truncated||job->output_truncated)?"true":"false",job->result.shell_unavailable?",\"error\":\"pwsh executable was not found\"":"");free(escaped);LeaveCriticalSection(&jobs_mutex);{int ok=reply_result(rpc,id,result);free(result);return ok;}}
static int handle_job_output(owc_rpc *rpc,const owc_json *id,const owc_json *p){static const char *keys[]={"sessionId","jobId","afterSeq","limit"};const char *session,*job_id;const owc_json *value;size_t after=0,limit=64,i,emitted=0;unsigned next_sequence;owc_job *job;char *result;if(!allowed_keys(p,keys,4))return reply_error(rpc,id,-32602,"job.output contains unknown fields");session=owc_json_get_string(owc_json_object_get(p,"sessionId"));job_id=owc_json_get_string(owc_json_object_get(p,"jobId"));value=owc_json_object_get(p,"afterSeq");if(!session||!job_id||!value||!json_size(value,&after)||after>UINT_MAX)return reply_error(rpc,id,-32602,"job.output requires sessionId, jobId, and non-negative afterSeq");value=owc_json_object_get(p,"limit");if(value&&(!json_size(value,&limit)||!limit||limit>OWC_JOB_OUTPUT_CHUNKS))return reply_error(rpc,id,-32602,"job.output limit must be an integer from 1 to 128");jobs_init();EnterCriticalSection(&jobs_mutex);job=find_job(session,job_id);if(!job){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32003,"job not found");}next_sequence=(unsigned)after;result=(char*)malloc(12);if(!result){LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}strcpy(result,"{\"chunks\":[");for(i=0;i<job->output_count&&emitted<limit;i++){owc_job_chunk *chunk=&job->output[(job->output_start+i)%OWC_JOB_OUTPUT_CHUNKS];char *data;if(chunk->sequence<=after)continue;data=base64_encode(chunk->data,chunk->length);if(!data){free(result);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}{char *grown;size_t used=strlen(result),add=(size_t)snprintf(NULL,0,"%s{\"seq\":%u,\"stream\":\"%s\",\"data\":\"%s\"}",emitted?",":"",chunk->sequence,chunk->stream,data);grown=(char*)realloc(result,used+add+1);if(!grown){free(data);free(result);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}result=grown;snprintf(result+used,add+1,"%s{\"seq\":%u,\"stream\":\"%s\",\"data\":\"%s\"}",emitted?",":"",chunk->sequence,chunk->stream,data);free(data);emitted++;next_sequence=chunk->sequence;}}{char *grown;size_t used=strlen(result),suffix=(size_t)snprintf(NULL,0,"],\"nextSeq\":%u,\"truncated\":%s}",next_sequence,job->output_truncated?"true":"false");grown=(char*)realloc(result,used+suffix+1);if(!grown){free(result);LeaveCriticalSection(&jobs_mutex);return reply_error(rpc,id,-32000,"out of memory");}result=grown;snprintf(result+used,suffix+1,"],\"nextSeq\":%u,\"truncated\":%s}",next_sequence,job->output_truncated?"true":"false");}LeaveCriticalSection(&jobs_mutex);i=reply_result(rpc,id,result);free(result);return (int)i;}
#endif

static int handle_fs(owc_rpc *rpc,const owc_json *id,const char *method,const owc_json *p){
    const char *cwd,*path,*content,*old,*replacement,*session_id; owc_fs_error e; char *a,*b; size_t off=0,lim=OWC_FS_DEFAULT_READ_LINES,i,matches=0; int option;
    static const char *rp[]={"sessionId","path","offset","limit"},*wp[]={"sessionId","path","content","createDirs"},*bp[]={"sessionId","path","data","createDirs"},*ep[]={"sessionId","path","oldText","newText","replaceAll"},*searchp[]={"sessionId","path","pattern"},*sp[]={"sessionId","path"};
    session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));path=owc_json_get_string(owc_json_object_get(p,"path"));cwd=session_id?session_root(session_id):NULL;if(!cwd||!path)return reply_error(rpc,id,-32602,"sessionId must identify a configured session and path must be a string");if(!session_path_allowed(session_id,path,(!strcmp(method,"fs.write")||!strcmp(method,"fs.writeBase64")||!strcmp(method,"fs.edit"))?OWC_PATH_WRITE:OWC_PATH_READ))return reply_error(rpc,id,-32002,"path is denied by session policy");
    if(!strcmp(method,"fs.read")){owc_fs_read_result r;const owc_json *value;if(!allowed_keys(p,rp,4))return reply_error(rpc,id,-32602,"fs.read contains unknown fields");value=owc_json_object_get(p,"offset");if(value&&!json_size(value,&off))return reply_error(rpc,id,-32602,"offset must be a non-negative integer");value=owc_json_object_get(p,"limit");if(value&&(!json_size(value,&lim)||!lim))return reply_error(rpc,id,-32602,"limit must be a positive integer");e=owc_fs_read(cwd,path,off,lim,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));a=owc_json_escape_string(r.content);if(!a){owc_fs_read_free(&r);return reply_error(rpc,id,-32000,"out of memory");}i=(size_t)snprintf(NULL,0,"{\"content\":%s,\"totalLines\":%zu,\"encoding\":\"utf-8\",\"truncated\":%s}",a,r.total_lines,r.truncated?"true":"false");b=(char*)malloc(i+1);if(b)snprintf(b,i+1,"{\"content\":%s,\"totalLines\":%zu,\"encoding\":\"utf-8\",\"truncated\":%s}",a,r.total_lines,r.truncated?"true":"false");free(a);owc_fs_read_free(&r);if(!b)return reply_error(rpc,id,-32000,"out of memory");i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.write")){if(!allowed_keys(p,wp,4)||(content=owc_json_get_string(owc_json_object_get(p,"content")))==NULL||!json_bool(owc_json_object_get(p,"createDirs"),0,&option))return reply_error(rpc,id,-32602,"fs.write requires string cwd, path, content, and optional boolean createDirs");e=owc_fs_write(cwd,path,content,strlen(content),option);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));return reply_result(rpc,id,"{\"ok\":true}");}
    if(!strcmp(method,"fs.writeBase64")){const char *encoded;unsigned char *decoded=NULL;size_t decoded_length=0;if(!allowed_keys(p,bp,4)||(encoded=owc_json_get_string(owc_json_object_get(p,"data")))==NULL||!json_bool(owc_json_object_get(p,"createDirs"),0,&option))return reply_error(rpc,id,-32602,"fs.writeBase64 requires string sessionId, path, data, and optional boolean createDirs");if(!base64_decode_bounded(encoded,&decoded,&decoded_length))return reply_error(rpc,id,-32602,"fs.writeBase64 data must be canonical base64 no larger than 20 MiB");e=owc_fs_write_binary(cwd,path,decoded,decoded_length,option);free(decoded);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));return reply_result(rpc,id,"{\"ok\":true}");}
    if(!strcmp(method,"fs.edit")){if(!allowed_keys(p,ep,5)||(old=owc_json_get_string(owc_json_object_get(p,"oldText")))==NULL||(replacement=owc_json_get_string(owc_json_object_get(p,"newText")))==NULL||!json_bool(owc_json_object_get(p,"replaceAll"),0,&option))return reply_error(rpc,id,-32602,"fs.edit requires string cwd, path, oldText, newText, and optional boolean replaceAll");e=owc_fs_edit(cwd,path,old,strlen(old),replacement,strlen(replacement),option,&matches);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(64);if(!b)return reply_error(rpc,id,-32000,"out of memory");snprintf(b,64,"{\"matches\":%zu}",matches);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.glob")){owc_fs_glob_result r;const char *pattern=owc_json_get_string(owc_json_object_get(p,"pattern"));if(!allowed_keys(p,searchp,3)||!pattern)return reply_error(rpc,id,-32602,"fs.glob requires string cwd, path, and pattern");e=owc_fs_glob(cwd,path,pattern,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(12);if(!b){owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}strcpy(b,"{\"paths\":[");for(i=0;i<r.count;i++){char*q=owc_json_escape_string(r.paths[i]);size_t oldn=strlen(b),add;if(!q){free(b);owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}add=strlen(q)+(i?1u:0u);{char *grown=(char*)realloc(b,oldn+add+32);if(!grown){free(q);free(b);owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}b=grown;}snprintf(b+oldn,add+1,"%s%s",i?",":"",q);free(q);}i=strlen(b);snprintf(b+i,32,"],\"truncated\":%s}",r.truncated?"true":"false");owc_fs_glob_free(&r);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.grep")){owc_fs_grep_result r;const char *pattern=owc_json_get_string(owc_json_object_get(p,"pattern"));if(!allowed_keys(p,searchp,3)||!pattern)return reply_error(rpc,id,-32602,"fs.grep requires string cwd, path, and pattern");e=owc_fs_grep(cwd,path,pattern,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(14);if(!b){owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}strcpy(b,"{\"matches\":[");for(i=0;i<r.count;i++){char*q=owc_json_escape_string(r.matches[i].path),*t=owc_json_escape_string(r.matches[i].text);size_t oldn=strlen(b),add;if(!q||!t){free(q);free(t);free(b);owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}add=(size_t)snprintf(NULL,0,"%s{\"path\":%s,\"line\":%zu,\"text\":%s}",i?",":"",q,r.matches[i].line,t);{char *grown=(char*)realloc(b,oldn+add+32);if(!grown){free(q);free(t);free(b);owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}b=grown;}snprintf(b+oldn,add+1,"%s{\"path\":%s,\"line\":%zu,\"text\":%s}",i?",":"",q,r.matches[i].line,t);free(q);free(t);}i=strlen(b);snprintf(b+i,32,"],\"truncated\":%s}",r.truncated?"true":"false");owc_fs_grep_free(&r);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!allowed_keys(p,sp,2))return reply_error(rpc,id,-32602,"operation contains unknown fields");
    if(!strcmp(method,"fs.stat")){owc_fs_stat_result r;e=owc_fs_stat(cwd,path,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(256);if(!b)return reply_error(rpc,id,-32000,"out of memory");snprintf(b,256,"{\"type\":\"%s\",\"size\":%llu,\"modifiedMs\":%lld}",type_name(r.type),r.size,r.modified_ms);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.hash")){char digest[65];size_t size=0;e=owc_fs_hash(cwd,path,digest,&size);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(128);if(!b)return reply_error(rpc,id,-32000,"out of memory");snprintf(b,128,"{\"sha256\":\"%s\",\"size\":%zu}",digest,size);i=reply_result(rpc,id,b);free(b);return (int)i;}
    {owc_fs_list_result r;e=owc_fs_list(cwd,path,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(13);if(!b){owc_fs_list_free(&r);return reply_error(rpc,id,-32000,"out of memory");}strcpy(b,"{\"entries\":[");for(i=0;i<r.count;i++){char*q=owc_json_escape_string(r.entries[i].name);size_t oldn=strlen(b),add;if(!q){free(b);owc_fs_list_free(&r);return reply_error(rpc,id,-32000,"out of memory");}add=(size_t)snprintf(NULL,0,"%s{\"name\":%s,\"type\":\"%s\",\"size\":%llu}",i?",":"",q,type_name(r.entries[i].type),r.entries[i].size);{char *grown=(char*)realloc(b,oldn+add+32);if(!grown){free(q);free(b);owc_fs_list_free(&r);return reply_error(rpc,id,-32000,"out of memory");}b=grown;}snprintf(b+oldn,add+1,"%s{\"name\":%s,\"type\":\"%s\",\"size\":%llu}",i?",":"",q,type_name(r.entries[i].type),r.entries[i].size);free(q);}i=strlen(b);snprintf(b+i,32,"],\"truncated\":%s}",r.truncated?"true":"false");owc_fs_list_free(&r);i=reply_result(rpc,id,b);free(b);return (int)i;}
}

int owc_rpc_dispatch(owc_rpc *rpc, const char *body, size_t length) {
    const char *error_at=NULL,*method,*version; owc_json *root=owc_json_parse(body,length,&error_at);
    const owc_json *id,*params;
    (void)error_at;
    if(!root) return reply_error(rpc,NULL,-32700,"parse error");
    id=owc_json_object_get(root,"id"); version=owc_json_get_string(owc_json_object_get(root,"jsonrpc")); method=owc_json_get_string(owc_json_object_get(root,"method")); params=owc_json_object_get(root,"params");
    rpc->suppress_responses=0;
    if(!version || strcmp(version,"2.0")!=0 || !method || (id && id->type!=OWC_JSON_NULL && id->type!=OWC_JSON_STRING && id->type!=OWC_JSON_NUMBER)) { int ok=reply_error(rpc,id,-32600,"invalid request"); owc_json_free(root); return ok; }
    rpc->suppress_responses=id==NULL;
    if(strcmp(method,"core.ping")==0) {
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
        escaped=owc_json_escape_string(reason);if(!escaped)(void)reply_error(rpc,id,-32000,"failed to encode sandbox capability");else{result_size=(size_t)snprintf(NULL,0,"{\"version\":\"0.3.6\",\"protocolVersion\":\"1.0\",\"platform\":\"%s\",\"sandboxCapability\":\"%s\",\"sandboxReason\":%s,\"features\":{\"fsStat\":true,\"fsStatMany\":true,\"fsWriteBase64\":true,\"jobControl\":%s,\"fsHash\":true,\"fsScanPagination\":true,\"fsWatch\":true},\"limits\":{\"maxFrameBytes\":33554432,\"maxWriteBase64Bytes\":20971520,\"maxHashBytes\":16777216,\"maxStatManyPaths\":128,\"maxStatManyPathBytes\":262144,\"maxScanEntries\":256,\"maxScanDepth\":16,\"maxScanNodes\":2048,\"maxWatches\":16,\"maxWatchEvents\":128,\"maxConcurrentJobs\":4,\"maxJobOutputBytes\":524288}}",platform,owc_sandbox_status_name(capability),escaped,job_control);result=(char*)malloc(result_size+1);if(!result)(void)reply_error(rpc,id,-32000,"failed to encode core capabilities");else{(void)snprintf(result,result_size+1,"{\"version\":\"0.3.6\",\"protocolVersion\":\"1.0\",\"platform\":\"%s\",\"sandboxCapability\":\"%s\",\"sandboxReason\":%s,\"features\":{\"fsStat\":true,\"fsStatMany\":true,\"fsWriteBase64\":true,\"jobControl\":%s,\"fsHash\":true,\"fsScanPagination\":true,\"fsWatch\":true},\"limits\":{\"maxFrameBytes\":33554432,\"maxWriteBase64Bytes\":20971520,\"maxHashBytes\":16777216,\"maxStatManyPaths\":128,\"maxStatManyPathBytes\":262144,\"maxScanEntries\":256,\"maxScanDepth\":16,\"maxScanNodes\":2048,\"maxWatches\":16,\"maxWatchEvents\":128,\"maxConcurrentJobs\":4,\"maxJobOutputBytes\":524288}}",platform,owc_sandbox_status_name(capability),escaped,job_control);(void)reply_result(rpc,id,result);free(result);}free(escaped);}
    } else if(strcmp(method,"core.shutdown")==0) { (void)reply_result(rpc,id,"{\"ok\":true}"); rpc->shutting_down=1; }
    else if(strcmp(method,"session.configure")==0) { const char *sid=owc_json_get_string(owc_json_object_get(params,"sessionId")),*cwd=owc_json_get_string(owc_json_object_get(params,"cwd"));if(!sid||!sid[0]||!cwd||!cwd[0])(void)reply_error(rpc,id,-32602,"session.configure requires sessionId and cwd");else if(!configure_session(sid,cwd)||!configure_policy(sid,owc_json_object_get(params,"sandbox")))(void)reply_error(rpc,id,-32000,"failed to configure session");else(void)reply_session_capability(rpc,id,sid); }
    else if(strcmp(method,"session.cleanup")==0) { const char *sid=owc_json_get_string(owc_json_object_get(params,"sessionId"));if(!sid||!sid[0])(void)reply_error(rpc,id,-32602,"session.cleanup requires sessionId");else{(void)cleanup_session(sid);(void)reply_result(rpc,id,"{\"ok\":true}");} }
    else if(strcmp(method,"exec.run")==0) (void)handle_exec_run(rpc,id,params);
    else if(strcmp(method,"job.start")==0) (void)handle_job_start(rpc,id,params);
    else if(strcmp(method,"job.cancel")==0) (void)handle_job_cancel(rpc,id,params);
    else if(strcmp(method,"job.status")==0) (void)handle_job_status(rpc,id,params);
    else if(strcmp(method,"job.output")==0) (void)handle_job_output(rpc,id,params);
    else if(strcmp(method,"fs.statMany")==0) (void)handle_fs_stat_many(rpc,id,params);
    else if(strcmp(method,"fs.scan")==0) (void)handle_fs_scan(rpc,id,params);
    else if(strcmp(method,"fs.watch")==0) (void)handle_fs_watch_start(rpc,id,params);
    else if(strcmp(method,"fs.watch.poll")==0) (void)handle_fs_watch_poll(rpc,id,params);
    else if(strcmp(method,"fs.watch.cancel")==0) (void)handle_fs_watch_cancel(rpc,id,params);
    else if(strcmp(method,"fs.read")==0 || strcmp(method,"fs.write")==0 || strcmp(method,"fs.writeBase64")==0 || strcmp(method,"fs.edit")==0 || strcmp(method,"fs.stat")==0 || strcmp(method,"fs.hash")==0 || strcmp(method,"fs.list")==0 || strcmp(method,"fs.glob")==0 || strcmp(method,"fs.grep")==0) (void)handle_fs(rpc,id,method,params);
    else (void)reply_error(rpc,id,-32601,"method not found");
    rpc->suppress_responses=0; owc_json_free(root); return 1;
}
