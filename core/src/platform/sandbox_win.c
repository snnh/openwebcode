#include "sandbox.h"

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

HRESULT WINAPI CreateAppContainerProfile(PCWSTR, PCWSTR, PCWSTR,
                                         PSID_AND_ATTRIBUTES, DWORD, PSID *);
HRESULT WINAPI DeleteAppContainerProfile(PCWSTR);
HRESULT WINAPI DeriveAppContainerSidFromAppContainerName(PCWSTR, PSID *);

struct owc_acl_grant {
    wchar_t *path;
    int access_kind;
};

enum owc_acl_access_kind {
    OWC_ACL_NAMED_PATH = 0,
    OWC_ACL_REPARSE_POINT = 1,
    OWC_ACL_REPARSE_TARGET = 2,
    OWC_ACL_ANCESTOR = 3
};

struct owc_sandbox {
    PSID appcontainer_sid;
    PSID capability_sids[2];
    SID_AND_ATTRIBUTES capabilities[2];
    SECURITY_CAPABILITIES security_capabilities;
    wchar_t *profile_name;
    struct owc_acl_grant *grants;
    size_t grant_count;
    int profile_created;
    int attribute_applied;
    int shared_profile;
    owc_sandbox_status status;
};

static void set_reason(char *reason, size_t size, const char *text) {
    if (!reason || size == 0) return;
    (void)snprintf(reason, size, "%s", text ? text : "");
}

static wchar_t *utf8_to_wide(const char *text) {
    int length;
    wchar_t *wide;
    if (!text) return NULL;
    length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, NULL, 0);
    if (length <= 0) return NULL;
    wide = (wchar_t *)calloc((size_t)length, sizeof(*wide));
    if (!wide) return NULL;
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, wide, length)) {
        free(wide);
        return NULL;
    }
    return wide;
}

/* A DACL edit is read-modify-write.  Two write modes on purpose:
 * write roots use the *Named* Win32 APIs, which physically propagate
 * inheritable ACEs to existing descendants (access checks do not
 * apply a parent's new ACE retroactively, so the workspace tree is
 * only accessible through this propagation); ancestor traverse
 * grants use NtSetSecurityObject, which touches only the object
 * itself, because propagating into an ancestor's tree can rewrite
 * millions of ACLs.  Two commands on the same write root in this one
 * core process can otherwise interleave and have one grant overwrite
 * the other's.  Serialize the RMW per process so concurrent
 * grants/revokes never clobber. */
static INIT_ONCE acl_once = INIT_ONCE_STATIC_INIT;
static CRITICAL_SECTION acl_mutex;
static LONG (NTAPI *nt_set_security_object)(HANDLE, SECURITY_INFORMATION,
                                            PSECURITY_DESCRIPTOR);
static BOOL CALLBACK acl_mutex_init(PINIT_ONCE once, PVOID param, PVOID *context) {
    HMODULE ntdll;
    (void)once; (void)param; (void)context;
    InitializeCriticalSection(&acl_mutex);
    ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll)
        nt_set_security_object = (LONG (NTAPI *)(HANDLE, SECURITY_INFORMATION,
                                                 PSECURITY_DESCRIPTOR))
            GetProcAddress(ntdll, "NtSetSecurityObject");
    return TRUE;
}

