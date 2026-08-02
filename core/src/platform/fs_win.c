#include "fs_platform.h"
#ifdef _WIN32
#include "../path_policy.h"
#include <windows.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* These native calls are resolved dynamically so the core keeps its ordinary
 * Win32 link surface.  They are used solely to create/rename relative to an
 * already verified directory handle; CreateFileW/MoveFileExW cannot express
 * that invariant and leave a parent-directory reparse swap window. */
typedef LONG (NTAPI *owc_nt_create_file_fn)(PHANDLE,ACCESS_MASK,PVOID,PVOID,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
typedef LONG (NTAPI *owc_nt_set_information_file_fn)(HANDLE,PVOID,PVOID,ULONG,ULONG);
typedef struct {USHORT Length;USHORT MaximumLength;PWSTR Buffer;} owc_unicode_string;
typedef struct {ULONG Length;HANDLE RootDirectory;owc_unicode_string *ObjectName;ULONG Attributes;PVOID SecurityDescriptor;PVOID SecurityQualityOfService;} owc_object_attributes;
typedef struct {union {LONG Status;PVOID Pointer;} u;ULONG_PTR Information;} owc_io_status_block;
typedef struct {BOOLEAN ReplaceIfExists;HANDLE RootDirectory;ULONG FileNameLength;WCHAR FileName[1];} owc_file_rename_information;
typedef struct {BOOLEAN DeleteFile;} owc_file_disposition_information;
#define OWC_FILE_CREATE 2UL
#define OWC_FILE_RENAME_INFORMATION 10UL
#define OWC_FILE_DISPOSITION_INFORMATION 13UL
#define OWC_FILE_SYNCHRONOUS_IO_NONALERT 0x20UL
#define OWC_FILE_NON_DIRECTORY_FILE 0x40UL
#define OWC_FILE_OPEN_REPARSE_POINT 0x00200000UL
#define OWC_OBJ_CASE_INSENSITIVE 0x40UL
#define OWC_NT_SUCCESS(status) ((LONG)(status)>=0)

static int native_file_api(owc_nt_create_file_fn *create_file,owc_nt_set_information_file_fn *set_information){
    HMODULE ntdll=GetModuleHandleW(L"ntdll.dll");
    if(!ntdll)return 0;
    *create_file=(owc_nt_create_file_fn)GetProcAddress(ntdll,"NtCreateFile");
    *set_information=(owc_nt_set_information_file_fn)GetProcAddress(ntdll,"NtSetInformationFile");
    return *create_file&&*set_information;
}
static int native_create_relative(owc_nt_create_file_fn create_file,HANDLE parent,const wchar_t *name,HANDLE *file){
    owc_unicode_string text;owc_object_attributes attributes;owc_io_status_block status;LONG result;size_t n=wcslen(name);
    if(n>(USHRT_MAX/sizeof(*name)))return 0;
    text.Length=(USHORT)(n*sizeof(*name));text.MaximumLength=text.Length;text.Buffer=(PWSTR)name;
    attributes.Length=sizeof(attributes);attributes.RootDirectory=parent;attributes.ObjectName=&text;attributes.Attributes=OWC_OBJ_CASE_INSENSITIVE;attributes.SecurityDescriptor=NULL;attributes.SecurityQualityOfService=NULL;
    result=create_file(file,GENERIC_WRITE|DELETE|SYNCHRONIZE,&attributes,&status,NULL,FILE_ATTRIBUTE_TEMPORARY,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,OWC_FILE_CREATE,OWC_FILE_SYNCHRONOUS_IO_NONALERT|OWC_FILE_NON_DIRECTORY_FILE|OWC_FILE_OPEN_REPARSE_POINT,NULL,0);
    if(!OWC_NT_SUCCESS(result))SetLastError((unsigned long)result==0xC0000035UL?ERROR_FILE_EXISTS:ERROR_ACCESS_DENIED);
    return OWC_NT_SUCCESS(result);
}
static int native_rename_relative(owc_nt_set_information_file_fn set_information,HANDLE file,HANDLE parent,const wchar_t *name){
    owc_file_rename_information *rename;owc_io_status_block status;size_t n=wcslen(name),size;
    if(n>(SIZE_MAX-offsetof(owc_file_rename_information,FileName))/sizeof(*name))return 0;
    size=offsetof(owc_file_rename_information,FileName)+(n*sizeof(*name));rename=(owc_file_rename_information*)calloc(1,size);if(!rename)return 0;
    rename->ReplaceIfExists=TRUE;rename->RootDirectory=parent;rename->FileNameLength=(ULONG)(n*sizeof(*name));memcpy(rename->FileName,name,n*sizeof(*name));
    n=OWC_NT_SUCCESS(set_information(file,&status,rename,(ULONG)size,OWC_FILE_RENAME_INFORMATION));free(rename);return (int)n;
}
static void native_delete_on_close(owc_nt_set_information_file_fn set_information,HANDLE file){owc_file_disposition_information disposition;owc_io_status_block status;disposition.DeleteFile=TRUE;(void)set_information(file,&status,&disposition,sizeof(disposition),OWC_FILE_DISPOSITION_INFORMATION);}

static owc_fs_error winerr(void){DWORD e=GetLastError();if(e==ERROR_FILE_NOT_FOUND||e==ERROR_PATH_NOT_FOUND)return OWC_FS_NOT_FOUND;if(e==ERROR_ACCESS_DENIED||e==ERROR_SHARING_VIOLATION)return OWC_FS_PERMISSION_DENIED;return OWC_FS_IO_ERROR;}
static wchar_t *wide(const char *s){int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,NULL,0);wchar_t*w;if(!n)return NULL;w=(wchar_t*)malloc((size_t)n*sizeof(*w));if(w&&!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,w,n)){free(w);w=NULL;}return w;}
static char *utf8(const wchar_t *s){int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s,-1,NULL,0,NULL,NULL);char*p;if(!n)return NULL;p=(char*)malloc((size_t)n);if(p&&!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s,-1,p,n,NULL,NULL)){free(p);p=NULL;}return p;}
/* Session deny roots, canonicalized at publish time: the configured roots
 * may themselves contain 8.3 short names (e.g. temp dirs on CI runners),
 * which would never prefix-match a GetFinalPathNameByHandleW-resolved
 * path.  These values are thread-local because background index/search jobs
 * run concurrently with main-thread RPCs from other sessions.  Process-wide
 * mutable roots would cross-contaminate policies and could be freed while a
 * worker was reading them.  Owned copies; freed on this thread's next publish. */
