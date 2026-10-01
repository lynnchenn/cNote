<#
  构建 MSVC 版本：生成一个无需解压任何文件的单一可执行程序。

      .\tools\build-msvc.ps1
      .\tools\build-msvc.ps1 -Debug

  为什么还要一个构建脚本：官方的 WebView2LoaderStatic.lib 是 MSVC 目标代码。
  要把它链接进 g++ 构建，就必须手工重新实现 MSVC 的 /GS cookie 以及
  _Init_thread_* 魔法静态运行时，所以 g++ 构建仍然加载加载器 DLL（它被装在可执行
  文件内部）。使用 MSVC 工具链时加载器可以直接链接进来，CRT 是静态的（/MT），
  发布的应用除自身的配置和 WebView2 配置目录外不会向磁盘写入任何东西。

  这里的 Visual Studio 安装没有注册 Windows SDK，因此所有包含路径和库路径都是显式
  传入的，而不是通过 vcvars64.bat。

  工具链也可以放在本检出目录旁边而不是 Visual Studio 安装目录中："..\vs"
  （从 Visual Studio 布局中解包出来的 VC 工具）和 "..\sdk"（Windows SDK，
  按 Kits 文件夹的结构摆放）。只要存在就优先使用它，这样整个构建都留在一个文件夹里。
#>

param([switch]$Debug)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'src'
$build = Join-Path $root 'build-msvc'
$obj = Join-Path $build 'obj'

$vcRoot = 'E:\vs\VC\Tools\MSVC'
$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10'

$localRoot = Split-Path $root -Parent