static DWORD change_root_access(const wchar_t *path, PSID sid, ACCESS_MODE mode,
                                DWORD permissions, DWORD inheritance,
                                int access_kind) {
    PACL old_acl = NULL, new_acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    HANDLE handle = INVALID_HANDLE_VALUE;
    EXPLICIT_ACCESSW access;
    DWORD error;
    (void)InitOnceExecuteOnce(&acl_once, acl_mutex_init, NULL, NULL);
    EnterCriticalSection(&acl_mutex);
    if (access_kind != OWC_ACL_NAMED_PATH) {
        DWORD flags = FILE_FLAG_BACKUP_SEMANTICS;
        if (access_kind == OWC_ACL_REPARSE_POINT)
            flags |= FILE_FLAG_OPEN_REPARSE_POINT;
        handle = CreateFileW(path, READ_CONTROL | WRITE_DAC,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             NULL, OPEN_EXISTING, flags, NULL);
        error = handle == INVALID_HANDLE_VALUE ? GetLastError() :
            GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            NULL, NULL, &old_acl, NULL, &descriptor);
    } else {
        error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                      DACL_SECURITY_INFORMATION, NULL, NULL,
                                      &old_acl, NULL, &descriptor);
    }
    if (error == ERROR_SUCCESS) {
        memset(&access, 0, sizeof(access));
        access.grfAccessPermissions = permissions;
        access.grfAccessMode = mode;
        access.grfInheritance = inheritance;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_USER;
        access.Trustee.ptstrName = (LPWSTR)sid;
        error = SetEntriesInAclW(1, &access, old_acl, &new_acl);
        if (error == ERROR_SUCCESS) {
            if (access_kind == OWC_ACL_NAMED_PATH) {
                error = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                              DACL_SECURITY_INFORMATION,
                                              NULL, NULL, new_acl, NULL);
            } else if (nt_set_security_object) {
                SECURITY_DESCRIPTOR replacement;
                LONG status;
                InitializeSecurityDescriptor(&replacement, SECURITY_DESCRIPTOR_REVISION);
                SetSecurityDescriptorDacl(&replacement, TRUE, new_acl, FALSE);
                status = nt_set_security_object(handle, DACL_SECURITY_INFORMATION,
                                                &replacement);
                error = status >= 0 ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
            } else {
                error = SetSecurityInfo(handle, SE_FILE_OBJECT,
                                        DACL_SECURITY_INFORMATION,
                                        NULL, NULL, new_acl, NULL);
            }
        }
    }
    LeaveCriticalSection(&acl_mutex);
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    if (new_acl) LocalFree(new_acl);
    if (descriptor) LocalFree(descriptor);
    return error;
}

/* Cleanup revokes only the command's own SID ACE; it never rewrites the
 * surrounding DACL, so concurrent commands on the same write root cannot
 * strip one another's grant or resurrect a finished command's stale ACE. */
static DWORD restore_grant(const struct owc_acl_grant *grant, PSID sid) {
    return change_root_access(grant->path, sid, REVOKE_ACCESS, 0,
                              NO_INHERITANCE, grant->access_kind);
}

static int remember_grant(owc_sandbox *sandbox, wchar_t *path,
                          int access_kind) {
    struct owc_acl_grant *grown = (struct owc_acl_grant *)realloc(
        sandbox->grants, (sandbox->grant_count + 1) * sizeof(*grown));
    if (!grown) return 0;
    sandbox->grants = grown;
    sandbox->grants[sandbox->grant_count].path = path;
    sandbox->grants[sandbox->grant_count].access_kind = access_kind;
    sandbox->grant_count++;
    return 1;
}

/* Add a command-unique SID ACE without snapshotting the entire DACL. Cleanup
 * revokes only this SID, so concurrent commands on the same write root cannot
 * overwrite one another's ACL state or resurrect a finished command's ACE.
 * Inheritance is taken as a parameter so the same primitive serves traverse-
 * only ancestor grants (NO_INHERITANCE) and write-root grants that must let
 * newly created files inherit access (SUB_CONTAINERS_AND_OBJECTS_INHERIT). */
static int grant_temporary(owc_sandbox *sandbox, const wchar_t *path,
                           DWORD permissions, DWORD inheritance,
                           int access_kind) {
    size_t length = wcslen(path) + 1;
    wchar_t *copy = (wchar_t *)malloc(length * sizeof(*copy));
    if (!copy) return 0;
    (void)memcpy(copy, path, length * sizeof(*copy));
    if (change_root_access(copy, sandbox->appcontainer_sid, GRANT_ACCESS,
                           permissions, inheritance, access_kind) != ERROR_SUCCESS ||
        !remember_grant(sandbox, copy, access_kind)) {
        (void)change_root_access(copy, sandbox->appcontainer_sid, REVOKE_ACCESS,
                                 0, inheritance, access_kind);
        free(copy);
        return 0;
    }
    return 1;
}

