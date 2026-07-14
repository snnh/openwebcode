#include "path_policy.h"

#include <windows.h>
#include <stdlib.h>
#include <string.h>

static wchar_t *utf8_to_wide(const char *value) {
    int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,value,-1,NULL,0); wchar_t *wide;
    if(!n) return NULL;
    wide=(wchar_t *)malloc((size_t)n*sizeof(*wide));
    if(!wide || !MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,value,-1,wide,n)) { free(wide); return NULL; }
    return wide;
}

int owc_path_resolve(const char *input, char *output, size_t output_size) {
    wchar_t *wide=utf8_to_wide(input), final_path[32768], *normalized;
    HANDLE handle; DWORD length; int bytes;
    if(!wide) return 0;
    handle=CreateFileW(wide,0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
    free(wide);
    if(handle==INVALID_HANDLE_VALUE) return 0;
    length=GetFinalPathNameByHandleW(handle,final_path,(DWORD)(sizeof(final_path)/sizeof(final_path[0])),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
    CloseHandle(handle);
    if(!length || length>=sizeof(final_path)/sizeof(final_path[0])) return 0;
    normalized=final_path;
    if(wcsncmp(normalized,L"\\\\?\\UNC\\",8)==0) {
        normalized+=6;
        normalized[0]=L'\\';
    } else if(wcsncmp(normalized,L"\\\\?\\",4)==0) normalized+=4;
    bytes=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,normalized,-1,NULL,0,NULL,NULL);
    if(bytes<=0 || (size_t)bytes>output_size) return 0;
    return WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,normalized,-1,output,bytes,NULL,NULL)>0;
}
