# build.ps1 - build the DSH Mobile APK using the Android SDK tools directly (no Gradle, no AndroidX).
# ASCII-only on purpose (works in both Windows PowerShell 5.1 and PowerShell 7).
param(
    [string]$SdkRoot = "$env:LOCALAPPDATA\Android\Sdk",
    [string]$JdkHome  = "C:\Program Files\Android\Android Studio\jbr",
    [string]$BuildToolsVersion = "36.0.0",
    [int]$CompileSdk = 34,
    [int]$MinSdk = 26,
    [int]$VersionCode = 4,
    [string]$VersionName = "1.2.0",
    [switch]$SkipIcons
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Native tools write warnings to stderr; without merging, PowerShell 5.1 turns them
# into terminating errors. Merge both streams and judge success by the exit code.
function Invoke-Tool {
    param([string]$Exe, [string[]]$ToolArgs)
    & $Exe @ToolArgs 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() } else { Write-Host $_ }
    }
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw ("tool failed (exit {0}): {1}" -f $code, (Split-Path -Leaf $Exe)) }
}

$bt         = Join-Path $SdkRoot "build-tools\$BuildToolsVersion"
$aapt2      = Join-Path $bt "aapt2.exe"
$d8         = Join-Path $bt "d8.bat"
$zipalign   = Join-Path $bt "zipalign.exe"
$apksigner  = Join-Path $bt "apksigner.bat"
$androidJar = Join-Path $SdkRoot "platforms\android-$CompileSdk\android.jar"
# 第三方 jar（目前是 ZXing core：扫码解码用）。编译期放 classpath，打包期交给 d8 一起 dex 进去。
$libsDir    = Join-Path $root "libs"
$libsJars   = @()
if (Test-Path $libsDir) { $libsJars = @(Get-ChildItem $libsDir -Filter *.jar | ForEach-Object { $_.FullName }) }
$javacPath  = (@($androidJar) + $libsJars) -join ";"
$javac      = Join-Path $JdkHome "bin\javac.exe"
$java       = Join-Path $JdkHome "bin\java.exe"
$keytool    = Join-Path $JdkHome "bin\keytool.exe"

foreach ($tool in @($aapt2, $d8, $zipalign, $apksigner, $androidJar, $javac, $java, $keytool)) {
    if (-not (Test-Path $tool)) { throw "required tool missing: $tool" }
}

# d8.bat / apksigner.bat need a JRE: point JAVA_HOME at the JDK we already use.
$env:JAVA_HOME = $JdkHome
$env:PATH = (Join-Path $JdkHome "bin") + ";" + $env:PATH

if (-not $SkipIcons) { & (Join-Path $root "make-icons.ps1") }

$build      = Join-Path $root "build"
$gen        = Join-Path $build "gen"
$classesDir = Join-Path $build "classes"
$dexDir     = Join-Path $build "dex"
$distDir    = Join-Path $root "dist"
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
foreach ($d in @($gen, $classesDir, $dexDir, $distDir)) { New-Item -ItemType Directory -Force $d | Out-Null }

Write-Host "[1/7] aapt2 compile resources"
$resZip = Join-Path $build "res.zip"
Invoke-Tool $aapt2 @("compile", "--dir", "res", "-o", $resZip)

Write-Host "[2/7] aapt2 link (resources + manifest)"
$resApk = Join-Path $build "app-res.apk"
Invoke-Tool $aapt2 @("link", "-o", $resApk, "-I", $androidJar, "--manifest", "AndroidManifest.xml",
    "-R", $resZip, "--java", $gen, "--min-sdk-version", "$MinSdk", "--target-sdk-version", "$CompileSdk",
    "--version-code", "$VersionCode", "--version-name", $VersionName, "--auto-add-overlay")

Write-Host "[3/7] javac"
$sources = @()
$sources += (Get-ChildItem (Join-Path $root "src") -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$sources += (Get-ChildItem $gen -Recurse -Filter *.java | ForEach-Object { $_.FullName })
Invoke-Tool $javac (@("-encoding", "UTF-8", "--release", "11", "-classpath", $javacPath, "-d", $classesDir) + $sources)

Write-Host "[4/7] d8 (dex)"
$classFiles = (Get-ChildItem $classesDir -Recurse -Filter *.class | ForEach-Object { $_.FullName })
Invoke-Tool $d8 (@("--release", "--lib", $androidJar, "--min-api", "$MinSdk", "--output", $dexDir) + $classFiles + $libsJars)

Write-Host "[5/7] package apk (resources + classes.dex)"
$repacked = Join-Path $build "app-raw.apk"
$dexFile = Join-Path $dexDir "classes.dex"
# resources.arsc must stay STORED (uncompressed) for targetSdk >= 30 -> use the Java repacker.
Invoke-Tool $java @((Join-Path $root "tools\RepackApk.java"), $resApk, $dexFile, $repacked)

Write-Host "[6/7] zipalign"
$aligned = Join-Path $build "app-aligned.apk"
Invoke-Tool $zipalign @("-f", "-p", "4", $repacked, $aligned)

Write-Host "[7/7] sign"
$ksDir = Join-Path $root "keystore"
$ks    = Join-Path $ksDir "dsh-mobile.jks"
$alias = "dshmobile"
$pass  = "dshmobile"
if (-not (Test-Path $ks)) {
    New-Item -ItemType Directory -Force $ksDir | Out-Null
    Invoke-Tool $keytool @("-genkeypair", "-v", "-keystore", $ks, "-storepass", $pass, "-keypass", $pass,
        "-alias", $alias, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950",
        "-dname", "CN=DSH Mobile, OU=Personal, O=DSH, L=Local, S=Local, C=CN")
}
$outApk = Join-Path $distDir ("dsh-mobile-" + $VersionName + ".apk")
Invoke-Tool $apksigner @("sign", "--ks", $ks, "--ks-key-alias", $alias, "--ks-pass", "pass:$pass",
    "--key-pass", "pass:$pass", "--out", $outApk, $aligned)

Write-Host ""
Write-Host "=== apksigner verify ==="
Invoke-Tool $apksigner @("verify", "--print-certs", $outApk)
Write-Host ""
Write-Host "=== badging ==="
Invoke-Tool $aapt2 @("dump", "badging", $outApk)
Write-Host ""
Write-Host ("APK: {0} ({1:N0} bytes)" -f $outApk, (Get-Item $outApk).Length)