#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
static int grant_ancestor_traverse(owc_sandbox *sandbox, const char *root) {
    wchar_t *path = utf8_to_wide(root);
    size_t length;
    int ok = 1;
    if (!path) return 0;
    length = wcslen(path);
    while (length > 3 && (path[length - 1] == L'\\' || path[length - 1] == L'/'))
        path[--length] = L'\0';
    for (;;) {
        wchar_t *slash = wcsrchr(path, L'\\');
        wchar_t *forward = wcsrchr(path, L'/');
        if (!slash || (forward && forward > slash)) slash = forward;
        if (!slash) break;
        if (slash == path + 2 && path[1] == L':') {
            path[3] = L'\0';
            ok = grant_temporary(sandbox, path, FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                 NO_INHERITANCE, OWC_ACL_ANCESTOR);
            break;
        }
        *slash = L'\0';
        if (!path[0] || !grant_temporary(sandbox, path,
                                         FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                         NO_INHERITANCE, OWC_ACL_ANCESTOR)) {
            ok = 0;
            break;
        }
    }
    free(path);
    return ok;
}
#endif

static int grant_write_roots(owc_sandbox *sandbox,
                             const owc_sandbox_options *options,
                             char *reason, size_t reason_size) {
    size_t i;
    for (i = 0; i < options->write_root_count; ++i) {
        wchar_t *path = utf8_to_wide(options->write_roots[i]);
        DWORD attributes;
        if (!path) {
            set_reason(reason, reason_size, "writeRoot is not valid UTF-8");
            return 0;
        }
        attributes = GetFileAttributesW(path);
        if (attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            !grant_temporary(sandbox, path,
                             FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                             NO_INHERITANCE, OWC_ACL_REPARSE_POINT)) {
            free(path);
            set_reason(reason, reason_size, "writeRoot mount-point ACL grant failed");
            return 0;
        }
        if (!grant_temporary(sandbox, path,
                             FILE_GENERIC_READ | FILE_GENERIC_WRITE |
                                 FILE_GENERIC_EXECUTE | DELETE,
                             SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                             (attributes != INVALID_FILE_ATTRIBUTES &&
                              (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
                                 ? OWC_ACL_REPARSE_TARGET
                                 : OWC_ACL_NAMED_PATH)) {
            free(path);
            set_reason(reason, reason_size, "writeRoot ACL grant failed");
            return 0;
        }
        free(path);
    }
    /* The ACL unit-test target exercises write-root grant/cleanup without
     * editing the test runner's ancestor ACLs. */
#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
    /* Best-effort on every ancestor: a non-elevated core cannot edit DACLs
       it does not own (drive roots), and the ancestor may already be
       traversable via an existing ACE.  Grant where possible so shells that
       stat every path component (pwsh Set-Location) work on user-owned
       layouts; the write-root grant above remains the enforced boundary. */
    for (i = 0; i < options->write_root_count; ++i)
        (void)grant_ancestor_traverse(sandbox, options->write_roots[i]);
#endif
    return 1;
}

static void revoke_write_roots(owc_sandbox *sandbox) {
    size_t i = sandbox->grant_count;
    while (i > 0) {
        --i;
        (void)restore_grant(&sandbox->grants[i], sandbox->appcontainer_sid);
        free(sandbox->grants[i].path);
    }
    free(sandbox->grants);
}

/* Bind Link backing directories sit outside the write roots, so a sandboxed
 * process reaching them through the virtPath needs its own grant on the
 * backing tree.  Same mechanics as the write-root grants (recorded and
 * revoked symmetrically by revoke_write_roots, reparse points handled on
 * both the point and its target); read-only links get the
 * read/traverse/execute tier, writable links the write-root tier. */
static int grant_bind_backings(owc_sandbox *sandbox,
                               const owc_sandbox_options *options,
                               char *reason, size_t reason_size) {
    size_t i;
    for (i = 0; i < options->bind_count; ++i) {
        wchar_t *path = utf8_to_wide(options->bind_backing[i]);
        DWORD attributes;
        int read_only = options->bind_read_only ? options->bind_read_only[i] : 0;
        if (!path) {
            set_reason(reason, reason_size, "bind backing path is not valid UTF-8");
            return 0;
        }
        attributes = GetFileAttributesW(path);
        if (attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            !grant_temporary(sandbox, path,
                             FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                             NO_INHERITANCE, OWC_ACL_REPARSE_POINT)) {
            free(path);
            set_reason(reason, reason_size, "bind backing mount-point ACL grant failed");
            return 0;
        }
        if (!grant_temporary(sandbox, path,
                             read_only
                                 ? FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_TRAVERSE
                                 : FILE_GENERIC_READ | FILE_GENERIC_WRITE |
                                       FILE_GENERIC_EXECUTE | DELETE,
                             SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                             (attributes != INVALID_FILE_ATTRIBUTES &&
                              (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
                                 ? OWC_ACL_REPARSE_TARGET
                                 : OWC_ACL_NAMED_PATH)) {
            free(path);
            set_reason(reason, reason_size, "bind backing ACL grant failed");
            return 0;
        }
        free(path);
    }
    /* Same best-effort ancestor traverse as the write roots: the backing
       tree is reached by traversing its ancestors, which the AppContainer
       may not own. */
#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
    for (i = 0; i < options->bind_count; ++i)
        (void)grant_ancestor_traverse(sandbox, options->bind_backing[i]);
#endif
    return 1;
}

/* readOnlyPaths get the same read/traverse/execute tier as a read-only
 * Bind Link backing: generic read grants for tools and data the sandboxed
 * process may consume but never modify.  Grants are purely additive, so a
 * path whose DACL this process cannot edit (for example a machine-wide tool
 * install owned by Administrators) is skipped best-effort - failing to add
 * access is already fail-closed and must not sink the whole configure.
 * Recorded and revoked through the same grant list as the write roots. */
static int grant_read_only_paths(owc_sandbox *sandbox,
                                 const owc_sandbox_options *options,
                                 char *reason, size_t reason_size) {
    size_t i;
    for (i = 0; i < options->read_only_count; ++i) {
        wchar_t *path = utf8_to_wide(options->read_only_paths[i]);
        DWORD attributes;
        if (!path) {
            set_reason(reason, reason_size, "readOnlyPaths entry is not valid UTF-8");
            return 0;
        }
        attributes = GetFileAttributesW(path);
        if (attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
            (void)grant_temporary(sandbox, path,
                                  FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                  NO_INHERITANCE, OWC_ACL_REPARSE_POINT);
        (void)grant_temporary(sandbox, path,
                              FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_TRAVERSE,
                              SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                              (attributes != INVALID_FILE_ATTRIBUTES &&
                               (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
                                  ? OWC_ACL_REPARSE_TARGET
                                  : OWC_ACL_NAMED_PATH);
        free(path);
    }
#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
    for (i = 0; i < options->read_only_count; ++i)
        (void)grant_ancestor_traverse(sandbox, options->read_only_paths[i]);
#endif
    return 1;
}

static wchar_t *make_profile_name(const char *session_id) {
    static const wchar_t prefix[] = L"OpenWebCode.";
    size_t input_length = strlen(session_id), i, prefix_length = ARRAYSIZE(prefix) - 1;
    wchar_t *name = (wchar_t *)calloc(prefix_length + input_length + 1, sizeof(*name));
    if (!name) return NULL;
    (void)memcpy(name, prefix, prefix_length * sizeof(*name));
    for (i = 0; i < input_length; ++i) {
        unsigned char c = (unsigned char)session_id[i];
        name[prefix_length + i] = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                                  (c >= '0' && c <= '9') || c == '.' || c == '-'
                                      ? (wchar_t)c : L'_';
    }
    return name;
}

static INIT_ONCE sandbox_probe_once = INIT_ONCE_STATIC_INIT;
static owc_sandbox_status sandbox_probe_status = OWC_SANDBOX_ADVISORY;
static char sandbox_probe_reason[192];

/* The probe launches a one-time verification process on first use: profile
 * creation alone only proves the API exists, not that the security
 * capabilities process attribute is honored end to end.  A successful
 * "cmd.exe /c exit 0" under PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
 * upgrades the reported capability from partial to enforced; any failure
 * keeps partial with the real failure point recorded. */
static void probe_process_attribute(PSID sid) {
    wchar_t system_dir[MAX_PATH];
    wchar_t command[MAX_PATH + 16];
    SECURITY_CAPABILITIES capabilities;
    STARTUPINFOEXW startup;
    PROCESS_INFORMATION process;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    SIZE_T attribute_size = 0;
    DWORD length, error, exit_code = 1, wait_result;
    memset(&capabilities, 0, sizeof(capabilities));
    memset(&startup, 0, sizeof(startup));
    memset(&process, 0, sizeof(process));
    length = GetSystemDirectoryW(system_dir, (UINT)ARRAYSIZE(system_dir));
    if (!length || length >= ARRAYSIZE(system_dir) - 8 ||
        wcscat_s(system_dir, ARRAYSIZE(system_dir), L"\\cmd.exe") != 0 ||
        swprintf_s(command, ARRAYSIZE(command), L"\"%ls\" /c exit 0",
                   system_dir) < 0) {
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer probe command construction failed; per-process enforcement is unverified");
        return;
    }
    capabilities.AppContainerSid = sid;
    (void)InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
    if (!attribute_size) {
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer probe attribute list sizing failed; per-process enforcement is unverified");
        return;
    }
    attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attribute_size);
    if (!attributes ||
        !InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size)) {
        free(attributes);
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer probe attribute list initialization failed; per-process enforcement is unverified");
        return;
    }
    if (!UpdateProcThreadAttribute(attributes, 0,
                                   PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                   &capabilities, sizeof(capabilities),
                                   NULL, NULL)) {
        error = GetLastError();
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer probe security capabilities attribute failed (error=%lu)",
                       (unsigned long)error);
        goto done;
    }
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes;
    if (!CreateProcessW(NULL, command, NULL, NULL, FALSE,
                        CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                        NULL, NULL, &startup.StartupInfo, &process)) {
        error = GetLastError();
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer probe process creation failed (error=%lu); per-process enforcement is unverified",
                       (unsigned long)error);
        goto done;
    }
    wait_result = WaitForSingleObject(process.hProcess, 10000);
    if (wait_result != WAIT_OBJECT_0) {
        (void)TerminateProcess(process.hProcess, 1);
        (void)WaitForSingleObject(process.hProcess, 2000);
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer probe process did not exit in time (wait=%lu)",
                       (unsigned long)wait_result);
    } else if (!GetExitCodeProcess(process.hProcess, &exit_code) || exit_code != 0) {
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer probe process exited with code %lu",
                       (unsigned long)exit_code);
    } else {
        sandbox_probe_status = OWC_SANDBOX_ENFORCED;
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer verified end-to-end (profile + process attribute)");
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
done:
    DeleteProcThreadAttributeList(attributes);
    free(attributes);
}

static BOOL CALLBACK sandbox_probe_init(PINIT_ONCE once, PVOID param,
                                        PVOID *context) {
    wchar_t profile_name[64];
    PSID sid = NULL;
    HRESULT hr;
    int profile_available = 0;
    (void)once; (void)param; (void)context;
    if (swprintf_s(profile_name, ARRAYSIZE(profile_name),
                   L"OpenWebCode.Probe.%lu",
                   (unsigned long)GetCurrentProcessId()) < 0) {
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer probe name creation failed");
        return TRUE;
    }
    hr = CreateAppContainerProfile(profile_name, profile_name,
                                   L"OpenWebCode capability probe", NULL, 0,
                                   &sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(profile_name, &sid);
        profile_available = SUCCEEDED(hr);
    } else {
        profile_available = SUCCEEDED(hr);
    }
    if (profile_available && sid) {
        sandbox_probe_status = OWC_SANDBOX_PARTIAL;
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer profile creation is available; per-process enforcement has not yet been verified");
        probe_process_attribute(sid);
        FreeSid(sid);
        (void)DeleteAppContainerProfile(profile_name);
        return TRUE;
    }
    if (profile_available) {
        (void)DeleteAppContainerProfile(profile_name);
        sandbox_probe_status = OWC_SANDBOX_PARTIAL;
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer profile creation returned no SID; per-process enforcement is unverified");
        return TRUE;
    }
    if (sid) FreeSid(sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_CALL_NOT_IMPLEMENTED) ||
        hr == HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND)) {
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer APIs are not supported by this Windows version");
    } else {
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer profile creation is unavailable (HRESULT=0x%08lx)",
                       (unsigned long)hr);
    }
    return TRUE;
}

