#include "fs_platform.h"
#ifdef _WIN32
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static owc_fs_error winerr(void){DWORD e=GetLastError();if(e==ERROR_FILE_NOT_FOUND||e==ERROR_PATH_NOT_FOUND)return OWC_FS_NOT_FOUND;if(e==ERROR_ACCESS_DENIED||e==ERROR_SHARING_VIOLATION)return OWC_FS_PERMISSION_DENIED;return OWC_FS_IO_ERROR;}
static wchar_t *wide(const char *s){int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,NULL,0);wchar_t*w;if(!n)return NULL;w=(wchar_t*)malloc((size_t)n*sizeof(*w));if(w&&!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,w,n)){free(w);w=NULL;}return w;}
static char *utf8(const wchar_t *s){int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s,-1,NULL,0,NULL,NULL);char*p;if(!n)return NULL;p=(char*)malloc((size_t)n);if(p&&!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s,-1,p,n,NULL,NULL)){free(p);p=NULL;}return p;}
static int prefix(const wchar_t*p,const wchar_t*r){size_t n=wcslen(r);return _wcsnicmp(p,r,n)==0&&(p[n]==0||p[n]==L'\\');}
static wchar_t *last_separator(wchar_t *path){wchar_t *back=wcsrchr(path,L'\\'),*forward=wcsrchr(path,L'/');if(!back)return forward;if(!forward)return back;return forward>back?forward:back;}
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
static owc_fs_error paths(const char *root,const char *path,wchar_t **rw,wchar_t **pw){wchar_t *r=wide(root),*p=wide(path),*full;DWORD n;owc_fs_error e;if(!r||!p){free(r);free(p);return OWC_FS_INVALID_UTF8;}if(wcsstr(p,L"..")||p[0]==L'\\'||(p[0]&&p[1]==L':')){free(r);free(p);return OWC_FS_OUTSIDE_ROOT;}n=GetFullPathNameW(r,0,NULL,NULL);full=(wchar_t*)malloc(((size_t)n+1)*sizeof(*full));if(!full||!GetFullPathNameW(r,n+1,full,NULL)){free(r);free(p);free(full);return OWC_FS_IO_ERROR;}free(r);r=full;
    /* GetFinalPathNameByHandleW expands 8.3 components (for example
       C:\\Users\\RUNNER~1 on GitHub runners).  Expand the configured root as
       well before comparing the two paths, otherwise a valid child is
       incorrectly reported as escaping the workspace. */
    full=(wchar_t*)malloc((wcslen(r)+wcslen(p)+2)*sizeof(*full));if(!full){free(r);free(p);return OWC_FS_NO_MEMORY;}wcscpy(full,r);wcscat(full,L"\\");wcscat(full,p);free(p);
    /* Keep the ordinary DOS path above for file operations; use the handle-
       canonical path only for the workspace-boundary comparison. */
    e=canonical_root(&r);if(e){free(r);free(full);return e;}*rw=r;*pw=full;return OWC_FS_OK;}
