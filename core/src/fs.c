#include "fs.h"
#include "platform/fs_platform.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int owc_fs_utf8_valid(const char *s,size_t n) {
    size_t i=0; if(!s && n) return 0;
    while(i<n) { unsigned char c=(unsigned char)s[i]; size_t k; unsigned cp;
        if(c<0x80) { if(c==0) return 0; i++; continue; }
        if(c>=0xC2 && c<=0xDF) { k=1; cp=c&31u; }
        else if(c>=0xE0 && c<=0xEF) { k=2; cp=c&15u; }
        else if(c>=0xF0 && c<=0xF4) { k=3; cp=c&7u; }
        else return 0;
        if(i+k>=n) return 0;
        while(k) { unsigned char d=(unsigned char)s[i+1]; if((d&0xC0)!=0x80) return 0; cp=(cp<<6)|(d&63u); i++; k--; }
        if(cp>0x10FFFFu || (cp>=0xD800u&&cp<=0xDFFFu) || cp<0x80u || (cp<0x800u&&c>=0xE0) || (cp<0x10000u&&c>=0xF0)) return 0;
        i++;
    } return 1;
}

static int valid_path(const char *root,const char *path) { size_t rn,pn; if(!root||!path) return 0; rn=strlen(root); pn=strlen(path); return rn&&pn&&owc_fs_utf8_valid(root,rn)&&owc_fs_utf8_valid(path,pn); }
void owc_fs_read_free(owc_fs_read_result *r) { if(r) { free(r->content); memset(r,0,sizeof(*r)); } }
void owc_fs_list_free(owc_fs_list_result *r) { size_t i; if(!r)return; for(i=0;i<r->count;i++) free(r->entries[i].name); free(r->entries); memset(r,0,sizeof(*r)); }

owc_fs_error owc_fs_read(const char *root,const char *path,size_t offset,size_t limit,owc_fs_read_result *r) {
    owc_fs_bytes b={0}; owc_fs_error e; size_t i,start=0,end,out=0,line=0,total=0;
    if(!r||!limit||!valid_path(root,path)) return OWC_FS_INVALID_ARGUMENT;
    memset(r,0,sizeof(*r));
    e=owc_fs_platform_read(root,path,&b); if(e) return e;
    if(b.length>OWC_FS_MAX_FILE_SIZE) { free(b.data); return OWC_FS_IO_ERROR; }
    if(!owc_fs_utf8_valid((const char *)b.data,b.length)) { free(b.data); return OWC_FS_INVALID_UTF8; }
    for(i=0;i<b.length;i++) {
        if(b.data[i]=='\n') total++;
    }
    if(b.length&&b.data[b.length-1]!='\n') total++;
    for(i=0;i<b.length&&line<offset;i++) if(b.data[i]=='\n') { line++; start=i+1; }
    if(line<offset) start=b.length;
    end=start;
    while(end<b.length&&out<limit) { if(b.data[end++]=='\n') out++; }
    r->content=(char *)malloc(end-start+1); if(!r->content) { free(b.data); return OWC_FS_NO_MEMORY; }
    memcpy(r->content,b.data+start,end-start); r->content[end-start]=0; r->total_lines=total; r->truncated=end<b.length; free(b.data); return OWC_FS_OK;
}

owc_fs_error owc_fs_write(const char *root,const char *path,const char *content,size_t length,int create_dirs) {
    if(length>OWC_FS_MAX_FILE_SIZE||!valid_path(root,path)||(!content&&length)||!owc_fs_utf8_valid(content,length)) return OWC_FS_INVALID_ARGUMENT;
    return owc_fs_platform_write(root,path,(const unsigned char *)content,length,create_dirs);
}

owc_fs_error owc_fs_write_binary(const char *root,const char *path,const unsigned char *content,size_t length,int create_dirs) {
    if(length>OWC_FS_MAX_BINARY_FILE_SIZE||!valid_path(root,path)||(!content&&length)) return OWC_FS_INVALID_ARGUMENT;
    return owc_fs_platform_write(root,path,content,length,create_dirs);
}