const char *owc_sandbox_status_name(owc_sandbox_status status) {
    if (status == OWC_SANDBOX_ENFORCED) return "enforced";
    if (status == OWC_SANDBOX_PARTIAL) return "partial";
    return "advisory";
}

owc_sandbox_status owc_sandbox_probe(char *reason, size_t reason_size) {
    (void)InitOnceExecuteOnce(&sandbox_probe_once, sandbox_probe_init,
                              NULL, NULL);
    set_reason(reason, reason_size, sandbox_probe_reason);
    return sandbox_probe_status;
}

owc_sandbox *owc_sandbox_create(const owc_sandbox_options *options,
                                char *reason, size_t reason_size) {
    owc_sandbox *sandbox;
    HRESULT hr;
    if (!options || !options->session_id || !options->session_id[0]) {
        set_reason(reason, reason_size, "sandbox requires a non-empty session id");
        return NULL;
    }
    sandbox = (owc_sandbox *)calloc(1, sizeof(*sandbox));
    if (!sandbox) {
        set_reason(reason, reason_size, "sandbox allocation failed");
        return NULL;
    }
    sandbox->status = OWC_SANDBOX_PARTIAL;
    sandbox->shared_profile = options->shared_profile ? 1 : 0;
    sandbox->profile_name = make_profile_name(options->session_id);
    if (!sandbox->profile_name) goto fail;

    /* Convert the requested capability SIDs BEFORE profile creation: a
       process can only receive SECURITY_CAPABILITIES entries that its
       profile carries, and a profile created with zero capabilities
       silently drops every requested capability (CreateProcess still
       succeeds).  The same SID set therefore goes to both the profile and
       the per-process attribute. */
    if (options->allow_network) {
        size_t capability_count = 0;
        if (!ConvertStringSidToSidW(L"S-1-15-3-1", &sandbox->capability_sids[capability_count])) {
            set_reason(reason, reason_size, "internetClient capability SID creation failed");
            goto fail;
        }
        sandbox->capabilities[capability_count].Sid = sandbox->capability_sids[capability_count];
        sandbox->capabilities[capability_count].Attributes = SE_GROUP_ENABLED;
        capability_count++;
        if (options->private_network) {
            if (!ConvertStringSidToSidW(L"S-1-15-3-3", &sandbox->capability_sids[capability_count])) {
                set_reason(reason, reason_size, "privateNetworkClientServer capability SID creation failed");
                goto fail;
            }
            sandbox->capabilities[capability_count].Sid = sandbox->capability_sids[capability_count];
            sandbox->capabilities[capability_count].Attributes = SE_GROUP_ENABLED;
            capability_count++;
        }
        sandbox->security_capabilities.Capabilities = sandbox->capabilities;
        sandbox->security_capabilities.CapabilityCount = (DWORD)capability_count;
    }

    hr = CreateAppContainerProfile(sandbox->profile_name, sandbox->profile_name,
                                   L"OpenWebCode command session",
                                   sandbox->security_capabilities.Capabilities,
                                   sandbox->security_capabilities.CapabilityCount,
                                   &sandbox->appcontainer_sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(sandbox->profile_name,
                                                        &sandbox->appcontainer_sid);
        if (FAILED(hr)) {
            set_reason(reason, reason_size, "existing AppContainer SID derivation failed");
            goto fail;
        }
    } else if (FAILED(hr)) {
        if (reason && reason_size > 0)
            (void)snprintf(reason, reason_size,
                           "AppContainer profile creation failed (HRESULT=0x%08lx); sandbox is partial",
                           (unsigned long)hr);
        goto fail;
    } else {
        /* A shared profile belongs to the session grant: even when this
           per-command create happened to win the creation race, destroy must
           never delete it. */
        sandbox->profile_created = sandbox->shared_profile ? 0 : 1;
    }

    sandbox->security_capabilities.AppContainerSid = sandbox->appcontainer_sid;
    sandbox->security_capabilities.Reserved = 0;

    if (!sandbox->shared_profile) {
        if (!grant_write_roots(sandbox, options, reason, reason_size)) goto fail;
        if (!grant_read_only_paths(sandbox, options, reason, reason_size)) goto fail;
        if (!grant_bind_backings(sandbox, options, reason, reason_size)) goto fail;
    }
    sandbox->status = OWC_SANDBOX_ENFORCED;
    set_reason(reason, reason_size, "AppContainer prepared; enforcement begins only after process creation uses its attribute");
    return sandbox;
fail:
    owc_sandbox_destroy(sandbox);
    return NULL;
}

