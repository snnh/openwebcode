#include "rpc.h"
#include "exec.h"
#include "json.h"

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
    if(!id) { copy=(char *)malloc(5); if(copy) (void)strcpy(copy,"null"); return copy; }
    if(id->type==OWC_JSON_STRING) return owc_json_escape_string(id->value.string);
    if(id->type==OWC_JSON_NUMBER) { (void)snprintf(number,sizeof(number),"%.17g",id->value.number); copy=(char *)malloc(strlen(number)+1); if(copy) (void)strcpy(copy,number); return copy; }
    return NULL;
}

static int reply_error(owc_rpc *rpc, const owc_json *id, int code, const char *message) {
    char *id_text=id_json(id),*escaped=owc_json_escape_string(message); int ok=0;
    if(id_text && escaped) ok=write_format(rpc,"{\"jsonrpc\":\"2.0\",\"id\":%s,\"error\":{\"code\":%d,\"message\":%s}}",id_text,code,escaped);
    free(id_text); free(escaped); return ok;
}

static int reply_result(owc_rpc *rpc, const owc_json *id, const char *result) {
    char *id_text=id_json(id); int ok=0;
    if(id_text) ok=write_format(rpc,"{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":%s}",id_text,result);
    free(id_text); return ok;
}

typedef struct { owc_rpc *rpc; const char *exec_id; } output_context;
static void output_notification(void *user_data,const char *stream,const unsigned char *data,size_t length,unsigned sequence) {
    output_context *context=(output_context *)user_data; char *encoded=base64_encode(data,length),*id=owc_json_escape_string(context->exec_id);
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

static int handle_exec_run(owc_rpc *rpc,const owc_json *id,const owc_json *params) {
    const char *command=owc_json_get_string(owc_json_object_get(params,"cmd"));
    const char *cwd=owc_json_get_string(owc_json_object_get(params,"cwd"));
    const char *exec_id=owc_json_get_string(owc_json_object_get(params,"execId"));
    const char *session_id=owc_json_get_string(owc_json_object_get(params,"sessionId"));
    owc_exec_request request; owc_exec_result result; output_context context;
    if(!params || params->type!=OWC_JSON_OBJECT || !command || !cwd || !exec_id || !session_id || !command[0] || !cwd[0] || !exec_id[0] || !session_id[0]) return reply_error(rpc,id,-32602,"exec.run requires non-empty string sessionId, execId, cmd, and cwd");
    memset(&request,0,sizeof(request)); context.rpc=rpc; context.exec_id=exec_id;
    request.command=command; request.cwd=cwd;
    if(!parse_timeout(owc_json_object_get(params,"timeoutMs"),&request.timeout_ms)) return reply_error(rpc,id,-32602,"timeoutMs must be a positive integer");
    request.output_limit=10u*1024u*1024u; request.on_output=output_notification; request.user_data=&context;
    if(!owc_exec_run(&request,&result)) return reply_error(rpc,id,-32000,"failed to start or monitor command");
    if(result.timed_out) return reply_error(rpc,id,-32001,"command timed out");
    {
        char *id_text=id_json(id); int ok;
        if(!id_text) return 0;
        ok=write_format(rpc,"{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"exitCode\":%d,\"durationMs\":%lld,\"truncated\":%s}}",
            id_text,result.exit_code,result.duration_ms,result.truncated?"true":"false");
        free(id_text); return ok;
    }
}

int owc_rpc_dispatch(owc_rpc *rpc, const char *body, size_t length) {
    const char *error_at=NULL,*method,*version; owc_json *root=owc_json_parse(body,length,&error_at);
    const owc_json *id,*params;
    (void)error_at;
    if(!root) return reply_error(rpc,NULL,-32700,"parse error");
    id=owc_json_object_get(root,"id"); version=owc_json_get_string(owc_json_object_get(root,"jsonrpc")); method=owc_json_get_string(owc_json_object_get(root,"method")); params=owc_json_object_get(root,"params");
    if(!version || strcmp(version,"2.0")!=0 || !method || (id && id->type!=OWC_JSON_STRING && id->type!=OWC_JSON_NUMBER)) { int ok=reply_error(rpc,id,-32600,"invalid request"); owc_json_free(root); return ok; }
    if(strcmp(method,"core.ping")==0) {
#ifdef _WIN32
        const char *platform="windows";
#else
        const char *platform="linux";
#endif
        char result[256]; (void)snprintf(result,sizeof(result),"{\"version\":\"0.1.0\",\"platform\":\"%s\",\"sandboxCapability\":\"advisory\"}",platform);
        (void)reply_result(rpc,id,result);
    } else if(strcmp(method,"core.shutdown")==0) { (void)reply_result(rpc,id,"{\"ok\":true}"); rpc->shutting_down=1; }
    else if(strcmp(method,"exec.run")==0) (void)handle_exec_run(rpc,id,params);
    else (void)reply_error(rpc,id,-32601,"method not found");
    owc_json_free(root); return 1;
}
