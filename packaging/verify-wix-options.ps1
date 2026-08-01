<#
  Read-only release gate for the optional Windows shell-integration controls.
  It queries the generated MSI database rather than relying on a screenshot,
  so a CPack/WiX template change cannot silently drop the checkboxes or turn
  them back into unconditional side effects.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$MsiPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $MsiPath -PathType Leaf)) {
    throw "MSI not found: $MsiPath"
}

$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
try {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($resolvedMsi, 0)
} catch {
    throw "Could not open the MSI database: $($_.Exception.Message)"
}

function Test-MsiRow {
    param([Parameter(Mandatory = $true)][string]$Query)

    $view = $database.OpenView($Query)
    try {
        [void]$view.Execute()
        $record = $view.Fetch()
        return ($null -ne $record)
    } finally {
        if ($null -ne $view) {
            [void]$view.Close()
        }
    }
}

function Assert-MsiRow {
    param(
        [Parameter(Mandatory = $true)][string]$Query,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-MsiRow $Query)) {
        throw "MSI validation failed: $Description"
    }
}

function Assert-NoMsiRow {
    param(
        [Parameter(Mandatory = $true)][string]$Query,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (Test-MsiRow $Query) {
        throw "MSI validation failed: $Description"
    }
}

function Get-MsiFirstString {
    param([Parameter(Mandatory = $true)][string]$Query)

    $view = $database.OpenView($Query)
    try {
        [void]$view.Execute()
        $record = $view.Fetch()
        if ($null -eq $record) {
            return $null
        }
        return $record.StringData(1)
    } finally {
        if ($null -ne $view) {
            [void]$view.Close()
        }
    }
}

Assert-MsiRow 'SELECT `Dialog` FROM `Dialog` WHERE `Dialog` = ''OpenWebCodeOptionsDlg''' `
    "the Shell integration dialog is present"
Assert-MsiRow 'SELECT `Control` FROM `Control` WHERE `Dialog_` = ''OpenWebCodeOptionsDlg'' AND `Control` = ''CreateDesktopShortcut'' AND `Type` = ''CheckBox'' AND `Property` = ''OWC_CREATE_DESKTOP_SHORTCUT''' `
    "the desktop-shortcut checkbox is present"
Assert-MsiRow 'SELECT `Control` FROM `Control` WHERE `Dialog_` = ''OpenWebCodeOptionsDlg'' AND `Control` = ''AddToPath'' AND `Type` = ''CheckBox'' AND `Property` = ''OWC_ADD_TO_PATH''' `
    "the PATH checkbox is present"
Assert-MsiRow 'SELECT `Dialog_` FROM `ControlEvent` WHERE `Dialog_` = ''OpenWebCodeOptionsDlg'' AND `Control_` = ''Next'' AND `Event` = ''[OWC_CREATE_DESKTOP_SHORTCUT]'' AND `Argument` = ''0''' `
    "an unchecked desktop checkbox is persisted as 0"
Assert-MsiRow 'SELECT `Dialog_` FROM `ControlEvent` WHERE `Dialog_` = ''OpenWebCodeOptionsDlg'' AND `Control_` = ''Next'' AND `Event` = ''[OWC_ADD_TO_PATH]'' AND `Argument` = ''0''' `
    "an unchecked PATH checkbox is persisted as 0"
Assert-MsiRow 'SELECT `Dialog_` FROM `ControlEvent` WHERE `Dialog_` = ''InstallDirDlg'' AND `Control_` = ''Next'' AND `Event` = ''NewDialog'' AND `Argument` = ''OpenWebCodeOptionsDlg''' `
    "the install-directory page opens Shell integration"
Assert-MsiRow 'SELECT `Dialog_` FROM `ControlEvent` WHERE `Dialog_` = ''VerifyReadyDlg'' AND `Control_` = ''Back'' AND `Event` = ''NewDialog'' AND `Argument` = ''OpenWebCodeOptionsDlg''' `
    "the ready page returns to Shell integration"

Assert-MsiRow 'SELECT `Component` FROM `Component` WHERE `Component` = ''OpenWebCodeDesktopShortcut'' AND `Condition` = ''OWC_CREATE_DESKTOP_SHORTCUT = "1"''' `
    "the desktop shortcut is conditionally installed"
Assert-MsiRow 'SELECT `Shortcut` FROM `Shortcut` WHERE `Shortcut` = ''OpenWebCodeDesktopShortcutLink'' AND `Component_` = ''OpenWebCodeDesktopShortcut''' `
    "the desktop shortcut belongs only to its optional component"
Assert-MsiRow 'SELECT `Component` FROM `Component` WHERE `Component` = ''OpenWebCodeUserPath'' AND `Condition` = ''OWC_ADD_TO_PATH = "1"''' `
    "the PATH entry is conditionally installed"
Assert-MsiRow 'SELECT `Environment` FROM `Environment` WHERE `Environment` = ''OpenWebCodeBinPath'' AND `Component_` = ''OpenWebCodeUserPath''' `
    "the PATH entry belongs only to its optional component"
Assert-NoMsiRow 'SELECT `Component` FROM `Component` WHERE `Component` = ''CM_SHORTCUT_DESKTOP''' `
    "the old unconditional CPack desktop shortcut component is absent"
Assert-NoMsiRow 'SELECT `Environment` FROM `Environment` WHERE `Environment` = ''OpenWebCodeBinPath'' AND `Component_` = ''CM_CP_bin.owc.cmd''' `
    "the launcher component does not unconditionally change PATH"
Assert-MsiRow 'SELECT `Component` FROM `Component` WHERE `Component` = ''OpenWebCodeShellIntegrationState''' `
    "the selection-state component is present"
Assert-MsiRow 'SELECT `Registry` FROM `Registry` WHERE `Component_` = ''OpenWebCodeShellIntegrationState'' AND `Name` = ''CreateDesktopShortcut'' AND `Value` = ''[OWC_CREATE_DESKTOP_SHORTCUT]''' `
    "the desktop selection is retained for future upgrades"
Assert-MsiRow 'SELECT `Registry` FROM `Registry` WHERE `Component_` = ''OpenWebCodeShellIntegrationState'' AND `Name` = ''AddToPath'' AND `Value` = ''[OWC_ADD_TO_PATH]''' `
    "the PATH selection is retained for future upgrades"

Assert-MsiRow 'SELECT `Property` FROM `Property` WHERE `Property` = ''OWC_CREATE_DESKTOP_SHORTCUT'' AND `Value` = ''1''' `
    "the desktop shortcut defaults to selected"
Assert-MsiRow 'SELECT `Property` FROM `Property` WHERE `Property` = ''OWC_ADD_TO_PATH'' AND `Value` = ''1''' `
    "the PATH option defaults to selected"

$secureProperties = Get-MsiFirstString 'SELECT `Value` FROM `Property` WHERE `Property` = ''SecureCustomProperties'''
if ($null -eq $secureProperties) {
    throw "MSI validation failed: SecureCustomProperties is missing"
}
$securePropertySet = $secureProperties -split ";"
foreach ($property in "OWC_CREATE_DESKTOP_SHORTCUT", "OWC_ADD_TO_PATH") {
    if ($securePropertySet -notcontains $property) {
        throw "MSI validation failed: $property is not secure across elevation"
    }
}

Assert-MsiRow 'SELECT `Property` FROM `Property` WHERE `Property` = ''WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT''' `
    "the exit-dialog launch checkbox has a label"
Assert-MsiRow 'SELECT `Property` FROM `Property` WHERE `Property` = ''WIXUI_EXITDIALOGOPTIONALCHECKBOX'' AND `Value` = ''1''' `
    "the exit-dialog launch checkbox defaults to selected"
$shellExecTarget = Get-MsiFirstString 'SELECT `Value` FROM `Property` WHERE `Property` = ''WixShellExecTarget'''
if ($null -eq $shellExecTarget -or -not $shellExecTarget.EndsWith('bin\owc-launch.cmd')) {
    throw "MSI validation failed: WixShellExecTarget does not point at bin\owc-launch.cmd (got: $shellExecTarget)"
}
Assert-MsiRow 'SELECT `Action` FROM `CustomAction` WHERE `Action` = ''LaunchOpenWebCode'' AND `Source` = ''WixCA'' AND `Target` = ''WixShellExec''' `
    "the launch custom action invokes WixShellExec"
Assert-MsiRow 'SELECT `Dialog_` FROM `ControlEvent` WHERE `Dialog_` = ''ExitDialog'' AND `Control_` = ''Finish'' AND `Event` = ''DoAction'' AND `Argument` = ''LaunchOpenWebCode''' `
    "the finish button can launch the application"
# MSI SQL 不支持 LIKE 通配查询，条件文本在 PowerShell 侧匹配。
$launchCondition = Get-MsiFirstString 'SELECT `Condition` FROM `ControlEvent` WHERE `Dialog_` = ''ExitDialog'' AND `Control_` = ''Finish'' AND `Event` = ''DoAction'' AND `Argument` = ''LaunchOpenWebCode'''
if ($null -eq $launchCondition -or $launchCondition -notlike '*WIXUI_EXITDIALOGOPTIONALCHECKBOX*') {
    throw "MSI validation failed: the launch action is not gated by the exit-dialog checkbox (got: $launchCondition)"
}

Write-Output "Verified MSI Shell integration controls: $resolvedMsi"
