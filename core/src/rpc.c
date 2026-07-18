#include "rpc.h"
#include "exec.h"
#include "fs.h"
#include "json.h"
#include "sandbox.h"

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

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

static int session_exec_policy(const char *id,const char *cwd,int *enabled,int *allow_network,int *mode);

static int handle_exec_run(owc_rpc *rpc,const owc_json *id,const owc_json *params) {
    const char *command=owc_json_get_string(owc_json_object_get(params,"cmd"));
    const char *cwd=owc_json_get_string(owc_json_object_get(params,"cwd"));
    const char *exec_id=owc_json_get_string(owc_json_object_get(params,"execId"));
    const char *session_id=owc_json_get_string(owc_json_object_get(params,"sessionId"));
    owc_exec_request request; owc_exec_result result; output_context context; int sandbox_enabled,allow_network,sandbox_mode;
    if(!params || params->type!=OWC_JSON_OBJECT || !command || !cwd || !exec_id || !session_id || !command[0] || !cwd[0] || !exec_id[0] || !session_id[0]) return reply_error(rpc,id,-32602,"exec.run requires non-empty string sessionId, execId, cmd, and cwd");
    memset(&request,0,sizeof(request)); context.rpc=rpc; context.exec_id=exec_id;
    if(!session_exec_policy(session_id,cwd,&sandbox_enabled,&allow_network,&sandbox_mode))return reply_error(rpc,id,-32002,"session cwd is not configured");
    request.command=command; request.cwd=cwd; request.session_id=session_id;request.sandbox_enabled=sandbox_enabled;request.allow_network=allow_network;request.sandbox_mode=sandbox_mode;
    if(!parse_timeout(owc_json_object_get(params,"timeoutMs"),&request.timeout_ms)) return reply_error(rpc,id,-32602,"timeoutMs must be a positive integer");
    request.output_limit=10u*1024u*1024u; request.on_output=output_notification; request.user_data=&context;
    if(!owc_exec_run(&request,&result)) return reply_error(rpc,id,-32000,"failed to start or monitor command");
    if(result.timed_out) return reply_error(rpc,id,-32001,"command timed out");
    {
        char result_text[640];char *reason=owc_json_escape_string(result.sandbox_reason[0]?result.sandbox_reason:"sandbox not requested");if(!reason)return reply_error(rpc,id,-32000,"failed to encode sandbox status");
        (void)snprintf(result_text,sizeof(result_text),"{\"exitCode\":%d,\"durationMs\":%lld,\"truncated\":%s,\"sandboxCapability\":\"%s\",\"sandboxReason\":%s}",
            result.exit_code,result.duration_ms,result.truncated?"true":"false",owc_sandbox_status_name((owc_sandbox_status)result.sandbox_status),reason);free(reason);
        return reply_result(rpc,id,result_text);
    }
}

typedef struct { char *session_id; char *cwd; char *deny_paths[16]; size_t deny_count; int sandbox_enabled; int allow_network; int sandbox_mode; } session_config;
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
static int session_exec_policy(const char *id,const char *cwd,int *enabled,int *allow_network,int *mode){session_config *session=session_find(id);if(!session||!policy_path_equal(session->cwd,cwd))return 0;*enabled=session->sandbox_enabled;*allow_network=session->allow_network;*mode=session->sandbox_mode;return 1;}
static int policy_path_within(const char *path,const char *root){while(*path&&*root){char a=*path++,b=*root++;
#ifdef _WIN32
 if(a=='\\')a='/';if(b=='\\')b='/';a=(char)tolower((unsigned char)a);b=(char)tolower((unsigned char)b);
#endif
 if(a!=b)return 0;}if(*root)return 0;return *path=='\0'||*path=='/'||*path=='\\';}