int owc_sandbox_add_process_attribute(owc_sandbox *sandbox,
                                      LPPROC_THREAD_ATTRIBUTE_LIST attributes,
                                      char *reason, size_t reason_size) {
    if (!sandbox || !attributes) return 0;
    if (!UpdateProcThreadAttribute(attributes, 0,
                                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                    &sandbox->security_capabilities,
                                    sizeof(sandbox->security_capabilities), NULL, NULL)) {
        set_reason(reason, reason_size, "process security capabilities attribute could not be applied");
        return 0;
    }
    sandbox->attribute_applied = 1;
    return 1;
}

owc_sandbox_status owc_sandbox_get_status(const owc_sandbox *sandbox) {
    if (!sandbox) return OWC_SANDBOX_ADVISORY;
    if (!sandbox->attribute_applied) return OWC_SANDBOX_PARTIAL;
    return sandbox->status == OWC_SANDBOX_PARTIAL ? OWC_SANDBOX_PARTIAL : OWC_SANDBOX_ENFORCED;
}

void owc_sandbox_destroy(owc_sandbox *sandbox) {
    size_t i;
    if (!sandbox) return;
    revoke_write_roots(sandbox);
    for (i = 0; i < ARRAYSIZE(sandbox->capability_sids); ++i)
        if (sandbox->capability_sids[i]) LocalFree(sandbox->capability_sids[i]);
    if (sandbox->appcontainer_sid) FreeSid(sandbox->appcontainer_sid);
    if (sandbox->profile_created && sandbox->profile_name)
        (void)DeleteAppContainerProfile(sandbox->profile_name);
    free(sandbox->profile_name);
    free(sandbox);
}

