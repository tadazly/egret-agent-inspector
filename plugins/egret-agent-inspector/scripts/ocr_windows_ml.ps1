param([string]$Model = $env:EGRET_OCR_MODEL, [string]$SpecPath, [switch]$Daemon)

# Windows OCR helper backed by the in-box Windows ML runtime (Windows.AI.MachineLearning, Windows 10 1903+)
# running a PaddleOCR PP-OCRv4 mobile text-recognition model. Keep this file ASCII only: Windows PowerShell 5.1
# reads BOM-less scripts with the ANSI code page.
#
# Protocol (same as ocr_macos.swift): one spec JSON path per stdin line, one JSON result per stdout line.
#   spec:   {image, regions:[{id,x,y,width,height}], languages}
#   result: {backend, matches:[{id,text,confidence}]}
# Text lines baked into buttons are usually short and sit below or beside an icon, so besides the whole
# region a few horizontal bands are recognized too and the best-scoring candidate wins (no detection model).

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

$null = [Windows.AI.MachineLearning.LearningModel, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
$null = [Windows.AI.MachineLearning.LearningModelDevice, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
$null = [Windows.AI.MachineLearning.LearningModelDeviceKind, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
$null = [Windows.AI.MachineLearning.LearningModelSession, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
$null = [Windows.AI.MachineLearning.LearningModelBinding, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
$null = [Windows.AI.MachineLearning.TensorFloat, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
$null = [Windows.AI.MachineLearning.LearningModelEvaluationResult, Windows.AI.MachineLearning, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IBuffer, Windows.Storage.Streams, ContentType = WindowsRuntime]

Add-Type -ReferencedAssemblies @("System.Drawing", "System.Runtime.WindowsRuntime") -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace EgretOcr {
    public class Crop {
        public string Id;      // null for padding crops
        public int Width;      // content width after resizing to H
        public int Bucket;     // padded width the tensor is built with (fixed set, so Windows ML reuses its plan)
        public float[] Data;   // 3 x H x Width, BGR, normalized to [-1, 1]
        public string Text = "";
        public float Score;
    }

    public static class Rec {
        public const int H = 48;
        // Windows ML re-plans the graph for every new input shape (~200 ms each), so widths are snapped
        // to a handful of buckets and batches are padded to 2/4/8 items; all combinations are warmed up at start.
        public static readonly int[] Buckets = new int[] { 64, 96, 128, 192, 256, 384, 640 };
        public static readonly int[] BatchSizes = new int[] { 2, 4, 8 };

        public static int BucketOf(int width) {
            foreach (int b in Buckets) if (width <= b) return b;
            return Buckets[Buckets.Length - 1];
        }

        public static Crop Dummy(int width) {
            return new Crop { Id = null, Width = width, Bucket = width, Data = new float[3 * H * width] };
        }

        // Whole region plus up to four horizontal bands for tall regions (icon above a caption).
        public static List<Crop> Prepare(Bitmap img, string id, double x, double y, double w, double h, int maxWidth) {
            var list = new List<Crop>();
            int x0 = (int)Math.Max(0, Math.Floor(x)), y0 = (int)Math.Max(0, Math.Floor(y));
            int x1 = (int)Math.Min(img.Width, Math.Ceiling(x + w)), y1 = (int)Math.Min(img.Height, Math.Ceiling(y + h));
            int rw = x1 - x0, rh = y1 - y0;
            if (rw < 8 || rh < 8) return list;
            AddCrop(list, img, id, new Rectangle(x0, y0, rw, rh), maxWidth);
            if (rh >= 36 && rh > rw * 0.45) {
                int band = Math.Max(20, Math.Min(rh, (int)(rw * 0.5)));
                int step = Math.Max(8, band / 2);
                int count = 0;
                for (int yy = 0; yy + band <= rh + step - 1 && count < 4; yy += step, count++) {
                    int yb = Math.Min(rh, yy + band);
                    AddCrop(list, img, id, new Rectangle(x0, y0 + Math.Max(0, yb - band), rw, band), maxWidth);
                }
            }
            return list;
        }

        static void AddCrop(List<Crop> list, Bitmap img, string id, Rectangle rect, int maxWidth) {
            float scale = (float)H / rect.Height;
            int tw = Math.Max(8, Math.Min(maxWidth, (int)Math.Round(rect.Width * scale)));
            tw = ((tw + 7) / 8) * 8;
            using (var bmp = new Bitmap(tw, H, PixelFormat.Format24bppRgb))
            using (var g = Graphics.FromImage(bmp)) {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(img, new Rectangle(0, 0, tw, H), rect, GraphicsUnit.Pixel);
                list.Add(new Crop { Id = id, Width = tw, Bucket = BucketOf(tw), Data = ToTensor(bmp) });
            }
        }

        static float[] ToTensor(Bitmap bmp) {
            int w = bmp.Width, h = bmp.Height;
            var data = new float[3 * h * w];
            var bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try {
                var row = new byte[bd.Stride];
                for (int yy = 0; yy < h; yy++) {
                    Marshal.Copy(bd.Scan0 + yy * bd.Stride, row, 0, bd.Stride);
                    for (int xx = 0; xx < w; xx++) {
                        // PaddleOCR is fed OpenCV BGR images; keep that channel order.
                        data[0 * h * w + yy * w + xx] = row[xx * 3] / 127.5f - 1f;
                        data[1 * h * w + yy * w + xx] = row[xx * 3 + 1] / 127.5f - 1f;
                        data[2 * h * w + yy * w + xx] = row[xx * 3 + 2] / 127.5f - 1f;
                    }
                }
            } finally { bmp.UnlockBits(bd); }
            return data;
        }

        // Pack crops into one N x 3 x H x width tensor, right-padding narrower crops with zeros.
        public static float[] Batch(List<Crop> crops, int width) {
            var batch = new float[crops.Count * 3 * H * width];
            for (int n = 0; n < crops.Count; n++) {
                var c = crops[n];
                for (int ch = 0; ch < 3; ch++)
                    for (int yy = 0; yy < H; yy++)
                        Array.Copy(c.Data, ch * H * c.Width + yy * c.Width,
                                   batch, n * 3 * H * width + ch * H * width + yy * width, c.Width);
            }
            return batch;
        }

        // ITensorNative lets us read the tensor memory directly instead of one COM call per element.
        [ComImport, Guid("52f547ef-5b03-49b5-82d6-565f1ee0dd49"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface ITensorNative {
            [PreserveSig] int GetBuffer(out IntPtr value, out uint capacity);
            [PreserveSig] int GetD3D12Resource(out IntPtr result);
        }

        public static float[] ReadTensor(object tensor, int count) {
            try {
                var native = tensor as ITensorNative;
                if (native != null) {
                    IntPtr ptr; uint capacity;
                    if (native.GetBuffer(out ptr, out capacity) == 0 && ptr != IntPtr.Zero && capacity >= count * 4) {
                        var f = new float[count];
                        Marshal.Copy(ptr, f, 0, count);
                        return f;
                    }
                }
            } catch (Exception) { }
            return null;
        }

        // Windows 11 puts long-running background console processes into "efficiency mode" (EcoQoS): after
        // about a second of work the daemon gets parked on throttled cores and evaluations run ~10x slower.
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_POWER_THROTTLING_STATE { public uint Version; public uint ControlMask; public uint StateMask; }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetProcessInformation(IntPtr hProcess, int ProcessInformationClass, ref PROCESS_POWER_THROTTLING_STATE info, int size);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();

        public static bool DisablePowerThrottling() {
            try {
                var state = new PROCESS_POWER_THROTTLING_STATE { Version = 1, ControlMask = 1, StateMask = 0 };
                return SetProcessInformation(GetCurrentProcess(), 4, ref state, Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
            } catch (Exception) { return false; }
        }

        public static float[] FromList(IReadOnlyList<float> list, int count) {
            var f = new float[count];
            for (int i = 0; i < count; i++) f[i] = list[i];
            return f;
        }

        // CTC greedy decoding of softmax output [steps x classes]; index 0 is the blank.
        public static string Decode(float[] probs, int offset, int steps, int classes, string[] dict, out float score) {
            var sb = new StringBuilder();
            int prev = 0;
            float sum = 0; int kept = 0;
            for (int t = 0; t < steps; t++) {
                int baseIdx = offset + t * classes;
                int best = 0; float bp = probs[baseIdx];
                for (int c = 1; c < classes; c++) {
                    float p = probs[baseIdx + c];
                    if (p > bp) { bp = p; best = c; }
                }
                if (best != 0 && best != prev) {
                    if (best < dict.Length) sb.Append(dict[best]);
                    sum += bp; kept++;
                }
                prev = best;
            }
            score = kept > 0 ? sum / kept : 0f;
            return sb.ToString().Trim();
        }
    }
}
"@

$script:MaxWidth = 640
$script:BatchSize = 8
$script:MinScore = 0.5
$script:NoThrottle = [EgretOcr.Rec]::DisablePowerThrottling()
try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Normal } catch { }

function Load-Model([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { throw "OCR model not found: $Path" }
    $script:Net = [Windows.AI.MachineLearning.LearningModel]::LoadFromFilePath($Path)
    $chars = $null
    foreach ($kv in $script:Net.Metadata) { if ($kv.Key -eq "character") { $chars = $kv.Value } }
    if (-not $chars) { throw "OCR model has no character dictionary in its metadata" }
    $lines = $chars.Replace("`r", "").Split("`n")
    $dict = New-Object System.Collections.Generic.List[string]
    $dict.Add("")
    foreach ($l in $lines) { $dict.Add($l) }
    $dict.Add(" ")
    $script:Dict = $dict.ToArray()
    $device = New-Object Windows.AI.MachineLearning.LearningModelDevice([Windows.AI.MachineLearning.LearningModelDeviceKind]::Cpu)
    $script:Session = New-Object Windows.AI.MachineLearning.LearningModelSession($script:Net, $device)
    $script:InputName = $script:Net.InputFeatures[0].Name
    $script:OutputName = $script:Net.OutputFeatures[0].Name
    # Warm up and learn the output layout (steps per 8 px of width, number of classes).
    $probe = New-Object float[] (3 * 48 * 64)
    $shape = [int64[]]@(1, 3, 48, 64)
    $tensor = [Windows.AI.MachineLearning.TensorFloat]::CreateFromArray($shape, $probe)
    $binding = New-Object Windows.AI.MachineLearning.LearningModelBinding($script:Session)
    $binding.Bind($script:InputName, $tensor)
    $out = [Windows.AI.MachineLearning.TensorFloat]::Create()
    $binding.Bind($script:OutputName, $out)
    $null = $script:Session.Evaluate($binding, "warm")
    $outShape = @($out.Shape | ForEach-Object { [int64]$_ })
    if ($outShape.Count -ne 3) { throw "unexpected OCR model output rank $($outShape.Count)" }
    $script:StepsPer8 = [int]($outShape[1] / 8)
    $script:Classes = [int]$outShape[2]
    if ($script:Classes -ne $script:Dict.Length) {
        # keep going; unknown indexes are simply skipped by Decode
        [Console]::Error.WriteLine("dictionary has $($script:Dict.Length) entries but the model outputs $($script:Classes) classes")
    }
    # Warm every (batch, width) shape once so real requests never pay the re-planning cost.
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($w in [EgretOcr.Rec]::Buckets) {
        foreach ($b in [EgretOcr.Rec]::BatchSizes) {
            $chunk = New-Object System.Collections.Generic.List[EgretOcr.Crop]
            for ($i = 0; $i -lt $b; $i++) { $chunk.Add([EgretOcr.Rec]::Dummy($w)) }
            Run-Batch $chunk
        }
    }
    Trace ("warmed " + ([EgretOcr.Rec]::Buckets.Length * [EgretOcr.Rec]::BatchSizes.Length) + " shapes in " + $sw.ElapsedMilliseconds + "ms; power throttling disabled=" + $script:NoThrottle + " priority=" + [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass)
}

$script:Debug = ($env:EGRET_OCR_DEBUG -eq "1")
function Trace([string]$Message) { if ($script:Debug) { [Console]::Error.WriteLine("[ocr-ml] " + $Message) } }

function Run-Batch($Crops) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $width = $Crops[0].Bucket
    $real = $Crops.Count
    # pad the batch to a fixed size so the (n, width) shape comes from a small warmed-up set
    $target = 8
    foreach ($b in [EgretOcr.Rec]::BatchSizes) { if ($Crops.Count -le $b) { $target = $b; break } }
    while ($Crops.Count -lt $target) { $Crops.Add([EgretOcr.Rec]::Dummy($width)) }
    $n = $Crops.Count
    $data = [EgretOcr.Rec]::Batch($Crops, $width)
    $shape = [int64[]]@($n, 3, 48, $width)
    $tensor = [Windows.AI.MachineLearning.TensorFloat]::CreateFromArray($shape, $data)
    $steps = [int]($width / 8 * $script:StepsPer8)
    $count = $n * $steps * $script:Classes
    $outTensor = [Windows.AI.MachineLearning.TensorFloat]::Create([int64[]]@($n, $steps, $script:Classes))
    $binding = New-Object Windows.AI.MachineLearning.LearningModelBinding($script:Session)
    $binding.Bind($script:InputName, $tensor)
    $binding.Bind($script:OutputName, $outTensor)
    $prep = $sw.ElapsedMilliseconds
    $null = $script:Session.Evaluate($binding, "ocr")
    $evalMs = $sw.ElapsedMilliseconds - $prep
    $probs = [EgretOcr.Rec]::ReadTensor($outTensor, $count)
    $how = "native"
    if ($null -eq $probs) {
        $how = "vector"
        $probs = [EgretOcr.Rec]::FromList($outTensor.GetAsVectorView(), $count)
    }
    for ($i = 0; $i -lt $real; $i++) {
        $score = [float]0
        $Crops[$i].Text = [EgretOcr.Rec]::Decode($probs, $i * $steps * $script:Classes, $steps, $script:Classes, $script:Dict, [ref]$score)
        $Crops[$i].Score = $score
    }
    Trace ("batch n=$n real=$real width=$width steps=$steps prep=${prep}ms eval=${evalMs}ms read+decode=" + ($sw.ElapsedMilliseconds - $prep - $evalMs) + "ms via=$how first=" + $probs[0] + " text0=" + $Crops[0].Text + " score0=" + $Crops[0].Score)
    # release the native tensors right away: PowerShell only finalizes them at some later GC, and evaluations
    # got several times slower once a few hundred MB of tensors piled up
    $binding.Clear()
    $tensor.Dispose()
    $outTensor.Dispose()
}

function Recognize-Spec([string]$Path) {
    $spec = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $img = [System.Drawing.Bitmap]::FromFile([string]$spec.image)
    try {
        $all = New-Object System.Collections.Generic.List[EgretOcr.Crop]
        $order = New-Object System.Collections.Generic.List[string]
        foreach ($region in $spec.regions) {
            $order.Add([string]$region.id)
            $crops = [EgretOcr.Rec]::Prepare($img, [string]$region.id, [double]$region.x, [double]$region.y,
                [double]$region.width, [double]$region.height, $script:MaxWidth)
            foreach ($c in $crops) { $all.Add($c) }
        }
        # crops sharing a width bucket go into the same batches
        foreach ($group in ($all | Group-Object -Property Bucket)) {
            $items = @($group.Group)
            for ($i = 0; $i -lt $items.Count; $i += $script:BatchSize) {
                $chunk = New-Object System.Collections.Generic.List[EgretOcr.Crop]
                for ($j = $i; $j -lt [Math]::Min($items.Count, $i + $script:BatchSize); $j++) { $chunk.Add($items[$j]) }
                Run-Batch $chunk
            }
        }
        $best = @{}
        foreach ($c in $all) {
            if ($c.Text.Length -eq 0 -or $c.Score -lt $script:MinScore) { continue }
            if (-not $best.ContainsKey($c.Id) -or $c.Score -gt $best[$c.Id].Score + 0.05) { $best[$c.Id] = $c }
        }
        $matches = @()
        foreach ($id in $order) {
            if ($best.ContainsKey($id)) {
                $matches += [ordered]@{ id = $id; text = $best[$id].Text; confidence = [Math]::Round($best[$id].Score, 3) }
            } else {
                $matches += [ordered]@{ id = $id; text = ""; confidence = 0.0 }
            }
        }
        $output = [ordered]@{ backend = "windows-ml-ppocr"; crops = $all.Count; matches = $matches }
        return ($output | ConvertTo-Json -Depth 5 -Compress)
    } finally {
        $img.Dispose()
        [System.GC]::Collect()
    }
}

Load-Model $Model
if ($Daemon) {
    [Console]::Out.WriteLine('{"ready":true}')
    [Console]::Out.Flush()
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if ($line.Length -eq 0) { continue }
        try {
            $json = Recognize-Spec $line
        } catch {
            $message = ([string]$_.Exception.Message) -replace '[\\"]', "'" -replace "[\r\n]+", " "
            $json = '{"error":"' + $message + '"}'
        }
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    }
} else {
    if (-not $SpecPath) { throw "usage: ocr_windows_ml.ps1 -Model <model.onnx> <spec.json> | -Daemon" }
    [Console]::Out.WriteLine((Recognize-Spec $SpecPath))
}