static int session_denied(const char *id,const char *path){session_config *session=session_find(id);size_t i,n;char *joined;if(!session)return 1;n=strlen(session->cwd)+strlen(path)+2;joined=(char*)malloc(n);if(!joined)return 1;(void)snprintf(joined,n,"%s/%s",session->cwd,path);for(i=0;i<session->deny_count;i++)if(policy_path_within(path,session->deny_paths[i])||policy_path_within(joined,session->deny_paths[i])){free(joined);return 1;}free(joined);return 0;}
static int configure_session(const char *id,const char *cwd){size_t i;char *root=copy_text(cwd);if(!root)return 0;for(i=0;i<session_count;i++)if(!strcmp(sessions[i].session_id,id)){free(sessions[i].cwd);sessions[i].cwd=root;return 1;}if(session_count>=sizeof(sessions)/sizeof(sessions[0])){free(root);return 0;}memset(&sessions[session_count],0,sizeof(sessions[0]));sessions[session_count].session_id=copy_text(id);if(!sessions[session_count].session_id){free(root);return 0;}sessions[session_count].cwd=root;session_count++;return 1;}
static void clear_denies(session_config *session){size_t i;for(i=0;i<session->deny_count;i++)free(session->deny_paths[i]);session->deny_count=0;}
static int configure_policy(const char *id,const owc_json *sandbox){session_config *session=session_find(id);const owc_json *denies,*enabled,*network,*mode;size_t i;if(!session)return 0;clear_denies(session);session->sandbox_enabled=1;session->allow_network=1;session->sandbox_mode=(int)OWC_SANDBOX_MODE_APPCONTAINER;if(!sandbox)return 1;if(sandbox->type!=OWC_JSON_OBJECT)return 0;enabled=owc_json_object_get(sandbox,"enabled");network=owc_json_object_get(sandbox,"network");mode=owc_json_object_get(sandbox,"mode");if(enabled){if(enabled->type!=OWC_JSON_BOOL)return 0;session->sandbox_enabled=enabled->value.boolean;}if(network){const char *value=owc_json_get_string(network);if(!value||(strcmp(value,"allow")&&strcmp(value,"deny")))return 0;session->allow_network=!strcmp(value,"allow");}if(mode){const char *value=owc_json_get_string(mode);if(!value)return 0;if(!strcmp(value,"appcontainer"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_APPCONTAINER;else if(!strcmp(value,"jobobject"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_JOBOBJECT;else if(!strcmp(value,"off"))session->sandbox_mode=(int)OWC_SANDBOX_MODE_OFF;else return 0;if(session->sandbox_mode==(int)OWC_SANDBOX_MODE_OFF)session->sandbox_enabled=0;}denies=owc_json_object_get(sandbox,"denyPaths");if(!denies)return 1;if(denies->type!=OWC_JSON_ARRAY||denies->value.children.count>16)return 0;for(i=0;i<denies->value.children.count;i++){const char *value=owc_json_get_string(denies->value.children.items[i]);if(!value)return 0;session->deny_paths[session->deny_count]=copy_text(value);if(!session->deny_paths[session->deny_count])return 0;session->deny_count++;}return 1;}
static int cleanup_session(const char *id){size_t i;for(i=0;i<session_count;i++)if(!strcmp(sessions[i].session_id,id)){clear_denies(&sessions[i]);free(sessions[i].session_id);free(sessions[i].cwd);sessions[i]=sessions[session_count-1];session_count--;return 1;}return 0;}

static int reply_session_capability(owc_rpc *rpc,const owc_json *id,const char *sid){session_config *session=session_find(sid);char reason[192],result[512];char *escaped;owc_sandbox_status status;if(!session)return reply_error(rpc,id,-32000,"session was not configured");if(!session->sandbox_enabled){status=OWC_SANDBOX_ADVISORY;(void)snprintf(reason,sizeof(reason),"sandbox disabled by session policy");}else if(session->sandbox_mode==(int)OWC_SANDBOX_MODE_JOBOBJECT){status=OWC_SANDBOX_PARTIAL;(void)snprintf(reason,sizeof(reason),"Job Object compatibility mode requested by session policy");}else{
#ifdef _WIN32
 status=owc_sandbox_probe(reason,sizeof(reason));
#else
 owc_sandbox_result probe;owc_landlock_probe(session->allow_network,&probe);status=probe.status;(void)snprintf(reason,sizeof(reason),"%s",probe.reason);
#endif
}escaped=owc_json_escape_string(reason);if(!escaped)return reply_error(rpc,id,-32000,"failed to encode sandbox capability");(void)snprintf(result,sizeof(result),"{\"sandboxCapability\":\"%s\",\"sandboxReason\":%s}",owc_sandbox_status_name(status),escaped);free(escaped);return reply_result(rpc,id,result);}

static int fs_code(owc_fs_error e) { if(e==OWC_FS_INVALID_ARGUMENT||e==OWC_FS_INVALID_UTF8||e==OWC_FS_NO_MATCH||e==OWC_FS_MULTIPLE_MATCHES)return -32602;if(e==OWC_FS_OUTSIDE_ROOT||e==OWC_FS_PERMISSION_DENIED)return -32002;if(e==OWC_FS_NOT_FOUND)return -32003;return -32000; }
static int allowed_keys(const owc_json *p,const char *const *keys,size_t count) { size_t i,j;if(!p||p->type!=OWC_JSON_OBJECT)return 0;for(i=0;i<p->value.children.count;i++){const char*k=p->value.children.items[i]->key;for(j=0;j<count;j++)if(!strcmp(k,keys[j]))break;if(j==count)return 0;}return 1; }
static int json_size(const owc_json*v,size_t *n){double d;if(!v||v->type!=OWC_JSON_NUMBER)return 0;d=v->value.number;if(d<0||d>(double)SIZE_MAX||d!=(double)(size_t)d)return 0;*n=(size_t)d;return 1;}
static int json_bool(const owc_json *v,int fallback,int *result){if(!v){*result=fallback;return 1;}if(v->type!=OWC_JSON_BOOL)return 0;*result=v->value.boolean;return 1;}
static const char *type_name(owc_fs_type t){return t==OWC_FS_TYPE_FILE?"file":t==OWC_FS_TYPE_DIRECTORY?"directory":"other";}
static int handle_fs(owc_rpc *rpc,const owc_json *id,const char *method,const owc_json *p){
    const char *cwd,*path,*content,*old,*replacement,*session_id; owc_fs_error e; char *a,*b; size_t off=0,lim=OWC_FS_DEFAULT_READ_LINES,i,matches=0; int option;
    static const char *rp[]={"sessionId","path","offset","limit"},*wp[]={"sessionId","path","content","createDirs"},*ep[]={"sessionId","path","oldText","newText","replaceAll"},*searchp[]={"sessionId","path","pattern"},*sp[]={"sessionId","path"};
    session_id=owc_json_get_string(owc_json_object_get(p,"sessionId"));path=owc_json_get_string(owc_json_object_get(p,"path"));cwd=session_id?session_root(session_id):NULL;if(!cwd||!path)return reply_error(rpc,id,-32602,"sessionId must identify a configured session and path must be a string");if(session_denied(session_id,path))return reply_error(rpc,id,-32002,"path is denied by session policy");
    if(!strcmp(method,"fs.read")){owc_fs_read_result r;const owc_json *value;if(!allowed_keys(p,rp,4))return reply_error(rpc,id,-32602,"fs.read contains unknown fields");value=owc_json_object_get(p,"offset");if(value&&!json_size(value,&off))return reply_error(rpc,id,-32602,"offset must be a non-negative integer");value=owc_json_object_get(p,"limit");if(value&&(!json_size(value,&lim)||!lim))return reply_error(rpc,id,-32602,"limit must be a positive integer");e=owc_fs_read(cwd,path,off,lim,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));a=owc_json_escape_string(r.content);if(!a){owc_fs_read_free(&r);return reply_error(rpc,id,-32000,"out of memory");}i=(size_t)snprintf(NULL,0,"{\"content\":%s,\"totalLines\":%zu,\"encoding\":\"utf-8\",\"truncated\":%s}",a,r.total_lines,r.truncated?"true":"false");b=(char*)malloc(i+1);if(b)snprintf(b,i+1,"{\"content\":%s,\"totalLines\":%zu,\"encoding\":\"utf-8\",\"truncated\":%s}",a,r.total_lines,r.truncated?"true":"false");free(a);owc_fs_read_free(&r);if(!b)return reply_error(rpc,id,-32000,"out of memory");i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.write")){if(!allowed_keys(p,wp,4)||(content=owc_json_get_string(owc_json_object_get(p,"content")))==NULL||!json_bool(owc_json_object_get(p,"createDirs"),0,&option))return reply_error(rpc,id,-32602,"fs.write requires string cwd, path, content, and optional boolean createDirs");e=owc_fs_write(cwd,path,content,strlen(content),option);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));return reply_result(rpc,id,"{\"ok\":true}");}
    if(!strcmp(method,"fs.edit")){if(!allowed_keys(p,ep,5)||(old=owc_json_get_string(owc_json_object_get(p,"oldText")))==NULL||(replacement=owc_json_get_string(owc_json_object_get(p,"newText")))==NULL||!json_bool(owc_json_object_get(p,"replaceAll"),0,&option))return reply_error(rpc,id,-32602,"fs.edit requires string cwd, path, oldText, newText, and optional boolean replaceAll");e=owc_fs_edit(cwd,path,old,strlen(old),replacement,strlen(replacement),option,&matches);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(64);if(!b)return reply_error(rpc,id,-32000,"out of memory");snprintf(b,64,"{\"matches\":%zu}",matches);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.glob")){owc_fs_glob_result r;const char *pattern=owc_json_get_string(owc_json_object_get(p,"pattern"));if(!allowed_keys(p,searchp,3)||!pattern)return reply_error(rpc,id,-32602,"fs.glob requires string cwd, path, and pattern");e=owc_fs_glob(cwd,path,pattern,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(12);if(!b){owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}strcpy(b,"{\"paths\":[");for(i=0;i<r.count;i++){char*q=owc_json_escape_string(r.paths[i]);size_t oldn=strlen(b),add;if(!q){free(b);owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}add=strlen(q)+(i?1u:0u);{char *grown=(char*)realloc(b,oldn+add+32);if(!grown){free(q);free(b);owc_fs_glob_free(&r);return reply_error(rpc,id,-32000,"out of memory");}b=grown;}snprintf(b+oldn,add+1,"%s%s",i?",":"",q);free(q);}i=strlen(b);snprintf(b+i,32,"],\"truncated\":%s}",r.truncated?"true":"false");owc_fs_glob_free(&r);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!strcmp(method,"fs.grep")){owc_fs_grep_result r;const char *pattern=owc_json_get_string(owc_json_object_get(p,"pattern"));if(!allowed_keys(p,searchp,3)||!pattern)return reply_error(rpc,id,-32602,"fs.grep requires string cwd, path, and pattern");e=owc_fs_grep(cwd,path,pattern,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(14);if(!b){owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}strcpy(b,"{\"matches\":[");for(i=0;i<r.count;i++){char*q=owc_json_escape_string(r.matches[i].path),*t=owc_json_escape_string(r.matches[i].text);size_t oldn=strlen(b),add;if(!q||!t){free(q);free(t);free(b);owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}add=(size_t)snprintf(NULL,0,"%s{\"path\":%s,\"line\":%zu,\"text\":%s}",i?",":"",q,r.matches[i].line,t);{char *grown=(char*)realloc(b,oldn+add+32);if(!grown){free(q);free(t);free(b);owc_fs_grep_free(&r);return reply_error(rpc,id,-32000,"out of memory");}b=grown;}snprintf(b+oldn,add+1,"%s{\"path\":%s,\"line\":%zu,\"text\":%s}",i?",":"",q,r.matches[i].line,t);free(q);free(t);}i=strlen(b);snprintf(b+i,32,"],\"truncated\":%s}",r.truncated?"true":"false");owc_fs_grep_free(&r);i=reply_result(rpc,id,b);free(b);return (int)i;}
    if(!allowed_keys(p,sp,2))return reply_error(rpc,id,-32602,"operation contains unknown fields");
    if(!strcmp(method,"fs.stat")){owc_fs_stat_result r;e=owc_fs_stat(cwd,path,&r);if(e)return reply_error(rpc,id,fs_code(e),owc_fs_error_message(e));b=(char*)malloc(256);if(!b)return reply_error(rpc,id,-32000,"out of memory");snprintf(b,256,"{\"type\":\"%s\",\"size\":%llu,\"modifiedMs\":%lld}",type_name(r.type),r.size,r.modified_ms);i=reply_result(rpc,id,b);free(b);return (int)i;}
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
        char reason[192],result[512];char *escaped;owc_sandbox_status capability=owc_sandbox_probe(reason,sizeof(reason));escaped=owc_json_escape_string(reason);if(!escaped)(void)reply_error(rpc,id,-32000,"failed to encode sandbox capability");else{(void)snprintf(result,sizeof(result),"{\"version\":\"0.1.0\",\"platform\":\"%s\",\"sandboxCapability\":\"%s\",\"sandboxReason\":%s}",platform,owc_sandbox_status_name(capability),escaped);free(escaped);(void)reply_result(rpc,id,result);}
    } else if(strcmp(method,"core.shutdown")==0) { (void)reply_result(rpc,id,"{\"ok\":true}"); rpc->shutting_down=1; }
    else if(strcmp(method,"session.configure")==0) { const char *sid=owc_json_get_string(owc_json_object_get(params,"sessionId")),*cwd=owc_json_get_string(owc_json_object_get(params,"cwd"));if(!sid||!sid[0]||!cwd||!cwd[0])(void)reply_error(rpc,id,-32602,"session.configure requires sessionId and cwd");else if(!configure_session(sid,cwd)||!configure_policy(sid,owc_json_object_get(params,"sandbox")))(void)reply_error(rpc,id,-32000,"failed to configure session");else(void)reply_session_capability(rpc,id,sid); }
    else if(strcmp(method,"session.cleanup")==0) { const char *sid=owc_json_get_string(owc_json_object_get(params,"sessionId"));if(!sid||!sid[0])(void)reply_error(rpc,id,-32602,"session.cleanup requires sessionId");else{(void)cleanup_session(sid);(void)reply_result(rpc,id,"{\"ok\":true}");} }
    else if(strcmp(method,"exec.run")==0) (void)handle_exec_run(rpc,id,params);
    else if(strcmp(method,"fs.read")==0 || strcmp(method,"fs.write")==0 || strcmp(method,"fs.edit")==0 || strcmp(method,"fs.stat")==0 || strcmp(method,"fs.list")==0 || strcmp(method,"fs.glob")==0 || strcmp(method,"fs.grep")==0) (void)handle_fs(rpc,id,method,params);
    else (void)reply_error(rpc,id,-32601,"method not found");
    rpc->suppress_responses=0; owc_json_free(root); return 1;
}