function Use-FirstExisting([string[]] $candidates) {
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

# 上级目录中的便携工具链优先于已安装的工具链，
# 这样没有装 Visual Studio 的机器也能直接从本检出目录构建。
$vcRoot = Use-FirstExisting @(
    (Join-Path $localRoot 'vs\VC\Tools\MSVC'),
    $vcRoot,
    (Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC'),
    (Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio\2022\Community\VC\Tools\MSVC')
)
if (-not $vcRoot) { throw 'MSVC toolset not found: looked for ..\vs\VC\Tools\MSVC and E:\vs\VC\Tools\MSVC' }

$sdkRoot = Use-FirstExisting @(
    (Join-Path $localRoot 'sdk'),
    $sdkRoot
)
if (-not $sdkRoot) { throw 'Windows SDK not found: looked for ..\sdk and the Windows Kits folder' }

$vc = (Get-ChildItem $vcRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
$sdkVersion = (Get-ChildItem (Join-Path $sdkRoot 'Include') -Directory |
    Sort-Object Name -Descending | Select-Object -First 1).Name

$cl = Join-Path $vc 'bin\Hostx64\x64\cl.exe'
$link = Join-Path $vc 'bin\Hostx64\x64\link.exe'
$rc = Join-Path $sdkRoot "bin\$sdkVersion\x64\rc.exe"
foreach ($tool in $cl, $link, $rc) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "toolchain missing: $tool" }
}

$webviewPackages = Use-FirstExisting @(
    (Join-Path $localRoot '.nuget\microsoft.web.webview2'),
    (Join-Path $env:USERPROFILE '.nuget\packages\microsoft.web.webview2')
)
if (-not $webviewPackages) { throw 'WebView2 SDK not found (..\.nuget\microsoft.web.webview2)' }

$webview = Get-ChildItem $webviewPackages -Directory |
    Sort-Object Name -Descending | Select-Object -First 1 |
    ForEach-Object { Join-Path $_.FullName 'build\native' }
$webviewInclude = Join-Path $webview 'include'
$webviewLib = Join-Path $webview 'x64\WebView2LoaderStatic.lib'
if (-not (Test-Path -LiteralPath $webviewLib)) { throw "static loader missing: $webviewLib" }

if (Test-Path -LiteralPath $build) {
    Remove-Item -LiteralPath $build -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $build, $obj | Out-Null

& (Join-Path $root 'tools\gen-assets.ps1') | Out-Null

$includes = @(
    (Join-Path $vc 'include'),
    (Join-Path $sdkRoot "Include\$sdkVersion\ucrt"),
    (Join-Path $sdkRoot "Include\$sdkVersion\shared"),
    (Join-Path $sdkRoot "Include\$sdkVersion\um"),
    (Join-Path $sdkRoot "Include\$sdkVersion\winrt"),
    $webviewInclude,
    $src
)
# 每个路径一个词元，不要手工加引号：PowerShell 7 会转义参数内部出现的引号，
# 因此 "/I`"$path`"" 传到编译器时变成 `/I"$path"`（引号成了内容的一部分），
# 所有头文件查找都会失败。让 PowerShell 在路径需要时自行加上引号，
# 在 5.1 和 7 上都能正常工作。
$includeFlags = $includes | ForEach-Object { "/I$_" }

# /utf-8 很关键：源码中含有中文字符串字面量，而默认值是机器的 ANSI 代码页，
# 那不是 JSON 桥接或 WebView2 编码所期望的。
#
# /GR- 是实测的，不是想当然：这里没有任何代码使用 RTTI，去掉它大约能省下
# 3 KB 的可执行文件体积。
$commonFlags = @('/nologo', '/c', '/std:c++17', '/EHs-c-', '/utf-8', '/MT',
    '/DUNICODE', '/D_UNICODE',
    '/DNOMINMAX', '/W3', '/GR-', '/D_HAS_EXCEPTIONS=0') + $includeFlags
if ($Debug) {
    $sizeFlags = @('/Od', '/Zi', '/DEBUG')
    $speedFlags = $sizeFlags
} else {
    $sizeFlags = @('/O1', '/GL')    # 代码体积最小
    $speedFlags = @('/O2', '/GL')   # 代码速度最快
}

# 实测：全部启用 /O1 大约小 22 KB，但保存 2 MB 文档时慢约 8 ms。桥接在每次保存和
# 每次打开时都会把整篇文档送过 json.cpp 和 util.cpp，因此这两个文件保留速度优化，
# 构建的其余部分则用一点速度换取体积。
$hotFiles = @('json', 'util')

$objects = @()
foreach ($name in @('json', 'util', 'main', 'webview', 'commands')) {
    Write-Host "  cl $name.cpp" -ForegroundColor DarkGray
    $object = Join-Path $obj "$name.obj"
    $flags = if ($hotFiles -contains $name) { $commonFlags + $speedFlags }
             else { $commonFlags + $sizeFlags }
    & $cl @flags (Join-Path $src "$name.cpp") "/Fo$object"
    if ($LASTEXITCODE -ne 0) { throw "compile failed: $name.cpp" }
    $objects += $object
}

# 资源：图标、DPI 清单和版本信息。
# 使用正斜杠：反斜杠在资源脚本中是转义字符。
# 脚本以不带 BOM 的 UTF-8 编写，而图标/清单路径可能含非 ASCII 字符，因此下面显式
# 指定代码页 65001，而不是由机器的 ANSI 代码页推断——后者会把路径读成乱码，
# 导致资源编译器报告文件不存在。资源脚本本身不写注释：注释只留在源码里。
$icon = (Resolve-Path (Join-Path $root 'app.ico')).Path -replace '\\', '/'
$manifest = (Resolve-Path (Join-Path $src 'cNote.manifest')).Path -replace '\\', '/'
$resourceScript = Join-Path $build 'resources.rc'
$resourceText = @"
#pragma code_page(65001)
#include <windows.h>

1 ICON "$icon"
1 24 "$manifest"

VS_VERSION_INFO VERSIONINFO
 FILEVERSION 0,1,0,0
 PRODUCTVERSION 0,1,0,0
 FILEFLAGSMASK 0x3fL
 FILEFLAGS 0x0L
 FILEOS 0x40004L
 FILETYPE 0x1L
 FILESUBTYPE 0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "080404b0"
        BEGIN
            VALUE "CompanyName", "lynn\0"
            VALUE "FileDescription", "cNote Markdown editor\0"
            VALUE "FileVersion", "0.1.0.0\0"
            VALUE "InternalName", "cNote\0"
            VALUE "OriginalFilename", "cNote.exe\0"
            VALUE "ProductName", "cNote\0"
            VALUE "ProductVersion", "0.1.0.0\0"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x804, 1200
    END
END
"@
[System.IO.File]::WriteAllText($resourceScript, $resourceText, (New-Object System.Text.UTF8Encoding($false)))

$resourceObject = Join-Path $obj 'resources.res'
Write-Host "  rc resources.rc" -ForegroundColor DarkGray
& $rc /nologo "/i$(Join-Path $sdkRoot "Include\$sdkVersion\um")" `
    "/i$(Join-Path $sdkRoot "Include\$sdkVersion\shared")" `
    /fo $resourceObject $resourceScript
if ($LASTEXITCODE -ne 0) { throw 'resource compile failed' }
$objects += $resourceObject

$libPaths = @(
    (Join-Path $vc 'lib\x64'),
    (Join-Path $sdkRoot "Lib\$sdkVersion\ucrt\x64"),
    (Join-Path $sdkRoot "Lib\$sdkVersion\um\x64"),
    (Join-Path $webview 'x64')
)
$libFlags = $libPaths | ForEach-Object { "/LIBPATH:$_" }

$exe = Join-Path $build 'cNote.exe'
$libraries = @('WebView2LoaderStatic.lib', 'ole32.lib', 'oleaut32.lib', 'uuid.lib',
    'user32.lib', 'gdi32.lib', 'shell32.lib', 'shlwapi.lib', 'dwmapi.lib',
    'advapi32.lib', 'comctl32.lib', 'urlmon.lib', 'wininet.lib', 'windowsapp.lib',
    'cabinet.lib')

# 静态 CRT 通过 default-library 指令引用了 oldnames.lib，但该文件属于 Windows SDK
# 而不是编译器，NuGet 版的 SDK 布局里也没有副本。这里没有使用任何旧的 POSIX 名称，
# 因此找不到该文件时，去掉这个默认库即可。
$oldnames = Get-ChildItem (Join-Path $sdkRoot "Lib\$sdkVersion") -Recurse -Filter 'oldnames.lib' `
    -ErrorAction SilentlyContinue | Select-Object -First 1

$linkFlags = @('/nologo', '/SUBSYSTEM:WINDOWS', '/ENTRY:wWinMainCRTStartup',
    '/MANIFEST:NO', "/OUT:$exe") + $libFlags + $objects + $libraries
if (-not $oldnames) { $linkFlags += '/NODEFAULTLIB:OLDNAMES' }
if (-not $Debug) { $linkFlags += @('/LTCG', '/OPT:REF', '/OPT:ICF') }

Write-Host "  link cNote.exe" -ForegroundColor DarkGray
& $link @linkFlags
if ($LASTEXITCODE -ne 0) { throw 'link failed' }

$size = [math]::Round((Get-Item $exe).Length / 1KB, 1)
Write-Host ("built {0}  ({1} KB, nothing to unpack)" -f $exe, $size) -ForegroundColor Green