/* Session-scoped registry for filtered-network sessions: the fixed
 * OpenWebCode.<session-id> profile and its ACL grants live from configure to
 * cleanup/reconfigure/exit so the business processes and the in-sandbox
 * proxy sidecar share one package identity (same-package loopback is the
 * mechanism that lets the capability-less business process reach the
 * sidecar).  Bounded and mutex-guarded like the ACL RMW above. */
#define OWC_SANDBOX_MAX_SESSION_GRANTS 16u
static INIT_ONCE session_grant_once = INIT_ONCE_STATIC_INIT;
static CRITICAL_SECTION session_grant_mutex;
static struct {
    char *session_id;
    owc_sandbox *sandbox;
} session_grants[OWC_SANDBOX_MAX_SESSION_GRANTS];
static size_t session_grant_count = 0;

static BOOL CALLBACK session_grant_mutex_init(PINIT_ONCE once, PVOID param,
                                              PVOID *context) {
    (void)once; (void)param; (void)context;
    InitializeCriticalSection(&session_grant_mutex);
    return TRUE;
}

static size_t session_grant_find(const char *session_id) {
    size_t i;
    for (i = 0; i < session_grant_count; ++i)
        if (!strcmp(session_grants[i].session_id, session_id)) return i;
    return session_grant_count;
}

