param([Parameter(Mandatory = $true)][string]$SpecPath)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

function Await-WinRT($Operation, [Type]$ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}

$spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
$file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($spec.image)) ([Windows.Storage.StorageFile])
$stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = $null
foreach ($tag in $spec.languages) {
    try {
        $language = New-Object Windows.Globalization.Language($tag)
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
        if ($null -ne $engine) { break }
    } catch { }
}
if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) {
    # Keep this script ASCII-only. Windows PowerShell 5.1 reads BOM-less scripts
    # using the active ANSI code page, which can turn UTF-8 source into invalid syntax.
    throw "Windows OCR is unavailable; install Simplified Chinese or English OCR language support in Windows Settings"
}

$result = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$matches = @()
foreach ($region in $spec.regions) {
    $tokens = New-Object System.Collections.Generic.List[string]
    $left = [double]$region.x
    $top = [double]$region.y
    $right = $left + [double]$region.width
    $bottom = $top + [double]$region.height
    foreach ($line in $result.Lines) {
        foreach ($word in $line.Words) {
            $box = $word.BoundingRect
            $cx = $box.X + $box.Width / 2
            $cy = $box.Y + $box.Height / 2
            if ($cx -ge $left -and $cx -le $right -and $cy -ge $top -and $cy -le $bottom) {
                $tokens.Add($word.Text)
            }
        }
    }
    $matches += [ordered]@{
        id = [string]$region.id
        text = ($tokens -join " ").Trim()
        confidence = $(if ($tokens.Count -gt 0) { 0.7 } else { 0.0 })
    }
}

$output = [ordered]@{
    language = $engine.RecognizerLanguage.LanguageTag
    matches = $matches
}
$output | ConvertTo-Json -Depth 5 -Compress

$bitmap.Dispose()
$stream.Dispose()
