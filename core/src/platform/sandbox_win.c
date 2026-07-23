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
    int open_reparse_point;
};

struct owc_sandbox {
    PSID appcontainer_sid;
    PSID capability_sid;
    SID_AND_ATTRIBUTES capability;
    SECURITY_CAPABILITIES security_capabilities;
    wchar_t *profile_name;
    struct owc_acl_grant *grants;
    size_t grant_count;
    int profile_created;
    int attribute_applied;
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

/* A DACL edit is read-modify-write (GetNamedSecurityInfo -> SetEntriesInAcl ->
 * SetNamedSecurityInfo). Two commands on the same write root in this one core
 * process can otherwise interleave and have one grant overwrite the other's.
 * Serialize the RMW per process so concurrent grants/revokes never clobber. */
static INIT_ONCE acl_once = INIT_ONCE_STATIC_INIT;
static CRITICAL_SECTION acl_mutex;
static BOOL CALLBACK acl_mutex_init(PINIT_ONCE once, PVOID param, PVOID *context) {
    (void)once; (void)param; (void)context;
    InitializeCriticalSection(&acl_mutex);
    return TRUE;
}

static DWORD change_root_access(const wchar_t *path, PSID sid, ACCESS_MODE mode,
                                DWORD permissions, DWORD inheritance,
                                int open_reparse_point) {
    PACL old_acl = NULL, new_acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    HANDLE handle = INVALID_HANDLE_VALUE;
    EXPLICIT_ACCESSW access;
    DWORD error;
    (void)InitOnceExecuteOnce(&acl_once, acl_mutex_init, NULL, NULL);
    EnterCriticalSection(&acl_mutex);
    if (open_reparse_point) {
        handle = CreateFileW(path, READ_CONTROL | WRITE_DAC,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             NULL, OPEN_EXISTING,
                             FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                             NULL);
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
            error = open_reparse_point
                ? SetSecurityInfo(handle, SE_FILE_OBJECT,
                                  DACL_SECURITY_INFORMATION,
                                  NULL, NULL, new_acl, NULL)
                : SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                        DACL_SECURITY_INFORMATION,
                                        NULL, NULL, new_acl, NULL);
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
                              NO_INHERITANCE, grant->open_reparse_point);
}

static int remember_grant(owc_sandbox *sandbox, wchar_t *path,
                          int open_reparse_point) {
    struct owc_acl_grant *grown = (struct owc_acl_grant *)realloc(
        sandbox->grants, (sandbox->grant_count + 1) * sizeof(*grown));
    if (!grown) return 0;
    sandbox->grants = grown;
    sandbox->grants[sandbox->grant_count].path = path;
    sandbox->grants[sandbox->grant_count].open_reparse_point = open_reparse_point;
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
                           int open_reparse_point) {
    size_t length = wcslen(path) + 1;
    wchar_t *copy = (wchar_t *)malloc(length * sizeof(*copy));
    if (!copy) return 0;
    (void)memcpy(copy, path, length * sizeof(*copy));
    if (change_root_access(copy, sandbox->appcontainer_sid, GRANT_ACCESS,
                           permissions, inheritance, open_reparse_point) != ERROR_SUCCESS ||
        !remember_grant(sandbox, copy, open_reparse_point)) {
        (void)change_root_access(copy, sandbox->appcontainer_sid, REVOKE_ACCESS,
                                 0, inheritance, open_reparse_point);
        free(copy);
        return 0;
    }
    return 1;
}