static owc_fs_error checked_open(const char*root,const char*path,DWORD access,DWORD create,HANDLE*h,wchar_t**name){wchar_t*r,*p,*final;DWORD n;BY_HANDLE_FILE_INFORMATION info;owc_fs_error e=paths(root,path,&r,&p);if(e)return e;*h=CreateFileW(p,access,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,create,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,NULL);if(*h==INVALID_HANDLE_VALUE){e=winerr();free(r);free(p);return e;}if(!GetFileInformationByHandle(*h,&info)){CloseHandle(*h);free(r);free(p);return winerr();}/* Windows reports the configured mounted-folder root as a reparse point when it is addressed as root\\.; canonical_root already verified that one exact root. */if((info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&!is_configured_root_path(path)){CloseHandle(*h);free(r);free(p);return OWC_FS_OUTSIDE_ROOT;}n=GetFinalPathNameByHandleW(*h,NULL,0,FILE_NAME_NORMALIZED);final=(wchar_t*)malloc(((size_t)n+1)*sizeof(*final));if(!final||!GetFinalPathNameByHandleW(*h,final,n+1,FILE_NAME_NORMALIZED)){CloseHandle(*h);free(final);free(r);free(p);return OWC_FS_IO_ERROR;}if(!prefix(final,r)&&!(wcslen(final)>4&&prefix(final+4,r))){CloseHandle(*h);free(final);free(r);free(p);return OWC_FS_OUTSIDE_ROOT;}free(final);free(r);if(name)*name=p;else free(p);return OWC_FS_OK;}
static owc_fs_error ensure_parents(const char *root,const char *path){char *copy,*cursor;size_t n=strlen(path);copy=(char*)malloc(n+1);if(!copy)return OWC_FS_NO_MEMORY;memcpy(copy,path,n+1);for(cursor=copy;*cursor;cursor++){if(*cursor=='/'||*cursor=='\\'){HANDLE h;owc_fs_error e;wchar_t *r,*p;char saved=*cursor;*cursor='\0';if(!copy[0]){free(copy);return OWC_FS_OUTSIDE_ROOT;}e=checked_open(root,copy,0,OPEN_EXISTING,&h,NULL);if(e==OWC_FS_NOT_FOUND){e=paths(root,copy,&r,&p);if(!e){if(!CreateDirectoryW(p,NULL)&&GetLastError()!=ERROR_ALREADY_EXISTS)e=winerr();free(r);free(p);}if(!e)e=checked_open(root,copy,0,OPEN_EXISTING,&h,NULL);}if(!e)CloseHandle(h);*cursor=saved;if(e){free(copy);return e;}}}free(copy);return OWC_FS_OK;}
owc_fs_error owc_fs_platform_read(const char*root,const char*path,owc_fs_bytes*b){HANDLE h;LARGE_INTEGER z;DWORD got;size_t done=0;owc_fs_error e=checked_open(root,path,GENERIC_READ,OPEN_EXISTING,&h,NULL);if(e)return e;if(!GetFileSizeEx(h,&z)||z.QuadPart<0||(unsigned long long)z.QuadPart>OWC_FS_MAX_FILE_SIZE){CloseHandle(h);return OWC_FS_IO_ERROR;}b->length=(size_t)z.QuadPart;b->data=(unsigned char*)malloc(b->length+1);if(!b->data){CloseHandle(h);return OWC_FS_NO_MEMORY;}while(done<b->length){DWORD ask=(DWORD)((b->length-done)>0x40000000?0x40000000:(b->length-done));if(!ReadFile(h,b->data+done,ask,&got,NULL)||!got){free(b->data);CloseHandle(h);return OWC_FS_IO_ERROR;}done+=got;}b->data[b->length]=0;CloseHandle(h);return OWC_FS_OK;}
owc_fs_error owc_fs_platform_write(const char*root,const char*path,const unsigned char*d,size_t len,int create_dirs){wchar_t*r,*p,*slash,*tmp,*parent_rel;HANDLE h,parent_handle;DWORD put;size_t done=0;unsigned i;owc_fs_error e;if(create_dirs){e=ensure_parents(root,path);if(e)return e;}e=paths(root,path,&r,&p);if(e)return e;slash=last_separator(p);if(!slash){free(r);free(p);return OWC_FS_OUTSIDE_ROOT;}parent_rel=wide(path);if(!parent_rel){free(r);free(p);return OWC_FS_INVALID_UTF8;}slash=last_separator(parent_rel);if(slash)*slash=0;else wcscpy(parent_rel,L".");{char*parent8=utf8(parent_rel);free(parent_rel);if(!parent8){free(r);free(p);return OWC_FS_INVALID_UTF8;}e=checked_open(root,parent8,0,OPEN_EXISTING,&parent_handle,NULL);free(parent8);if(e){free(r);free(p);return e;}CloseHandle(parent_handle);}free(r);slash=last_separator(p);tmp=(wchar_t*)malloc((wcslen(p)+64)*sizeof(*tmp));if(!tmp){free(p);return OWC_FS_NO_MEMORY;}for(i=0;i<128;i++){swprintf(tmp,wcslen(p)+64,L"%.*s\\.owc-%lu-%u.tmp",(int)(slash-p),p,GetCurrentProcessId(),i);h=CreateFileW(tmp,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_TEMPORARY,NULL);if(h!=INVALID_HANDLE_VALUE)break;if(GetLastError()!=ERROR_FILE_EXISTS)break;}if(h==INVALID_HANDLE_VALUE){e=winerr();goto end;}while(done<len){DWORD ask=(DWORD)((len-done)>0x40000000?0x40000000:(len-done));if(!WriteFile(h,d+done,ask,&put,NULL)||put!=ask){e=OWC_FS_IO_ERROR;CloseHandle(h);DeleteFileW(tmp);goto end;}done+=put;}if(!FlushFileBuffers(h)){e=OWC_FS_IO_ERROR;CloseHandle(h);DeleteFileW(tmp);goto end;}CloseHandle(h);if(!ReplaceFileW(p,tmp,NULL,REPLACEFILE_WRITE_THROUGH,NULL,NULL)){if(GetLastError()!=ERROR_FILE_NOT_FOUND||!MoveFileExW(tmp,p,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)){e=winerr();DeleteFileW(tmp);goto end;}}e=OWC_FS_OK;end:free(tmp);free(p);return e;}
static void info(const BY_HANDLE_FILE_INFORMATION*i,owc_fs_stat_result*r){ULARGE_INTEGER z,t;z.HighPart=i->nFileSizeHigh;z.LowPart=i->nFileSizeLow;t.HighPart=i->ftLastWriteTime.dwHighDateTime;t.LowPart=i->ftLastWriteTime.dwLowDateTime;r->type=(i->dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)?OWC_FS_TYPE_DIRECTORY:OWC_FS_TYPE_FILE;r->size=z.QuadPart;r->modified_ms=(long long)(t.QuadPart/10000ULL-11644473600000ULL);}
owc_fs_error owc_fs_platform_stat(const char*root,const char*path,owc_fs_stat_result*r){HANDLE h;BY_HANDLE_FILE_INFORMATION i;owc_fs_error e=checked_open(root,path,0,OPEN_EXISTING,&h,NULL);if(e)return e;if(!GetFileInformationByHandle(h,&i)){CloseHandle(h);return winerr();}if((i.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&!is_configured_root_path(path)){CloseHandle(h);return OWC_FS_OUTSIDE_ROOT;}info(&i,r);CloseHandle(h);return OWC_FS_OK;}
owc_fs_error owc_fs_platform_list(const char*root,const char*path,owc_fs_list_result*r){HANDLE h,find;wchar_t*p,*pattern;WIN32_FIND_DATAW d;owc_fs_error e=checked_open(root,path,0,OPEN_EXISTING,&h,&p);if(e)return e;CloseHandle(h);pattern=(wchar_t*)malloc((wcslen(p)+3)*sizeof(*pattern));if(!pattern){free(p);return OWC_FS_NO_MEMORY;}wcscpy(pattern,p);wcscat(pattern,L"\\*");find=FindFirstFileW(pattern,&d);free(pattern);free(p);if(find==INVALID_HANDLE_VALUE)return winerr();do{owc_fs_entry*q;if(!wcscmp(d.cFileName,L".")||!wcscmp(d.cFileName,L"..")||(d.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT))continue;if(r->count>=OWC_FS_MAX_LIST_ENTRIES){r->truncated=1;break;}q=(owc_fs_entry*)realloc(r->entries,(r->count+1)*sizeof(*q));if(!q){FindClose(find);owc_fs_list_free(r);return OWC_FS_NO_MEMORY;}r->entries=q;r->entries[r->count].name=utf8(d.cFileName);if(!r->entries[r->count].name){FindClose(find);owc_fs_list_free(r);return OWC_FS_INVALID_UTF8;}r->entries[r->count].type=(d.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)?OWC_FS_TYPE_DIRECTORY:OWC_FS_TYPE_FILE;r->entries[r->count].size=((unsigned long long)d.nFileSizeHigh<<32)|d.nFileSizeLow;r->count++;}while(FindNextFileW(find,&d));FindClose(find);return OWC_FS_OK;}
#endif
