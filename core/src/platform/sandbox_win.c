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

static DWORD change_root_access(const wchar_t *path, PSID sid, ACCESS_MODE mode,
                                DWORD permissions, DWORD inheritance) {
    PACL old_acl = NULL, new_acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    EXPLICIT_ACCESSW access;
    DWORD error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                        DACL_SECURITY_INFORMATION, NULL, NULL,
                                        &old_acl, NULL, &descriptor);
    if (error != ERROR_SUCCESS) return error;
    memset(&access, 0, sizeof(access));
    access.grfAccessPermissions = permissions;
    access.grfAccessMode = mode;
    access.grfInheritance = inheritance;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    access.Trustee.ptstrName = (LPWSTR)sid;
    error = SetEntriesInAclW(1, &access, old_acl, &new_acl);
    if (error == ERROR_SUCCESS)
        error = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                      DACL_SECURITY_INFORMATION,
                                      NULL, NULL, new_acl, NULL);
    if (new_acl) LocalFree(new_acl);
    if (descriptor) LocalFree(descriptor);
    return error;
}

static int remember_grant(owc_sandbox *sandbox, wchar_t *path) {
    struct owc_acl_grant *grown = (struct owc_acl_grant *)realloc(
        sandbox->grants, (sandbox->grant_count + 1) * sizeof(*grown));
    if (!grown) return 0;
    sandbox->grants = grown;
    sandbox->grants[sandbox->grant_count++].path = path;
    return 1;
}

static int grant_one(owc_sandbox *sandbox, const wchar_t *path,
                     DWORD permissions, DWORD inheritance) {
    size_t length = wcslen(path) + 1;
    wchar_t *copy = (wchar_t *)malloc(length * sizeof(*copy));
    if (!copy) return 0;
    (void)memcpy(copy, path, length * sizeof(*copy));
    if (change_root_access(copy, sandbox->appcontainer_sid, GRANT_ACCESS,
                           permissions, inheritance) != ERROR_SUCCESS ||
        !remember_grant(sandbox, copy)) {
        (void)change_root_access(copy, sandbox->appcontainer_sid, REVOKE_ACCESS,
                                 0, NO_INHERITANCE);
        free(copy);
        return 0;
    }
    return 1;
}

static int grant_write_roots(owc_sandbox *sandbox,
                             const owc_sandbox_options *options,
                             char *reason, size_t reason_size) {
    size_t i;
    for (i = 0; i < options->write_root_count; ++i) {
        wchar_t *path = utf8_to_wide(options->write_roots[i]);
        if (!path) {
            set_reason(reason, reason_size, "writeRoot is not valid UTF-8");
            return 0;
        }
        if (!grant_one(sandbox, path,
                       FILE_GENERIC_READ | FILE_GENERIC_WRITE |
                           FILE_GENERIC_EXECUTE | DELETE,
                       SUB_CONTAINERS_AND_OBJECTS_INHERIT)) {
            free(path);
            set_reason(reason, reason_size, "writeRoot ACL grant failed");
            return 0;
        }
        free(path);
    }
    return 1;
}

static void revoke_write_roots(owc_sandbox *sandbox) {
    size_t i;
    for (i = 0; i < sandbox->grant_count; ++i) {
        (void)change_root_access(sandbox->grants[i].path,
                                 sandbox->appcontainer_sid, REVOKE_ACCESS,
                                 0, NO_INHERITANCE);
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