owc_fs_error owc_fs_edit(const char *root,const char *path,const char *old_text,size_t oldn,const char *new_text,size_t newn,int replace_all,size_t *matches) {
    owc_fs_bytes b={0}; owc_fs_error e; size_t i,count=0,outn,read_at=0,write_at=0; unsigned char *out;
    if(matches) *matches=0;
    if(!matches||!valid_path(root,path)||!old_text||!oldn||(!new_text&&newn)||!owc_fs_utf8_valid(old_text,oldn)||!owc_fs_utf8_valid(new_text,newn)) return OWC_FS_INVALID_ARGUMENT;
    e=owc_fs_platform_read(root,path,&b); if(e) return e;
    if(b.length>OWC_FS_MAX_FILE_SIZE) { free(b.data); return OWC_FS_IO_ERROR; }
    if(!owc_fs_utf8_valid((char *)b.data,b.length)){free(b.data);return OWC_FS_INVALID_UTF8;}
    for(i=0;i+oldn<=b.length;) { if(!memcmp(b.data+i,old_text,oldn)){count++;i+=oldn;} else i++; }
    if(!count){free(b.data);return OWC_FS_NO_MATCH;} if(!replace_all&&count!=1){free(b.data);return OWC_FS_MULTIPLE_MATCHES;}
    if(newn>oldn && count>(SIZE_MAX-b.length)/(newn-oldn)){free(b.data);return OWC_FS_NO_MEMORY;}
    outn=newn>=oldn?b.length+count*(newn-oldn):b.length-count*(oldn-newn);
    if(outn>OWC_FS_MAX_FILE_SIZE){free(b.data);return OWC_FS_INVALID_ARGUMENT;} out=(unsigned char *)malloc(outn?outn:1);
    if(!out){free(b.data);return OWC_FS_NO_MEMORY;}
    while(read_at<b.length) { if(read_at+oldn<=b.length&&!memcmp(b.data+read_at,old_text,oldn)) { memcpy(out+write_at,new_text,newn);write_at+=newn;read_at+=oldn; } else out[write_at++]=b.data[read_at++]; }
    e=owc_fs_platform_write(root,path,out,outn,0); free(out); free(b.data); if(!e)*matches=count; return e;
}
owc_fs_error owc_fs_stat(const char *root,const char *path,owc_fs_stat_result *r){if(!r||!valid_path(root,path))return OWC_FS_INVALID_ARGUMENT;return owc_fs_platform_stat(root,path,r);}
owc_fs_error owc_fs_list(const char *root,const char *path,owc_fs_list_result *r){if(!r||!valid_path(root,path))return OWC_FS_INVALID_ARGUMENT;memset(r,0,sizeof(*r));return owc_fs_platform_list(root,path,r);}

