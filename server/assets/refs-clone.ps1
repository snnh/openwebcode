# OpenWebCode ReFS 块克隆：create/restore/delete 工作区快照目录。
# create/restore 逐文件尝试 FSCTL_DUPLICATE_EXTENTS（ReFS 块克隆，即时 CoW），
# 对齐或不支持时回落 CopyFile。exit code 0 成功，非 0 失败并把错误写 stderr。
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("create", "restore", "delete")]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [Parameter(Mandatory = $true)]
    [string]$SnapDir
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RefsBlockClone
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFile(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle hDevice, uint dwIoControlCode,
        IntPtr lpInBuffer, uint nInBufferSize,
        IntPtr lpOutBuffer, uint nOutBufferSize,
        out uint lpBytesReturned, IntPtr lpOverlapped);

    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint OPEN_EXISTING = 3;
    private const uint CREATE_NEW = 1;
    private const uint FSCTL_DUPLICATE_EXTENTS = 0x00098344;

    // 目标先 SetLength 到源大小（等价于文件尾 SetEndOfFile），再整块克隆；失败抛异常由调用方回落 CopyFile
    public static void CloneFile(string source, string dest)
    {
        using (SafeFileHandle src = CreateFile(source, GENERIC_READ, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero))
        {
            if (src.IsInvalid) ThrowLastError("open source");
            using (SafeFileHandle dst = CreateFile(dest, GENERIC_WRITE, 0, IntPtr.Zero, CREATE_NEW, 0, IntPtr.Zero))
            {
                if (dst.IsInvalid) ThrowLastError("open dest");
                long length = new FileInfo(source).Length;
                if (length == 0) return;
                using (FileStream stream = new FileStream(dst, FileAccess.Write))
                {
                    stream.SetLength(length);
                }
                IntPtr buffer = Marshal.AllocHGlobal(IntPtr.Size);
                try
                {
                    Marshal.WriteIntPtr(buffer, src.DangerousGetHandle());
                    uint returned;
                    if (!DeviceIoControl(dst, FSCTL_DUPLICATE_EXTENTS, buffer, (uint)IntPtr.Size, IntPtr.Zero, 0, out returned, IntPtr.Zero))
                        ThrowLastError("DeviceIoControl");
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
        }
    }

    private static void ThrowLastError(string operation)
    {
        throw new IOException(operation + " failed: 0x" + Marshal.GetLastWin32Error().ToString("X8"));
    }
}
"@

function Clone-Tree {
    param([string]$Source, [string]$Dest)
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    $prefixLength = $Source.TrimEnd('\').Length
    foreach ($item in Get-ChildItem -LiteralPath $Source -Recurse -Force) {
        # 跳过 reparse point（联接/符号链接），避免越卷或递归
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        $relative = $item.FullName.Substring($prefixLength).TrimStart('\')
        $target = Join-Path $Dest $relative
        if ($item.PSIsContainer) {
            New-Item -ItemType Directory -Force -Path $target | Out-Null
            continue
        }
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        $cloned = $true
        try { [RefsBlockClone]::CloneFile($item.FullName, $target) }
        catch { $cloned = $false }
        if (-not $cloned) { Copy-Item -LiteralPath $item.FullName -Destination $target -Force }
        # 复制基本时间戳
        $copied = Get-Item -LiteralPath $target -Force
        $copied.CreationTime = $item.CreationTime
        $copied.LastWriteTime = $item.LastWriteTime
    }
}

try {
    switch ($Mode) {
        "create" {
            if (Test-Path -LiteralPath $SnapDir) { throw "SnapDir already exists: $SnapDir" }
            Clone-Tree -Source $Workspace -Dest $SnapDir
        }
        "restore" {
            if (-not (Test-Path -LiteralPath $SnapDir)) { throw "SnapDir not found: $SnapDir" }
            Get-ChildItem -LiteralPath $Workspace -Force | Remove-Item -Recurse -Force
            Clone-Tree -Source $SnapDir -Dest $Workspace
        }
        "delete" {
            if (Test-Path -LiteralPath $SnapDir) { Remove-Item -LiteralPath $SnapDir -Recurse -Force }
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
exit 0
