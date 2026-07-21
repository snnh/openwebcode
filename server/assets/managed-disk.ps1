# OpenWebCode 托管工作区 VHDX 操作：基盘创建/差分盘/换叶/卸载/合并/重挂父盘。
# 所有路径经离散参数传入（execFile 不经 shell，无需引号转义）。
# exit code 0 成功，非 0 失败并把错误写 stderr。dismount 为清理路径，幂等不报错。
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("new-base", "new-diff", "fork-swap", "rollback-fork-swap", "swap", "dismount", "merge", "reparent")]
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

function Mount-ManagedVhd([string]$ImagePath, [string]$AccessPath) {
    $disk = Mount-VHD -Path $ImagePath -PassThru | Get-Disk
    $partition = Get-Partition -DiskNumber $disk.Number | Where-Object { $_.Type -ne "Reserved" } | Select-Object -First 1
    if (-not $partition) {
        throw "虚拟硬盘没有可挂载的分区：$ImagePath"
    }
    if (-not ($partition.AccessPaths | Where-Object { $_ -eq $AccessPath })) {
        Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath $AccessPath
    }
}

function Dismount-IfAttached([string]$ImagePath) {
    if ((Test-Path -LiteralPath $ImagePath) -and (Get-VHD -Path $ImagePath).Attached) {
        Dismount-VHD -Path $ImagePath
    }
}

function Dismount-AtMountPoint([string]$AccessPath) {
    if (-not $AccessPath) { return }
    # chain.json 损坏或仍指向旧 base 时，不能只相信镜像路径。挂载目录由本服务
    # 推导且受控，按该 AccessPath 找回实际挂载 VHD 后再卸载，仍不使用 -Force。
    $partition = Get-Partition | Where-Object { $_.AccessPaths | Where-Object { $_ -eq $AccessPath } } | Select-Object -First 1
    if (-not $partition) { return }
    $vhd = Get-VHD -DiskNumber $partition.DiskNumber -ErrorAction Stop
    if ($vhd.Attached) { Dismount-VHD -Path $vhd.Path }
}

function Remove-FailedChild([string]$ImagePath) {
    if (-not (Test-Path -LiteralPath $ImagePath)) { return }
    try {
        $vhd = Get-VHD -Path $ImagePath -ErrorAction Stop
        if ($vhd.Attached) { Dismount-VHD -Path $ImagePath -ErrorAction Stop }
    } catch {
        # 无效/未完成的 child 也应尝试删除；Remove-Item 会给出最终失败原因。
    }
    Remove-Item -LiteralPath $ImagePath -Force -ErrorAction Stop
}

function New-DifferencingVhd([string]$ParentPath, [string]$ChildPath) {
    # Dismount-VHD 返回后 Hyper-V 服务偶尔仍在释放共享句柄。仅重试明确的
    # sharing violation，绝不把无效 parent、权限等永久错误伪装成短暂错误。
    $delays = @(0, 100, 250, 500, 1000, 1500, 2000)
    for ($attempt = 0; $attempt -lt $delays.Count; $attempt += 1) {
        if ($delays[$attempt] -gt 0) { Start-Sleep -Milliseconds $delays[$attempt] }
        try {
            New-VHD -Path $ChildPath -ParentPath $ParentPath -Differencing | Out-Null
            return
        } catch {
            $failure = $_
            $sharingViolation = $failure.Exception.Message -match "0x80070020|being used by another process|另一个进程"
            if (-not $sharingViolation -or $attempt -eq ($delays.Count - 1)) { throw }
            # child 名由服务端随机生成；失败后它不在 chain.json 中，可安全清理后重试。
            try { Remove-FailedChild -ImagePath $ChildPath } catch { throw $failure }
        }
    }
}

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
            New-DifferencingVhd -ParentPath $Parent -ChildPath $Child
        }
        "fork-swap" {
            # New-VHD 需要读取 parent 的链元数据；当前可写叶子仍挂载时会触发
            # 0x80070020。整个换叶必须在同一 PowerShell 事务中完成，防止 Node
            # 在两个离散命令间留下未挂载或半完成的工作区。
            $oldDetached = $false
            $childCreated = $false
            $oldLeaf = if ($OldImage) { $OldImage } else { $Parent }
            try {
                Dismount-VHD -Path $oldLeaf
                $oldDetached = $true
                New-DifferencingVhd -ParentPath $Parent -ChildPath $Child
                $childCreated = $true
                Mount-ManagedVhd -ImagePath $Child -AccessPath $MountPoint
            } catch {
                $failure = $_
                $recoveryFailures = @()
                if ($childCreated -or (Test-Path -LiteralPath $Child)) {
                    try { Remove-FailedChild -ImagePath $Child } catch { $recoveryFailures += $_.Exception.Message }
                }
                if ($oldDetached) {
                    try { Mount-ManagedVhd -ImagePath $oldLeaf -AccessPath $MountPoint } catch { $recoveryFailures += $_.Exception.Message }
                }
                if ($recoveryFailures.Count -gt 0) {
                    throw "$($failure.Exception.Message)；尝试恢复原工作区失败：$($recoveryFailures -join '；')"
                }
                throw $failure
            }
        }
        "rollback-fork-swap" {
            # Node 未能持久化 chain.json 时，当前 child 尚未承载任何工作区写入。
            # 回到旧叶并删除 child，确保磁盘状态与旧 chain.json 一致；不使用 -Force。
            $recoveryFailures = @()
            try { Dismount-IfAttached -ImagePath $NewImage } catch { $recoveryFailures += $_.Exception.Message }
            try { Remove-FailedChild -ImagePath $NewImage } catch { $recoveryFailures += $_.Exception.Message }
            try { Mount-ManagedVhd -ImagePath $OldImage -AccessPath $MountPoint } catch { $recoveryFailures += $_.Exception.Message }
            if ($recoveryFailures.Count -gt 0) {
                throw "回滚换叶失败：$($recoveryFailures -join '；')"
            }
        }
        "swap" {
            # 换叶：卸旧叶子挂新叶子；差分链上卷身份一致，Mount Manager 通常会还原访问路径，这里幂等补齐
            Dismount-VHD -Path $OldImage
            Mount-ManagedVhd -ImagePath $NewImage -AccessPath $MountPoint
        }
        "dismount" {
            # 清理路径幂等：镜像缺失或本已卸载都不视为失败
            Dismount-IfAttached -ImagePath $Image
            # 正常时上面已按 active leaf 卸载；这里是状态损坏时的受控兜底。
            Dismount-AtMountPoint -AccessPath $MountPoint
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
