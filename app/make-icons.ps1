# make-icons.ps1 - generate launcher icons for the Android app
#
# Uses the source image AS-IS (no background removal, no recolouring, no cropping),
# but keeps PADDING around it - the whale must not touch the icon edges:
#   * ic_launcher.png            - art at 84% of the square (legacy icon, API < 26)
#   * ic_launcher_foreground.png - art at 52% of the 108dp adaptive canvas, so that inside
#     the launcher's ~72dp mask there is still a visible margin.
# The canvas is filled with the picture's OWN background colour (sampled from its top-left
# pixel); res/values/colors.xml must use the same value for ic_launcher_background so the
# adaptive background layer blends seamlessly.
# (ASCII-only on purpose: Windows PowerShell 5.1 needs ASCII or a UTF-8 BOM.)
param(
    [string]$Source = "",
    [string]$OutDir = "",
    [double]$LegacyCoverage = 0.84,
    [double]$ForegroundCoverage = 0.52
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Source -eq "") { $Source = Join-Path $root "assets\icon-full.png" }
if ($OutDir -eq "") { $OutDir = Join-Path $root "res" }
if (-not (Test-Path $Source)) { throw "icon source not found: $Source" }

Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Source)
$bg = ([System.Drawing.Bitmap]$src).GetPixel(2, 2)
Write-Host ("icon source: {0} ({1}x{2}), background #{3:X2}{4:X2}{5:X2}, legacy {6:P0} / foreground {7:P0}" -f $Source, $src.Width, $src.Height, $bg.R, $bg.G, $bg.B, $LegacyCoverage, $ForegroundCoverage)

# Draw the picture centred inside a $size x $size square, occupying $coverage of it.
function New-IconBitmap([System.Drawing.Image]$image, [int]$size, [double]$coverage, [System.Drawing.Color]$fill) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear($fill)
    $target = $size * $coverage
    $ratio = [Math]::Min($target / $image.Width, $target / $image.Height)
    $w = [int][Math]::Ceiling($image.Width * $ratio)
    $h = [int][Math]::Ceiling($image.Height * $ratio)
    $g.DrawImage($image, [int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
    $g.Dispose()
    return $bmp
}

$densities = @{
    "mdpi"    = 48;
    "hdpi"    = 72;
    "xhdpi"   = 96;
    "xxhdpi"  = 144;
    "xxxhdpi" = 192;
}
foreach ($name in $densities.Keys) {
    $size = $densities[$name]
    $dir = Join-Path $OutDir ("mipmap-" + $name)
    New-Item -ItemType Directory -Force $dir | Out-Null

    $bmp = New-IconBitmap $src $size $LegacyCoverage $bg
    $bmp.Save((Join-Path $dir "ic_launcher.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    # adaptive foreground: 108dp canvas, art at ~52% so the mask keeps a margin
    $fgSize = [int]($size * 108 / 48)
    $fg = New-IconBitmap $src $fgSize $ForegroundCoverage $bg
    $fg.Save((Join-Path $dir "ic_launcher_foreground.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $fg.Dispose()
    Write-Host ("  {0}: {1}px (art {2:P0}) + foreground {3}px (art {4:P0})" -f $name, $size, $LegacyCoverage, $fgSize, $ForegroundCoverage)
}
$src.Dispose()
