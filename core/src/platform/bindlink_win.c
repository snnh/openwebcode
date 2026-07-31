#include "../bindlink.h"

#include <stdio.h>
#include <stdlib.h>

#include <windows.h>

/* The Bind Link API ships as bindlink.dll on recent Windows 11 releases; the
 * same entry points are also exported by bindfltapi.dll on builds where the
 * standalone DLL is absent.  Probe both at runtime: a hard import would keep
 * owc-exec from starting at all on older systems. */
typedef HRESULT (WINAPI *owc_create_bind_link_fn)(PCWSTR virtual_path,
    PCWSTR backing_path, ULONG flags, UINT32 exception_count,
    PCWSTR *exception_paths);
typedef HRESULT (WINAPI *owc_remove_bind_link_fn)(PCWSTR virtual_path);

#define OWC_CREATE_BIND_LINK_FLAG_READ_ONLY 0x1ul

static owc_create_bind_link_fn create_bind_link;
static owc_remove_bind_link_fn remove_bind_link;
static int probe_state; /* 0 = not probed, 1 = available, -1 = unavailable */

static void probe(void) {
    HMODULE module;
    if (probe_state) return;
    probe_state=-1;
    module=LoadLibraryW(L"bindlink.dll");
    if (!module) module=LoadLibraryW(L"bindfltapi.dll");
    if (!module) return;
    create_bind_link=(owc_create_bind_link_fn)GetProcAddress(module,"CreateBindLink");
    remove_bind_link=(owc_remove_bind_link_fn)GetProcAddress(module,"RemoveBindLink");
    if (create_bind_link && remove_bind_link) probe_state=1;
}

int owc_bindlink_supported(void) { probe(); return probe_state>0; }

static wchar_t *wide(const char *text) {
    wchar_t *out; int n;
    if (!text) return NULL;
    n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text,-1,NULL,0);
    if (n<=0) return NULL;
    out=(wchar_t*)malloc((size_t)n*sizeof(*out));
    if (!out) return NULL;
    if (!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text,-1,out,n)) { free(out); return NULL; }
    return out;
}

static void store_err(char *err, size_t err_size, const char *prefix, unsigned long code) {
    if (err && err_size) (void)snprintf(err,err_size,"%s (0x%08lx)",prefix,code);
}

int owc_bindlink_create(const char *virt_path, const char *backing_path,
                        int read_only, char *err, size_t err_size) {
    wchar_t *virt,*backing; HRESULT hr;
    if (!owc_bindlink_supported()) {
        if (err && err_size) (void)snprintf(err,err_size,"bind link API is not present on this system");
        return 0;
    }
    virt=wide(virt_path); backing=wide(backing_path);
    if (!virt || !backing) { free(virt); free(backing); store_err(err,err_size,"path is not valid UTF-8",0); return 0; }
    hr=create_bind_link(virt,backing,read_only?OWC_CREATE_BIND_LINK_FLAG_READ_ONLY:0,0,NULL);
    free(virt); free(backing);
    if (FAILED(hr)) { store_err(err,err_size,"CreateBindLink failed",(unsigned long)hr); return 0; }
    return 1;
}

void owc_bindlink_remove(const char *virt_path) {
    wchar_t *virt;
    if (!owc_bindlink_supported()) return;
    virt=wide(virt_path);
    if (!virt) return;
    (void)remove_bind_link(virt);
    free(virt);
}

int owc_bindlink_is_directory(const char *path) {
    wchar_t *w=wide(path); DWORD attr;
    if (!w) return 0;
    attr=GetFileAttributesW(w);
    free(w);
    return attr!=INVALID_FILE_ATTRIBUTES && (attr&FILE_ATTRIBUTE_DIRECTORY)!=0;
}