static int process_is_elevated(void) {
    HANDLE token = NULL;
    TOKEN_ELEVATION elevation;
    DWORD size = 0;
    int elevated = 0;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        if (GetTokenInformation(token, TokenElevation, &elevation,
                                sizeof(elevation), &size))
            elevated = elevation.TokenIsElevated != 0;
        CloseHandle(token);
    }
    return elevated;
}

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
            ok = grant_temporary(sandbox, path, FILE_TRAVERSE | SYNCHRONIZE,
                                 NO_INHERITANCE, 0);
            break;
        }
        *slash = L'\0';
        if (!path[0] || !grant_temporary(sandbox, path,
                                         FILE_TRAVERSE | SYNCHRONIZE,
                                         NO_INHERITANCE, 0)) {
            ok = 0;
            break;
        }
    }
    free(path);
    return ok;
}

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
                             NO_INHERITANCE, 1)) {
            free(path);
            set_reason(reason, reason_size, "writeRoot mount-point ACL grant failed");
            return 0;
        }
        if (!grant_temporary(sandbox, path,
                             FILE_GENERIC_READ | FILE_GENERIC_WRITE |
                                 FILE_GENERIC_EXECUTE | DELETE,
                             SUB_CONTAINERS_AND_OBJECTS_INHERIT, 0)) {
            free(path);
            set_reason(reason, reason_size, "writeRoot ACL grant failed");
            return 0;
        }
        free(path);
    }
    /* The ACL unit-test target exercises write-root grant/cleanup without
     * editing its elevated runner's system-wide ancestor ACLs. Production is
     * compiled without this definition and always grants required traversal. */
#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
    if (process_is_elevated()) {
        for (i = 0; i < options->write_root_count; ++i) {
            if (!grant_ancestor_traverse(sandbox, options->write_roots[i])) {
                set_reason(reason, reason_size,
                           "writeRoot ancestor traverse grant failed");
                return 0;
            }
        }
    }
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

const char *owc_sandbox_status_name(owc_sandbox_status status) {
    if (status == OWC_SANDBOX_ENFORCED) return "enforced";
    if (status == OWC_SANDBOX_PARTIAL) return "partial";
    return "advisory";
}

owc_sandbox_status owc_sandbox_probe(char *reason, size_t reason_size) {
    PSID sid = NULL;
    HRESULT hr = DeriveAppContainerSidFromAppContainerName(L"OpenWebCode.Probe", &sid);
    if (SUCCEEDED(hr)) {
        FreeSid(sid);
        set_reason(reason, reason_size, "AppContainer APIs are available; per-process enforcement has not yet been verified");
        return OWC_SANDBOX_PARTIAL;
    }
    if (hr == HRESULT_FROM_WIN32(ERROR_CALL_NOT_IMPLEMENTED) ||
        hr == HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND)) {
        set_reason(reason, reason_size, "AppContainer APIs are not supported by this Windows version");
        return OWC_SANDBOX_ADVISORY;
    }
    set_reason(reason, reason_size, "AppContainer SID derivation failed; sandbox is advisory");
    return OWC_SANDBOX_PARTIAL;
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
    sandbox->profile_name = make_profile_name(options->session_id);
    if (!sandbox->profile_name) goto fail;

    hr = CreateAppContainerProfile(sandbox->profile_name, sandbox->profile_name,
                                   L"OpenWebCode command session", NULL, 0,
                                   &sandbox->appcontainer_sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(sandbox->profile_name,
                                                        &sandbox->appcontainer_sid);
        if (FAILED(hr)) {
            set_reason(reason, reason_size, "existing AppContainer SID derivation failed");
            goto fail;
        }
    } else if (FAILED(hr)) {
        set_reason(reason, reason_size, "AppContainer profile creation failed; sandbox is partial");
        goto fail;
    } else {
        sandbox->profile_created = 1;
    }

    if (options->allow_network) {
        if (!ConvertStringSidToSidW(L"S-1-15-3-1", &sandbox->capability_sid)) {
            set_reason(reason, reason_size, "internetClient capability SID creation failed");
            goto fail;
        }
        sandbox->capability.Sid = sandbox->capability_sid;
        sandbox->capability.Attributes = SE_GROUP_ENABLED;
        sandbox->security_capabilities.Capabilities = &sandbox->capability;
        sandbox->security_capabilities.CapabilityCount = 1;
    }
    sandbox->security_capabilities.AppContainerSid = sandbox->appcontainer_sid;
    sandbox->security_capabilities.Reserved = 0;

    if (!grant_write_roots(sandbox, options, reason, reason_size)) goto fail;
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
    if (!sandbox) return;
    revoke_write_roots(sandbox);
    if (sandbox->capability_sid) LocalFree(sandbox->capability_sid);
    if (sandbox->appcontainer_sid) FreeSid(sandbox->appcontainer_sid);
    if (sandbox->profile_created && sandbox->profile_name)
        (void)DeleteAppContainerProfile(sandbox->profile_name);
    free(sandbox->profile_name);
    free(sandbox);
}
