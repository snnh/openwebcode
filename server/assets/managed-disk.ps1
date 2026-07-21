# OpenWebCode 托管工作区 VHDX 操作：基盘创建/差分盘/换叶/卸载/合并/重挂父盘。
# 所有路径经离散参数传入（execFile 不经 shell，无需引号转义）。
# exit code 0 成功，非 0 失败并把错误写 stderr。dismount 为清理路径，幂等不报错。
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("new-base", "new-diff", "swap", "dismount", "merge", "reparent")]
    [string]$Mode,
    [string]$Image,
    [string]$MountPoint,
    [long]$SizeBytes = 21474836480,
    [string]$Parent,
    [string]$Child,
    [string]$OldImage,
    [string]$NewImage,
    [string]$Path,
    [string]$ParentPath
)

# Windows PowerShell 5.1 默认以本地 OEM/ANSI 代码页写控制台错误；Node 按 UTF-8
# 捕获 stderr 时会把中文错误解码成乱码。显式写 UTF-8 字节，确保上层能原样显示。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Write-Utf8Stderr([string]$Message) {
    $bytes = $utf8NoBom.GetBytes("$Message`r`n")
    $stderr = [Console]::OpenStandardError()
    $stderr.Write($bytes, 0, $bytes.Length)
    $stderr.Flush()
}

$ErrorActionPreference = "Stop"

try {
    switch ($Mode) {
        "new-base" {
            # 20GB 动态稀疏盘 → 挂载 → GPT 初始化 → 单分区 → 挂载到目录 → NTFS 快速格式化
            New-Item -ItemType Directory -Force -Path $MountPoint | Out-Null
            New-VHD -Path $Image -SizeBytes $SizeBytes -Dynamic | Out-Null
            $disk = Mount-VHD -Path $Image -PassThru | Initialize-Disk -PartitionStyle GPT -PassThru
            $partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize
            Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath $MountPoint
            Format-Volume -Partition $partition -FileSystem NTFS -Confirm:$false | Out-Null
        }
        "new-diff" {
            New-VHD -Path $Child -ParentPath $Parent -Differencing | Out-Null
        }
        "swap" {
            # 换叶：卸旧叶子挂新叶子；差分链上卷身份一致，Mount Manager 通常会还原访问路径，这里幂等补齐
            Dismount-VHD -Path $OldImage
            $disk = Mount-VHD -Path $NewImage -PassThru | Get-Disk
            $partition = Get-Partition -DiskNumber $disk.Number | Where-Object { $_.Type -ne "Reserved" } | Select-Object -First 1
            if ($partition -and -not ($partition.AccessPaths | Where-Object { $_ -eq $MountPoint })) {
                Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath $MountPoint
            }
        }
        "dismount" {
            # 清理路径幂等：镜像缺失或本已卸载都不视为失败
            if ((Test-Path -LiteralPath $Image) -and (Get-VHD -Path $Image).Attached) {
                Dismount-VHD -Path $Image
            }
        }
        "merge" {
            # 并入其 parent（差分盘内容写回父盘，源盘由 Merge-VHD 删除）
            Merge-VHD -Path $Path -Force
        }
        "reparent" {
            Set-VHD -Path $Path -ParentPath $ParentPath -IgnoreIdentifierMismatch
        }
    }
} catch {
    Write-Utf8Stderr $_.Exception.Message
    exit 1
}
exit 0