#if defined(_MSC_VER)
#define OWC_THREAD_LOCAL __declspec(thread)
#else
#define OWC_THREAD_LOCAL _Thread_local
#endif
static OWC_THREAD_LOCAL char **deny_roots=NULL;
static OWC_THREAD_LOCAL size_t deny_root_count=0;
static char *canonical_deny_root(const char *root){
    wchar_t *w=wide(root),*buf; char *out=NULL; HANDLE h; DWORD n;
    if(!w) return NULL;
    h=CreateFileW(w,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
    buf=(wchar_t*)malloc(32768*sizeof(*buf));
    if(h!=INVALID_HANDLE_VALUE){
        if(buf){n=GetFinalPathNameByHandleW(h,buf,32768,VOLUME_NAME_DOS);
            if(n>0&&n<32768){const wchar_t *bare=buf;if(wcsncmp(buf,L"\\\\?\\",4)==0)bare=buf+4;out=utf8(bare);}}
        CloseHandle(h);
    }
    if(!out&&buf){n=GetLongPathNameW(w,buf,32768);if(n>0&&n<32768)out=utf8(buf);}
    free(buf);free(w);
    if(!out){out=(char*)malloc(strlen(root)+1);if(out)strcpy(out,root);}
    return out;
}
void owc_fs_platform_set_deny_roots(const char *const *roots,size_t count){
    size_t i;
    for(i=0;i<deny_root_count;i++) free(deny_roots[i]);
    free(deny_roots);deny_roots=NULL;deny_root_count=0;
    if(!roots||!count) return;
    deny_roots=(char**)calloc(count,sizeof(*deny_roots));
    if(!deny_roots) return;
    for(i=0;i<count;i++){char *c=canonical_deny_root(roots[i]);if(c)deny_roots[deny_root_count++]=c;}
}
static int final_path_denied(const wchar_t *final){size_t i;char *resolved;const wchar_t *bare=final;if(wcsncmp(final,L"\\\\?\\",4)==0)bare=final+4;resolved=utf8(bare);if(!resolved)return 0;for(i=0;i<deny_root_count;i++)if(owc_path_is_within(resolved,deny_roots[i])){free(resolved);return 1;}free(resolved);return 0;}
/* Session bind links, published alongside the deny roots above (same
 * thread-local ownership rules).  A bind link is a user-configured mapping
 * from a virt path inside the session write roots to an outside backing
 * directory, created through the Windows Bind Link API.  It is not an on-disk
 * reparse point, but depending on how bindflt resolves the open the checks
 * below can still observe redirection semantics; the configured pairs are
 * therefore admitted explicitly.  An empty list (the default) changes no
 * behavior. */
static OWC_THREAD_LOCAL wchar_t **bind_virts=NULL;
static OWC_THREAD_LOCAL wchar_t **bind_backings=NULL;
static OWC_THREAD_LOCAL size_t bind_link_count=0;
/* Canonicalize a configured path to a wide DOS path.  handle_resolve uses
 * GetFinalPathNameByHandleW, which follows bindflt redirection - right for
 * backing paths (compared against resolved final paths) but wrong for virt
 * paths, whose redirected handle would resolve to the backing path. */
static wchar_t *canonical_bind_path(const char *path,int handle_resolve){
    wchar_t *w=wide(path),*buf;wchar_t *out=NULL;
    if(!w)return NULL;
    buf=(wchar_t*)malloc(32768*sizeof(*buf));
    if(buf){
        DWORD n=0;
        if(handle_resolve){HANDLE h=CreateFileW(w,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
            if(h!=INVALID_HANDLE_VALUE){n=GetFinalPathNameByHandleW(h,buf,32768,VOLUME_NAME_DOS);CloseHandle(h);}}
        if(!n)n=GetLongPathNameW(w,buf,32768);
        if(n>0&&n<32768){const wchar_t *bare=buf;if(wcsncmp(buf,L"\\\\?\\",4)==0)bare=buf+4;out=_wcsdup(bare);}
    }
    free(buf);free(w);return out;
}
void owc_fs_platform_set_bind_links(const char *const *virt_paths,const char *const *backing_paths,size_t count){
    size_t i;
    for(i=0;i<bind_link_count;i++){free(bind_virts[i]);free(bind_backings[i]);}
    free(bind_virts);free(bind_backings);bind_virts=NULL;bind_backings=NULL;bind_link_count=0;
    if(!virt_paths||!backing_paths||!count) return;
    bind_virts=(wchar_t**)calloc(count,sizeof(*bind_virts));
    bind_backings=(wchar_t**)calloc(count,sizeof(*bind_backings));
    if(!bind_virts||!bind_backings) return;
    for(i=0;i<count;i++){wchar_t *virt=canonical_bind_path(virt_paths[i],0);wchar_t *backing=canonical_bind_path(backing_paths[i],1);if(!virt||!backing){free(virt);free(backing);continue;}bind_virts[bind_link_count]=virt;bind_backings[bind_link_count]=backing;bind_link_count++;}
}
static int within_wide(const wchar_t *path,const wchar_t *root){size_t n=wcslen(root);return _wcsnicmp(path,root,n)==0&&(path[n]==0||path[n]==L'\\'||path[n]==L'/');}
static int bind_link_virt_match(const wchar_t *path){size_t i;for(i=0;i<bind_link_count;i++)if(within_wide(path,bind_virts[i]))return 1;return 0;}
static int bind_link_backing_match(const wchar_t *final){size_t i;const wchar_t *bare=final;if(wcsncmp(final,L"\\\\?\\",4)==0)bare=final+4;for(i=0;i<bind_link_count;i++)if(within_wide(bare,bind_backings[i]))return 1;return 0;}
static int prefix(const wchar_t*p,const wchar_t*r){size_t n=wcslen(r);return _wcsnicmp(p,r,n)==0&&(p[n]==0||p[n]==L'\\');}
static void trim_canonical_separator(wchar_t *path){
    size_t n=wcslen(path);
    while(n&&(path[n-1]==L'\\'||path[n-1]==L'/'))path[--n]=0;
}
/* GetVolumeNameForVolumeMountPointW only accepts a drive root, volume GUID
   path, or an actual mounted folder.  Since callers reach this helper only
   after observing a reparse point, it admits the configured volume mount root
   but rejects directory junctions and symbolic links. */
static owc_fs_error root_is_volume_mount_point(const wchar_t *root,int *mounted){
    wchar_t *mount; wchar_t volume_name[64]; size_t n=wcslen(root);
    *mounted=0;
    if(!n)return OWC_FS_OUTSIDE_ROOT;
    if(n>(size_t)UINT32_MAX-2)return OWC_FS_NO_MEMORY;
    mount=(wchar_t*)malloc((n+2)*sizeof(*mount));
    if(!mount)return OWC_FS_NO_MEMORY;
    memcpy(mount,root,(n+1)*sizeof(*mount));
    if(mount[n-1]!=L'\\'&&mount[n-1]!=L'/'){mount[n++]=L'\\';mount[n]=0;}
    *mounted=GetVolumeNameForVolumeMountPointW(mount,volume_name,
        (DWORD)(sizeof(volume_name)/sizeof(volume_name[0])))!=0;
    free(mount);
    return OWC_FS_OK;
}
static int is_configured_root_path(const char *path){return !strcmp(path,".");}
static owc_fs_error canonical_root(wchar_t **root){
    HANDLE h; BY_HANDLE_FILE_INFORMATION info; wchar_t *final; DWORD n;
    owc_fs_error e; int mounted=0;
    h=CreateFileW(*root,0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,
        OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,NULL);
    if(h==INVALID_HANDLE_VALUE)return winerr();
    if(!GetFileInformationByHandle(h,&info)){CloseHandle(h);return winerr();}
    if(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT){
        e=root_is_volume_mount_point(*root,&mounted);
        CloseHandle(h);
        if(e)return e;
        if(!mounted)return OWC_FS_OUTSIDE_ROOT;
        h=CreateFileW(*root,0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,
            OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
        if(h==INVALID_HANDLE_VALUE)return winerr();
        if(!GetFileInformationByHandle(h,&info)){CloseHandle(h);return winerr();}
        if(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT){CloseHandle(h);return OWC_FS_OUTSIDE_ROOT;}
    }
    n=GetFinalPathNameByHandleW(h,NULL,0,FILE_NAME_NORMALIZED);
    final=(wchar_t*)malloc(((size_t)n+1)*sizeof(*final));
    if(!final||!GetFinalPathNameByHandleW(h,final,n+1,FILE_NAME_NORMALIZED)){
        CloseHandle(h);free(final);return OWC_FS_IO_ERROR;
    }
    trim_canonical_separator(final);
    CloseHandle(h);free(*root);*root=final;
    return OWC_FS_OK;
}
static owc_fs_error paths(const char *root,const char *path,wchar_t **rw,wchar_t **pw){wchar_t *r=wide(root),*p=wide(path),*full;DWORD n;owc_fs_error e;int absolute;if(!r||!p){free(r);free(p);return OWC_FS_INVALID_UTF8;}absolute=p[0]&&p[1]==L':'&&p[2]&&(p[2]==L'\\'||p[2]==L'/');if(wcsstr(p,L"..")||p[0]==L'\\'||(p[0]&&p[1]==L':'&&!absolute)){free(r);free(p);return OWC_FS_OUTSIDE_ROOT;}n=GetFullPathNameW(r,0,NULL,NULL);full=(wchar_t*)malloc(((size_t)n+1)*sizeof(*full));if(!full||!GetFullPathNameW(r,n+1,full,NULL)){free(r);free(p);free(full);return OWC_FS_IO_ERROR;}free(r);r=full;
    /* GetFinalPathNameByHandleW expands 8.3 components (for example
       C:\\Users\\RUNNER~1 on GitHub runners).  Expand the configured root as
       well before comparing the two paths, otherwise a valid child is
       incorrectly reported as escaping the workspace. */
    /* Absolute paths were already checked against the session roots by the RPC layer; skip the root join and let the handle-canonical prefix check below enforce the boundary. */full=absolute?_wcsdup(p):(wchar_t*)malloc((wcslen(r)+wcslen(p)+2)*sizeof(*full));if(!full){free(r);free(p);return OWC_FS_NO_MEMORY;}if(!absolute){wcscpy(full,r);wcscat(full,L"\\");wcscat(full,p);}free(p);
    /* FILE_FLAG_OPEN_REPARSE_POINT on the final open guards only the leaf:
       reject reparse points in intermediate components below the root as
       well, otherwise a junction such as root\link would silently redirect
       the open outside the verified directory tree.  The walk starts past
       the root itself: canonical_root below owns the root reparse verdict
       (a genuine volume mount point is admitted there). */
    {wchar_t *cursor=full+(absolute?3:wcslen(r)+1);
     for(;*cursor;cursor++){if(*cursor!=L'\\'&&*cursor!=L'/')continue;{HANDLE component;DWORD attr=0;int bound=0;*cursor=0;
        component=CreateFileW(full,0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,NULL);
        if(component==INVALID_HANDLE_VALUE){*cursor=L'\\';break;}
        {BY_HANDLE_FILE_INFORMATION component_info;if(GetFileInformationByHandle(component,&component_info))attr=component_info.dwFileAttributes;CloseHandle(component);}
        /* A configured bind link virt path is an explicit session mapping,
           not an attacker-controlled reparse point; admit it here. */
        bound=bind_link_virt_match(full);
        *cursor=L'\\';
        if((attr&FILE_ATTRIBUTE_REPARSE_POINT)&&!bound){free(r);free(full);return OWC_FS_OUTSIDE_ROOT;}}}}
    /* Keep the ordinary DOS path above for file operations; use the handle-
       canonical path only for the workspace-boundary comparison. */
    e=canonical_root(&r);if(e){free(r);free(full);return e;}*rw=r;*pw=full;return OWC_FS_OK;}
static owc_fs_error checked_open_mode(const char*root,const char*path,DWORD access,DWORD create,DWORD extra_flags,HANDLE*h,wchar_t**name){wchar_t*r,*p,*final;DWORD n;BY_HANDLE_FILE_INFORMATION info;owc_fs_error e=paths(root,path,&r,&p);if(e)return e;*h=CreateFileW(p,access,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,create,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS|extra_flags,NULL);if(*h==INVALID_HANDLE_VALUE){e=winerr();free(r);free(p);return e;}if(!GetFileInformationByHandle(*h,&info)){CloseHandle(*h);free(r);free(p);return winerr();}/* Windows reports the configured mounted-folder root as a reparse point when it is addressed as root\\.; canonical_root already verified that one exact root. */if((info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&!is_configured_root_path(path)&&!bind_link_virt_match(p)){CloseHandle(*h);free(r);free(p);return OWC_FS_OUTSIDE_ROOT;}n=GetFinalPathNameByHandleW(*h,NULL,0,FILE_NAME_NORMALIZED);final=(wchar_t*)malloc(((size_t)n+1)*sizeof(*final));if(!final||!GetFinalPathNameByHandleW(*h,final,n+1,FILE_NAME_NORMALIZED)){CloseHandle(*h);free(final);free(r);free(p);return OWC_FS_IO_ERROR;}if(!prefix(final,r)&&!(wcslen(final)>4&&prefix(final+4,r))&&!bind_link_backing_match(final)){CloseHandle(*h);free(final);free(r);free(p);return OWC_FS_OUTSIDE_ROOT;}if(final_path_denied(final)){CloseHandle(*h);free(final);free(r);free(p);return OWC_FS_OUTSIDE_ROOT;}free(final);free(r);if(name)*name=p;else free(p);return OWC_FS_OK;}
static owc_fs_error checked_open(const char*root,const char*path,DWORD access,DWORD create,HANDLE*h,wchar_t**name){return checked_open_mode(root,path,access,create,0,h,name);}
static owc_fs_error ensure_parents(const char *root,const char *path){char *copy,*cursor;size_t n=strlen(path);copy=(char*)malloc(n+1);if(!copy)return OWC_FS_NO_MEMORY;memcpy(copy,path,n+1);for(cursor=copy;*cursor;cursor++){if(*cursor=='/'||*cursor=='\\'){HANDLE h;owc_fs_error e;wchar_t *r,*p;char saved=*cursor;*cursor='\0';if(!copy[0]){free(copy);return OWC_FS_OUTSIDE_ROOT;}e=checked_open(root,copy,0,OPEN_EXISTING,&h,NULL);if(e==OWC_FS_NOT_FOUND){e=paths(root,copy,&r,&p);if(!e){if(!CreateDirectoryW(p,NULL)&&GetLastError()!=ERROR_ALREADY_EXISTS)e=winerr();free(r);free(p);}if(!e)e=checked_open(root,copy,0,OPEN_EXISTING,&h,NULL);}if(!e)CloseHandle(h);*cursor=saved;if(e){free(copy);return e;}}}free(copy);return OWC_FS_OK;}
owc_fs_error owc_fs_platform_read(const char*root,const char*path,owc_fs_bytes*b){HANDLE h;LARGE_INTEGER z;DWORD got;size_t done=0;owc_fs_error e=checked_open(root,path,GENERIC_READ,OPEN_EXISTING,&h,NULL);if(e)return e;if(!GetFileSizeEx(h,&z)||z.QuadPart<0||(unsigned long long)z.QuadPart>OWC_FS_MAX_FILE_SIZE){CloseHandle(h);return OWC_FS_IO_ERROR;}b->length=(size_t)z.QuadPart;b->data=(unsigned char*)malloc(b->length+1);if(!b->data){CloseHandle(h);return OWC_FS_NO_MEMORY;}while(done<b->length){DWORD ask=(DWORD)((b->length-done)>0x40000000?0x40000000:(b->length-done));if(!ReadFile(h,b->data+done,ask,&got,NULL)||!got){free(b->data);CloseHandle(h);return OWC_FS_IO_ERROR;}done+=got;}b->data[b->length]=0;CloseHandle(h);return OWC_FS_OK;}
owc_fs_error owc_fs_platform_read_binary(const char*root,const char*path,size_t limit,owc_fs_bytes*b,int*truncated){HANDLE h;LARGE_INTEGER z;DWORD got;size_t want,done=0;owc_fs_error e=checked_open(root,path,GENERIC_READ,OPEN_EXISTING,&h,NULL);if(e)return e;{BY_HANDLE_FILE_INFORMATION info;if(!GetFileInformationByHandle(h,&info)){CloseHandle(h);return OWC_FS_IO_ERROR;}if(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY){CloseHandle(h);return OWC_FS_IO_ERROR;}}if(!GetFileSizeEx(h,&z)||z.QuadPart<0){CloseHandle(h);return OWC_FS_IO_ERROR;}*truncated=(unsigned long long)z.QuadPart>(unsigned long long)limit;want=*truncated?limit:(size_t)z.QuadPart;b->data=(unsigned char*)malloc(want+1);if(!b->data){CloseHandle(h);return OWC_FS_NO_MEMORY;}b->length=want;while(done<want){DWORD ask=(DWORD)((want-done)>0x40000000?0x40000000:(want-done));if(!ReadFile(h,b->data+done,ask,&got,NULL)||!got){free(b->data);CloseHandle(h);return OWC_FS_IO_ERROR;}done+=got;}b->data[want]=0;CloseHandle(h);return OWC_FS_OK;}
owc_fs_error owc_fs_platform_write(const char*root,const char*path,const unsigned char*d,size_t len,int create_dirs){
    char *parent8,*copy,*leaf8,*separator;wchar_t *leaf,*tmp;HANDLE h=INVALID_HANDLE_VALUE,parent=INVALID_HANDLE_VALUE;DWORD put;size_t done=0;unsigned i;owc_fs_error e;owc_nt_create_file_fn create_file;owc_nt_set_information_file_fn set_information;
    if(create_dirs){e=ensure_parents(root,path);if(e)return e;}
    copy=_strdup(path);if(!copy)return OWC_FS_NO_MEMORY;separator=strrchr(copy,'/');{char *back=strrchr(copy,'\\');if(back&&(!separator||back>separator))separator=back;}
    if(separator){*separator=0;parent8=_strdup(copy[0]?copy:".");leaf8=separator+1;}else{parent8=_strdup(".");leaf8=copy;}
    if(!parent8||!leaf8[0]){free(parent8);free(copy);return OWC_FS_OUTSIDE_ROOT;}
    leaf=wide(leaf8);if(!leaf){free(parent8);free(copy);return OWC_FS_INVALID_UTF8;}
    e=checked_open(root,parent8,FILE_LIST_DIRECTORY|FILE_ADD_FILE|SYNCHRONIZE,OPEN_EXISTING,&parent,NULL);free(parent8);free(copy);if(e){free(leaf);return e;}
    if(!native_file_api(&create_file,&set_information)){CloseHandle(parent);free(leaf);return OWC_FS_IO_ERROR;}
    tmp=(wchar_t*)malloc((wcslen(leaf)+64)*sizeof(*tmp));if(!tmp){CloseHandle(parent);free(leaf);return OWC_FS_NO_MEMORY;}
    for(i=0;i<128;i++){
        swprintf(tmp,wcslen(leaf)+64,L".%s.owc-%lu-%u.tmp",leaf,GetCurrentProcessId(),i);
        if(native_create_relative(create_file,parent,tmp,&h))break;
        if(GetLastError()!=ERROR_FILE_EXISTS)break;
    }
    if(h==INVALID_HANDLE_VALUE){e=winerr();goto end;}
    while(done<len){DWORD ask=(DWORD)((len-done)>0x40000000?0x40000000:(len-done));if(!WriteFile(h,d+done,ask,&put,NULL)||put!=ask){e=OWC_FS_IO_ERROR;native_delete_on_close(set_information,h);goto end;}done+=put;}
    if(!FlushFileBuffers(h)){e=OWC_FS_IO_ERROR;native_delete_on_close(set_information,h);goto end;}
    if(!native_rename_relative(set_information,h,parent,leaf)){e=winerr();native_delete_on_close(set_information,h);goto end;}
    e=OWC_FS_OK;
end:
    if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);if(parent!=INVALID_HANDLE_VALUE)CloseHandle(parent);free(tmp);free(leaf);return e;
}
static void info(const BY_HANDLE_FILE_INFORMATION*i,owc_fs_stat_result*r){ULARGE_INTEGER z,t;z.HighPart=i->nFileSizeHigh;z.LowPart=i->nFileSizeLow;t.HighPart=i->ftLastWriteTime.dwHighDateTime;t.LowPart=i->ftLastWriteTime.dwLowDateTime;r->type=(i->dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)?OWC_FS_TYPE_DIRECTORY:OWC_FS_TYPE_FILE;r->size=z.QuadPart;r->modified_ms=(long long)(t.QuadPart/10000ULL-11644473600000ULL);}
owc_fs_error owc_fs_platform_stat(const char*root,const char*path,owc_fs_stat_result*r){HANDLE h;BY_HANDLE_FILE_INFORMATION i;owc_fs_error e=checked_open(root,path,0,OPEN_EXISTING,&h,NULL);if(e)return e;if(!GetFileInformationByHandle(h,&i)){CloseHandle(h);return winerr();}if((i.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&!is_configured_root_path(path)){/* checked_open already admitted configured bind links; mirror that verdict here from the handle's resolved path. */wchar_t resolved[32768];DWORD rn=GetFinalPathNameByHandleW(h,resolved,32768,FILE_NAME_NORMALIZED);int admitted=0;if(rn>0&&rn<32768){const wchar_t *bare=resolved;if(wcsncmp(resolved,L"\\\\?\\",4)==0)bare=resolved+4;admitted=bind_link_backing_match(resolved)||bind_link_virt_match(bare);}if(!admitted){CloseHandle(h);return OWC_FS_OUTSIDE_ROOT;}}info(&i,r);CloseHandle(h);return OWC_FS_OK;}
owc_fs_error owc_fs_platform_list(const char*root,const char*path,owc_fs_list_result*r){HANDLE h,find;wchar_t*p,*pattern;WIN32_FIND_DATAW d;owc_fs_error e=checked_open(root,path,0,OPEN_EXISTING,&h,&p);if(e)return e;CloseHandle(h);pattern=(wchar_t*)malloc((wcslen(p)+3)*sizeof(*pattern));if(!pattern){free(p);return OWC_FS_NO_MEMORY;}wcscpy(pattern,p);wcscat(pattern,L"\\*");find=FindFirstFileW(pattern,&d);free(pattern);free(p);if(find==INVALID_HANDLE_VALUE)return winerr();do{owc_fs_entry*q;if(!wcscmp(d.cFileName,L".")||!wcscmp(d.cFileName,L"..")||(d.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT))continue;if(r->count>=OWC_FS_MAX_LIST_ENTRIES){r->truncated=1;break;}q=(owc_fs_entry*)realloc(r->entries,(r->count+1)*sizeof(*q));if(!q){FindClose(find);owc_fs_list_free(r);return OWC_FS_NO_MEMORY;}r->entries=q;r->entries[r->count].name=utf8(d.cFileName);if(!r->entries[r->count].name){FindClose(find);owc_fs_list_free(r);return OWC_FS_INVALID_UTF8;}r->entries[r->count].type=(d.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)?OWC_FS_TYPE_DIRECTORY:OWC_FS_TYPE_FILE;r->entries[r->count].size=((unsigned long long)d.nFileSizeHigh<<32)|d.nFileSizeLow;r->count++;}while(FindNextFileW(find,&d));FindClose(find);return OWC_FS_OK;}

/* FindFirstChangeNotificationW is a kernel notification handle rather than a
 * pending directory read.  Polling it with a zero timeout keeps the JSON-RPC
 * reader responsive even on filesystems where overlapped directory reads do
 * not honour a non-blocking completion query. */
struct owc_fs_watch { HANDLE notification; };
static const DWORD watch_filters=FILE_NOTIFY_CHANGE_FILE_NAME|FILE_NOTIFY_CHANGE_DIR_NAME|FILE_NOTIFY_CHANGE_LAST_WRITE|FILE_NOTIFY_CHANGE_SIZE;
owc_fs_error owc_fs_platform_watch_open(const char *root,const char *path,int recursive,owc_fs_watch **result){owc_fs_watch *watch;wchar_t *directory;HANDLE handle;owc_fs_error error;if(!result)return OWC_FS_INVALID_ARGUMENT;*result=NULL;error=checked_open(root,path,0,OPEN_EXISTING,&handle,&directory);if(error)return error;CloseHandle(handle);handle=FindFirstChangeNotificationW(directory,recursive,watch_filters);free(directory);if(handle==INVALID_HANDLE_VALUE)return winerr();watch=(owc_fs_watch*)calloc(1,sizeof(*watch));if(!watch){FindCloseChangeNotification(handle);return OWC_FS_NO_MEMORY;}watch->notification=handle;*result=watch;return OWC_FS_OK;}
owc_fs_error owc_fs_platform_watch_poll(owc_fs_watch *watch,size_t maximum_events,owc_fs_watch_result *result){DWORD state;owc_fs_watch_event *events;if(!watch||!result||!maximum_events)return OWC_FS_INVALID_ARGUMENT;state=WaitForSingleObject(watch->notification,0);if(state==WAIT_TIMEOUT)return OWC_FS_OK;if(state!=WAIT_OBJECT_0)return OWC_FS_IO_ERROR;events=(owc_fs_watch_event*)calloc(1,sizeof(*events));if(!events)return OWC_FS_NO_MEMORY;events[0].path=_strdup("");if(!events[0].path){free(events);return OWC_FS_NO_MEMORY;}events[0].kind="changed";result->events=events;result->count=1;if(!FindNextChangeNotification(watch->notification)){owc_fs_watch_result_free(result);return OWC_FS_IO_ERROR;}return OWC_FS_OK;}
void owc_fs_platform_watch_close(owc_fs_watch *watch){if(!watch)return;if(watch->notification&&watch->notification!=INVALID_HANDLE_VALUE)FindCloseChangeNotification(watch->notification);free(watch);}
#endif
