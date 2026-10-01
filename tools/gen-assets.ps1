<#
  把 cNote 前端嵌入到一个生成的 C++ 头文件中。

  前端（HTML/CSS/JS）与语言无关，并与 C# 版本共用；本脚本把它烘焙进可执行文件，
  使发布的应用保持单文件。只要 assets/ 有改动，构建前就要运行它。

  数据在写入时做了 deflate 压缩：HTML、CSS 和 JavaScript 都会压到原大小的 28% 左右，
  而可执行文件的大部分体积正来自这里。解压使用操作系统自带的 Windows 压缩 API
  （COMPRESS_ALGORITHM_MSZIP 就是普通的 deflate），
  因此解压代码不会给可执行文件增加任何负担。

  生成的头部不含任何注释，嵌入的前端也由 minify.mjs 去掉注释：
  构建产物里不保留注释，注释只留在源码中。

  用法：.\gen-assets.ps1 [-Assets <目录>] [-Out <生成的 .h>]
#>

param(
  [string]$Assets = (Join-Path $PSScriptRoot '..\assets'),
    [string]$Out = (Join-Path $PSScriptRoot '..\src\assets.generated.h')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Assets)) { throw "Assets folder not found: $Assets" }

# 压缩 API 需要的是指向 COMPRESS_ALLOCATION_ROUTINES 的指针，
# 而不是那两个例程本身：在那里传 null 表示使用默认分配器。
if (-not ('MnDeflate' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MnDeflate {
  [DllImport("cabinet.dll", SetLastError = true)]
  static extern bool CreateCompressor(uint algorithm, IntPtr routines, out IntPtr compressor);
  [DllImport("cabinet.dll", SetLastError = true)]
  static extern bool Compress(IntPtr compressor, IntPtr input, UIntPtr inputSize,
      IntPtr output, UIntPtr outputSize, out UIntPtr written);
  [DllImport("cabinet.dll", SetLastError = true)]
  static extern bool CloseCompressor(IntPtr compressor);

  const uint COMPRESS_ALGORITHM_MSZIP = 2;

  public static byte[] Run(byte[] data) {
    IntPtr compressor;
    if (!CreateCompressor(COMPRESS_ALGORITHM_MSZIP, IntPtr.Zero, out compressor)) {
      throw new Exception("CreateCompressor failed, win32=" + Marshal.GetLastWin32Error());
    }
    // 该 API 的最坏情况略大于输入长度，
    // 多余的余量是给 MSZIP 每 32 KB 添加的流头留的。
    int capacity = data.Length + data.Length / 4 + 65536;
    IntPtr input = Marshal.AllocHGlobal(data.Length);
    IntPtr output = Marshal.AllocHGlobal(capacity);
    try {
      Marshal.Copy(data, 0, input, data.Length);
      UIntPtr written;
      if (!Compress(compressor, input, new UIntPtr((ulong)data.Length),
                    output, new UIntPtr((ulong)capacity), out written)) {
        throw new Exception("Compress failed, win32=" + Marshal.GetLastWin32Error());
      }
      byte[] result = new byte[(int)written.ToUInt64()];
      Marshal.Copy(output, result, 0, result.Length);
      return result;
    } finally {
      Marshal.FreeHGlobal(input);
      Marshal.FreeHGlobal(output);
      CloseCompressor(compressor);
    }
  }
}
"@
}

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('#pragma once')
$lines.Add('')
$lines.Add('struct EmbeddedAsset {')
$lines.Add('    const char* path;')
$lines.Add('    const char* mime;')
$lines.Add('    const unsigned char* packed;')
$lines.Add('    unsigned packedSize;')
$lines.Add('    unsigned size;')
$lines.Add('};')
$lines.Add('')

$entries = @()
$packedTotal = 0
$rawTotal = 0

# 压缩器负责去掉前端里的注释并压小体积：没有它时嵌入的是原始文本，
# 因此那种构建会带上源码中的注释。assets/ 中的源码无论如何都保持可读。
$minify = Join-Path $PSScriptRoot 'minify.mjs'

# 可以放在本检出目录旁边的便携版 Node（"..\node\node.exe"，位于项目文件夹上一级）
# 优先于 PATH 中的任何版本，这样嵌入前端的体积不受机器环境影响。
$nodePath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'node\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { $nodePath = $node.Source } else { $nodePath = $null }
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("cnote-assets-" + $PID)
if ($nodePath -and (Test-Path -LiteralPath $minify)) {
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
}

$files = Get-ChildItem -LiteralPath $Assets -File | Sort-Object Name
foreach ($file in $files) {
    $ext = $file.Extension.ToLowerInvariant()
    if (-not $mime.ContainsKey($ext)) { continue }

    $source = $file.FullName
    if (Test-Path -LiteralPath $staging) {
        $shrunk = Join-Path $staging $file.Name
        & $nodePath $minify $source $shrunk
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $shrunk)) { $source = $shrunk }
    }

    $bytes = [System.IO.File]::ReadAllBytes($source)
    $packed = [MnDeflate]::Run($bytes)
    $packedTotal += $packed.Length
    $rawTotal += $bytes.Length

    $symbol = 'kAsset_' + ($file.Name -replace '[^A-Za-z0-9]', '_')

    # 每个字节都写成 \xNN，因此转义序列不会延伸到下一个字节。
    # MSVC 对单个字符串字面量有 16 KB 的上限（C2026），所以数据会拆成多个相邻的
    # 字面量，由编译器原样拼接。
    $builder = New-Object System.Text.StringBuilder
    $lines.Add("static const unsigned char $symbol[] =")
    for ($at = 0; $at -lt $packed.Length; $at += 1024) {
        $size = [Math]::Min(1024, $packed.Length - $at)
        [void]$builder.Clear()
        [void]$builder.Append('"')
        for ($i = 0; $i -lt $size; $i++) {
            [void]$builder.AppendFormat('\x{0:x2}', $packed[$at + $i])
        }
        [void]$builder.Append('"')
        $lines.Add($builder.ToString())
    }
    if ($packed.Length -eq 0) { $lines.Add('""') }
    $lines[$lines.Count - 1] = $lines[$lines.Count - 1] + ';'
    $lines.Add('')

    $entries += ('    {{ "{0}", "{1}", {2}, {3}, {4} }},' -f $file.Name, $mime[$ext], $symbol, $packed.Length, $bytes.Length)
}

$lines.Add('static const EmbeddedAsset kAssets[] = {')
foreach ($e in $entries) { $lines.Add($e) }
$lines.Add('};')
$lines.Add('')
$lines.Add('static const unsigned kAssetCount = sizeof(kAssets) / sizeof(kAssets[0]);')
$lines.Add('')

[System.IO.File]::WriteAllLines($Out, $lines, (New-Object System.Text.UTF8Encoding($false)))
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
Write-Host ("embedded {0} assets: {1} -> {2} bytes ({3:P0}) -> {4}" -f `
    $entries.Count, $rawTotal, $packedTotal, ($packedTotal / $rawTotal), $Out)