static char *copy_string(const char *value){size_t n=strlen(value)+1;char *copy=(char*)malloc(n);if(copy)memcpy(copy,value,n);return copy;}
static char *join_path(const char *left,const char *right){size_t a=strlen(left),b=strlen(right);char *joined=(char*)malloc(a+b+2);if(!joined)return NULL;if(a){memcpy(joined,left,a);joined[a]='/';memcpy(joined+a+1,right,b+1);}else memcpy(joined,right,b+1);return joined;}
static int wildcard(const char *pattern,const char *value){while(*pattern){if(*pattern=='*'){while(*pattern=='*')pattern++;if(!*pattern)return 1;while(*value){if(wildcard(pattern,value))return 1;value++;}return 0;}if(*pattern=='?'&&*value){pattern++;value++;continue;}if(*pattern!=*value)return 0;pattern++;value++;}return *value=='\0';}
void owc_fs_glob_free(owc_fs_glob_result *r){size_t i;if(!r)return;for(i=0;i<r->count;i++)free(r->paths[i]);free(r->paths);memset(r,0,sizeof(*r));}
void owc_fs_grep_free(owc_fs_grep_result *r){size_t i;if(!r)return;for(i=0;i<r->count;i++){free(r->matches[i].path);free(r->matches[i].text);}free(r->matches);memset(r,0,sizeof(*r));}
static owc_fs_error glob_walk(const char *root,const char *base,const char *relative,const char *pattern,owc_fs_glob_result *result){owc_fs_list_result list;owc_fs_error e;size_t i;char *directory=relative[0]?join_path(base,relative):copy_string(base);if(!directory)return OWC_FS_NO_MEMORY;e=owc_fs_list(root,directory,&list);free(directory);if(e)return e;for(i=0;i<list.count;i++){char *child=relative[0]?join_path(relative,list.entries[i].name):copy_string(list.entries[i].name);if(!child){owc_fs_list_free(&list);return OWC_FS_NO_MEMORY;}if(wildcard(pattern,child)){char **grown;if(result->count>=OWC_FS_MAX_LIST_ENTRIES){result->truncated=1;free(child);break;}grown=(char**)realloc(result->paths,(result->count+1)*sizeof(*grown));if(!grown){free(child);owc_fs_list_free(&list);return OWC_FS_NO_MEMORY;}result->paths=grown;result->paths[result->count++]=copy_string(child);if(!result->paths[result->count-1]){free(child);owc_fs_list_free(&list);return OWC_FS_NO_MEMORY;}}if(list.entries[i].type==OWC_FS_TYPE_DIRECTORY&&!result->truncated){e=glob_walk(root,base,child,pattern,result);if(e){free(child);owc_fs_list_free(&list);return e;}}free(child);}if(list.truncated)result->truncated=1;owc_fs_list_free(&list);return OWC_FS_OK;}
owc_fs_error owc_fs_glob(const char *root,const char *path,const char *pattern,owc_fs_glob_result *r){if(!r||!pattern||!pattern[0]||!valid_path(root,path)||!owc_fs_utf8_valid(pattern,strlen(pattern)))return OWC_FS_INVALID_ARGUMENT;memset(r,0,sizeof(*r));return glob_walk(root,path,"",pattern,r);}
static owc_fs_error grep_file(const char *root,const char *full,const char *display,const char *pattern,owc_fs_grep_result *r){owc_fs_bytes bytes={0};owc_fs_error e=owc_fs_platform_read(root,full,&bytes);size_t start=0,line=1,i;if(e==OWC_FS_INVALID_UTF8||e==OWC_FS_IO_ERROR)return OWC_FS_OK;if(e)return e;if(!owc_fs_utf8_valid((char*)bytes.data,bytes.length)){free(bytes.data);return OWC_FS_OK;}for(i=0;i<=bytes.length;i++){if(i==bytes.length||bytes.data[i]=='\n'){size_t n=i-start;char *text=(char*)malloc(n+1);if(!text){free(bytes.data);return OWC_FS_NO_MEMORY;}memcpy(text,bytes.data+start,n);text[n]=0;if(strstr(text,pattern)){owc_fs_grep_match *grown;if(r->count>=OWC_FS_MAX_LIST_ENTRIES){r->truncated=1;free(text);break;}grown=(owc_fs_grep_match*)realloc(r->matches,(r->count+1)*sizeof(*grown));if(!grown){free(text);free(bytes.data);return OWC_FS_NO_MEMORY;}r->matches=grown;r->matches[r->count].path=copy_string(display);r->matches[r->count].line=line;r->matches[r->count].text=text;if(!r->matches[r->count].path){free(bytes.data);return OWC_FS_NO_MEMORY;}r->count++;}else free(text);line++;start=i+1;}}free(bytes.data);return OWC_FS_OK;}
static owc_fs_error grep_walk(const char *root,const char *base,const char *relative,const char *pattern,owc_fs_grep_result *r){owc_fs_list_result list;owc_fs_error e;size_t i;char *directory=relative[0]?join_path(base,relative):copy_string(base);if(!directory)return OWC_FS_NO_MEMORY;e=owc_fs_list(root,directory,&list);free(directory);if(e)return e;for(i=0;i<list.count&&!r->truncated;i++){char *child=relative[0]?join_path(relative,list.entries[i].name):copy_string(list.entries[i].name);char *full;if(!child){owc_fs_list_free(&list);return OWC_FS_NO_MEMORY;}full=join_path(base,child);if(!full){free(child);owc_fs_list_free(&list);return OWC_FS_NO_MEMORY;}e=list.entries[i].type==OWC_FS_TYPE_DIRECTORY?grep_walk(root,base,child,pattern,r):list.entries[i].type==OWC_FS_TYPE_FILE?grep_file(root,full,child,pattern,r):OWC_FS_OK;free(full);free(child);if(e){owc_fs_list_free(&list);return e;}}if(list.truncated)r->truncated=1;owc_fs_list_free(&list);return OWC_FS_OK;}
owc_fs_error owc_fs_grep(const char *root,const char *path,const char *pattern,owc_fs_grep_result *r){owc_fs_stat_result stat;owc_fs_error e;if(!r||!pattern||!pattern[0]||!valid_path(root,path)||!owc_fs_utf8_valid(pattern,strlen(pattern)))return OWC_FS_INVALID_ARGUMENT;memset(r,0,sizeof(*r));e=owc_fs_stat(root,path,&stat);if(e)return e;if(stat.type==OWC_FS_TYPE_FILE)return grep_file(root,path,path,pattern,r);if(stat.type!=OWC_FS_TYPE_DIRECTORY)return OWC_FS_INVALID_ARGUMENT;return grep_walk(root,path,"",pattern,r);}
const char *owc_fs_error_message(owc_fs_error e){static const char *m[]={"ok","invalid argument","not found","permission denied","path escapes cwd","I/O error","invalid UTF-8","text not found","text occurs multiple times","out of memory"};return (unsigned)e<sizeof(m)/sizeof(m[0])?m[e]:"filesystem error";}
