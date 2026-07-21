#requires -Version 7.0
# PetaPad アイコン生成: 紙1枚 + 緑ペン (TeraPad リスペクト)
# 出力: assets/petapad.ico (256/48/32/16 PNG エントリ)
Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Draw-Icon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $s = $size / 256.0

    # ---- 紙 1枚 (正立) ----
    $paperFill = [System.Drawing.Color]::FromArgb(255, 250, 243, 208)
    $paperEdge = [System.Drawing.Color]::FromArgb(255, 60, 56, 42)
    $lineCol   = [System.Drawing.Color]::FromArgb(255, 150, 136, 92)
    $g.TranslateTransform(118 * $s, 138 * $s)
    $g.RotateTransform(0)
    $pw = 168 * $s; $ph = 200 * $s
    $rect = New-Object System.Drawing.RectangleF (-$pw/2), (-$ph/2), $pw, $ph
    $br = New-Object System.Drawing.SolidBrush $paperFill
    $g.FillRectangle($br, $rect)
    $pen = New-Object System.Drawing.Pen -ArgumentList @($paperEdge, [single]([Math]::Max(1.0, 9 * $s)))
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawRectangle($pen, $rect.X, $rect.Y, $rect.Width, $rect.Height)
    # 本文の線
    $pen.Color = $lineCol
    $pen.Width = [single]([Math]::Max(1.0, 8 * $s))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $x0 = -$pw/2 + 24*$s; $x1 = $pw/2 - 24*$s
    foreach ($i in 0..3) {
        $ly = -$ph/2 + (48 + 38*$i) * $s
        $xe = if ($i -eq 3) { ($x0 + ($x1-$x0)*0.6) } else { $x1 }
        $g.DrawLine($pen, $x0, $ly, $xe, $ly)
    }
    $g.ResetTransform()

    # ---- 緑ペン (右上から左下へ、先端が紙の上) ----
    $bodyCol  = [System.Drawing.Color]::FromArgb(255, 46, 164, 79)
    $darkCol  = [System.Drawing.Color]::FromArgb(255, 26, 118, 52)
    $woodCol  = [System.Drawing.Color]::FromArgb(255, 235, 195, 90)
    $leadCol  = [System.Drawing.Color]::FromArgb(255, 70, 56, 34)
    $edgePen  = New-Object System.Drawing.Pen -ArgumentList @([System.Drawing.Color]::FromArgb(255, 30, 60, 38), [single]([Math]::Max(1.0, 6 * $s)))
    $edgePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    # 先端 (70,190) から 45度右上方向
    $g.RotateTransform(-45, [System.Drawing.Drawing2D.MatrixOrder]::Append)
    $g.TranslateTransform(70 * $s, 190 * $s, [System.Drawing.Drawing2D.MatrixOrder]::Append)
    $L = 200 * $s   # 全長
    $tip = 44 * $s  # 木部の長さ
    $hw = 22 * $s   # 半幅
    # 木部 (三角)
    $wood = @(
        (New-Object System.Drawing.PointF 0, 0),
        (New-Object System.Drawing.PointF $tip, (-$hw)),
        (New-Object System.Drawing.PointF $tip, $hw)
    )
    $g.FillPolygon((New-Object System.Drawing.SolidBrush $woodCol), [System.Drawing.PointF[]]$wood)
    # 芯
    $lead = @(
        (New-Object System.Drawing.PointF 0, 0),
        (New-Object System.Drawing.PointF (16*$s), (-8*$s)),
        (New-Object System.Drawing.PointF (16*$s), (8*$s))
    )
    $g.FillPolygon((New-Object System.Drawing.SolidBrush $leadCol), [System.Drawing.PointF[]]$lead)
    # 軸
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $bodyCol), $tip, (-$hw), ($L - $tip), (2*$hw))
    # 影側ストライプ
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $darkCol), $tip, ($hw - 12*$s), ($L - $tip), (12*$s))
    # 尻のキャップ
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $darkCol), ($L - 12*$s), (-$hw), (12*$s), (2*$hw))
    # 輪郭
    $outline = @(
        (New-Object System.Drawing.PointF 0, 0),
        (New-Object System.Drawing.PointF $tip, (-$hw)),
        (New-Object System.Drawing.PointF $L, (-$hw)),
        (New-Object System.Drawing.PointF $L, $hw),
        (New-Object System.Drawing.PointF $tip, $hw)
    )
    $g.DrawPolygon($edgePen, [System.Drawing.PointF[]]$outline)
    # 木部と軸の境界線
    $g.DrawLine($edgePen, $tip, (-$hw), $tip, $hw)
    $g.ResetTransform()

    $g.Dispose()
    return $bmp
}

# 各サイズを PNG に (小サイズも 256 から縮小せず直接描画して線を保つ)
$sizes = @(256, 48, 32, 16)
$pngs = @{}
foreach ($sz in $sizes) {
    $bmp = Draw-Icon $sz
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs[$sz] = $ms.ToArray()
    $bmp.Dispose(); $ms.Dispose()
}

# ICO 組み立て (PNG エントリ)
$count = $sizes.Count
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$count)
$offset = 6 + 16 * $count
foreach ($sz in $sizes) {
    $b = if ($sz -eq 256) { [byte]0 } else { [byte]$sz }
    $w.Write($b); $w.Write($b)          # width, height
    $w.Write([byte]0); $w.Write([byte]0) # colors, reserved
    $w.Write([uint16]1); $w.Write([uint16]32) # planes, bpp
    $w.Write([uint32]$pngs[$sz].Length)
    $w.Write([uint32]$offset)
    $offset += $pngs[$sz].Length
}
foreach ($sz in $sizes) { $w.Write($pngs[$sz]) }
[System.IO.File]::WriteAllBytes("$dir\petapad.ico", $out.ToArray())
$w.Dispose()
"petapad.ico written: $((Get-Item "$dir\petapad.ico").Length) bytes"