static void session_grant_remove(size_t index) {
    owc_sandbox_destroy(session_grants[index].sandbox);
    free(session_grants[index].session_id);
    if (index != session_grant_count - 1)
        session_grants[index] = session_grants[session_grant_count - 1];
    session_grant_count--;
}

int owc_sandbox_session_grant(const char *session_id,
                              const owc_sandbox_options *options,
                              char *reason, size_t reason_size) {
    owc_sandbox *sandbox;
    char *id_copy;
    size_t index;
    if (!session_id || !session_id[0] || !options) {
        set_reason(reason, reason_size, "sandbox session grant requires a non-empty session id");
        return 0;
    }
    (void)InitOnceExecuteOnce(&session_grant_once, session_grant_mutex_init,
                              NULL, NULL);
    /* Idempotent re-grant: revoke the previous grant first, because creating
       the replacement would derive the still-registered profile and the old
       grant's destroy would then delete it under the new SID. */
    EnterCriticalSection(&session_grant_mutex);
    index = session_grant_find(session_id);
    if (index < session_grant_count) session_grant_remove(index);
    LeaveCriticalSection(&session_grant_mutex);
    /* Stale profiles from crashed or older cores may carry the wrong
       capability set; recreate so the grant always owns a fresh profile.
       Best effort: deletion fails while a process still uses the profile. */
    {
        wchar_t *stale = make_profile_name(session_id);
        if (stale) {
            (void)DeleteAppContainerProfile(stale);
            free(stale);
        }
    }
    sandbox = owc_sandbox_create(options, reason, reason_size);
    if (!sandbox) return 0;
    id_copy = (char *)malloc(strlen(session_id) + 1);
    if (!id_copy) {
        owc_sandbox_destroy(sandbox);
        set_reason(reason, reason_size, "sandbox session grant allocation failed");
        return 0;
    }
    (void)strcpy(id_copy, session_id);
    EnterCriticalSection(&session_grant_mutex);
    if (session_grant_count >= OWC_SANDBOX_MAX_SESSION_GRANTS) {
        LeaveCriticalSection(&session_grant_mutex);
        free(id_copy);
        owc_sandbox_destroy(sandbox);
        set_reason(reason, reason_size, "sandbox session grant limit reached");
        return 0;
    }
    session_grants[session_grant_count].session_id = id_copy;
    session_grants[session_grant_count].sandbox = sandbox;
    session_grant_count++;
    LeaveCriticalSection(&session_grant_mutex);
    return 1;
}

void owc_sandbox_session_revoke(const char *session_id) {
    size_t index;
    if (!session_id) return;
    (void)InitOnceExecuteOnce(&session_grant_once, session_grant_mutex_init,
                              NULL, NULL);
    EnterCriticalSection(&session_grant_mutex);
    index = session_grant_find(session_id);
    if (index < session_grant_count) session_grant_remove(index);
    LeaveCriticalSection(&session_grant_mutex);
}

void owc_sandbox_session_revoke_all(void) {
    (void)InitOnceExecuteOnce(&session_grant_once, session_grant_mutex_init,
                              NULL, NULL);
    EnterCriticalSection(&session_grant_mutex);
    while (session_grant_count) session_grant_remove(session_grant_count - 1);
    LeaveCriticalSection(&session_grant_mutex);
}
