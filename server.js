const express = require('express');
const sharp   = require('sharp');
const multer  = require('multer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'svg-converter' }));

// ── SVG Cleaner ───────────────────────────────────────────────────────────────
function cleanAndResizeSvg(svgBuffer, canvasWidth, canvasHeight, bleedMm) {
  let svg = svgBuffer.toString('utf8');

  // 1. CLEAN METADATA
  svg = svg.replace(/<\?xml[^?]*\?>/gi, '');
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');
  svg = svg.replace(/<sodipodi:[^>]*\/>/gi, '');
  svg = svg.replace(/<inkscape:[^>]*\/>/gi, '');
  svg = svg.replace(/\s(sodipodi|inkscape):[a-z-]+="[^"]*"/gi, '');
  svg = svg.replace(/<defs>\s*<\/defs>/gi, '');
  svg = svg.replace(/<g[^>]*>\s*<\/g>/gi, '');

  // 2. REMOVE LIGHT/NEAR-WHITE BACKGROUND RECTS using brightness threshold
  function isLightColor(colorStr) {
    if (!colorStr) return false;
    colorStr = colorStr.trim().toLowerCase();
    if (colorStr === 'white' || colorStr === '#fff' || colorStr === '#ffffff') return true;
    // 3-digit hex: #rgb
    const hex3 = colorStr.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
    if (hex3) {
      const r = parseInt(hex3[1]+hex3[1], 16);
      const g = parseInt(hex3[2]+hex3[2], 16);
      const b = parseInt(hex3[3]+hex3[3], 16);
      return r > 200 && g > 200 && b > 200;
    }
    // 6-digit hex: #rrggbb
    const hex6 = colorStr.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
    if (hex6) {
      const r = parseInt(hex6[1], 16);
      const g = parseInt(hex6[2], 16);
      const b = parseInt(hex6[3], 16);
      return r > 210 && g > 210 && b > 210;
    }
    return false;
  }

  // Remove rect elements with light fill colors (attribute or style)
  svg = svg.replace(/<rect([^>]*)>/gi, (match, attrs) => {
    // Check fill attribute
    const fillAttr = attrs.match(/\bfill=["']([^"']*)["']/i);
    if (fillAttr && isLightColor(fillAttr[1])) return '';
    // Check fill inside style
    const styleAttr = attrs.match(/\bstyle=["'][^"']*fill\s*:\s*([^;}"'\s]+)/i);
    if (styleAttr && isLightColor(styleAttr[1])) return '';
    // Check width=100% (likely a background)
    if (/\bwidth=["']100%["']/i.test(attrs) && /\bheight=["']100%["']/i.test(attrs)) return '';
    return match;
  });
  // Also remove closing </rect> tags that were orphaned
  svg = svg.replace(/<\/rect>/gi, '');

  // 3. REMOVE STROKES
  svg = svg.replace(/\bstroke="(?!none)[^"]*"/gi, 'stroke="none"');
  svg = svg.replace(/\bstroke='(?!none)[^']*'/gi, "stroke='none'");
  svg = svg.replace(/\bstroke-width="[^"]*"/gi, '');
  svg = svg.replace(/\bstroke-width='[^']*'/gi, '');

  // 4. GET VIEWBOX
  const vbMatch = svg.match(/viewBox="([\d.,\s-]+)"/i) || svg.match(/viewBox='([\d.,\s-]+)'/i);
  let vbX = 0, vbY = 0, vbW = 500, vbH = 500;
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    [vbX, vbY, vbW, vbH] = parts;
  } else {
    const wm = svg.match(/\bwidth="([\d.]+)"/i);
    const hm = svg.match(/\bheight="([\d.]+)"/i);
    if (wm) vbW = parseFloat(wm[1]);
    if (hm) vbH = parseFloat(hm[1]);
  }

  // 5. RESIZE + CENTER + BLEED
  const BLEED_PX = Math.round(bleedMm * (300 / 25.4));
  const SAFE_W   = canvasWidth  - BLEED_PX * 2;
  const SAFE_H   = canvasHeight - BLEED_PX * 2;
  const scale    = Math.min(SAFE_W / vbW, SAFE_H / vbH);
  const offsetX  = BLEED_PX + (SAFE_W - vbW * scale) / 2 - vbX * scale;
  const offsetY  = BLEED_PX + (SAFE_H - vbH * scale) / 2 - vbY * scale;

  // 6. REWRITE SVG ROOT
  svg = svg.replace(/<svg([^>]*)>/i, (_, attrs) => {
    attrs = attrs
      .replace(/\bwidth="[^"]*"/gi, '')
      .replace(/\bheight="[^"]*"/gi, '')
      .replace(/\bviewBox="[^"]*"/gi, '')
      .replace(/\bpreserveAspectRatio="[^"]*"/gi, '')
      .replace(/\bxmlns(:[a-z]+)?="[^"]*"/gi, '')
      .replace(/\bxmlns(:[a-z]+)?='[^']*'/gi, '')
      .trim();
    return `<svg${attrs ? ' ' + attrs : ''} width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="background:transparent">`;
  });

  // 7. WRAP IN TRANSFORM
  svg = svg.replace(
    /(<svg[^>]*>)([\s\S]*)(<\/svg>)/i,
    (_, open, inner, close) =>
      `${open}<g transform="translate(${offsetX.toFixed(2)},${offsetY.toFixed(2)}) scale(${scale.toFixed(6)})">${inner}</g>${close}`
  );

  return Buffer.from(svg, 'utf8');
}

// ── POST /convert ─────────────────────────────────────────────────────────────
// Accepts multipart/form-data with field "file" (SVG binary)
// or application/json with field "svg" (SVG string, base64 or raw)
// Optional params: width, height, density, compressionLevel, bleedMm
// ─────────────────────────────────────────────────────────────────────────────
app.post('/convert', upload.single('file'), async (req, res) => {
  try {
    const width            = parseInt(req.query.width            || req.body?.width            || 4500);
    const height           = parseInt(req.query.height           || req.body?.height           || 5400);
    const density          = parseInt(req.query.density          || req.body?.density          || 300);
    const compressionLevel = parseInt(req.query.compressionLevel || req.body?.compressionLevel || 6);
    const bleedMm          = parseFloat(req.query.bleedMm       || req.body?.bleedMm          || 3);

    let rawSvgBuffer;

    if (req.file) {
      rawSvgBuffer = req.file.buffer;
    } else if (req.body?.svg) {
      const raw = req.body.svg;
      rawSvgBuffer = raw.trimStart().startsWith('<')
        ? Buffer.from(raw, 'utf8')
        : Buffer.from(raw, 'base64');
    } else {
      return res.status(400).json({ error: 'No SVG provided. Send multipart "file" field or JSON "svg" field.' });
    }

    // Clean + resize SVG
    const cleanedSvgBuffer = cleanAndResizeSvg(rawSvgBuffer, width, height, bleedMm);

    // Convert to PNG
    // Render at lower density first to save memory, then resize to target
    const renderDensity = Math.min(density, 72);
    const tempBuffer = await sharp(cleanedSvgBuffer, { density: renderDensity, limitInputPixels: false })
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer();

    const pngBuffer = await sharp(tempBuffer, { limitInputPixels: false })
      .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel })
      .toBuffer();

    const filename = (req.file?.originalname || 'output').replace(/\.[^.]+$/, '') + '.png';

    res.set({
      'Content-Type':        'image/png',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      pngBuffer.length,
      'X-File-Name':         filename,
    });

    res.send(pngBuffer);

  } catch (err) {
    console.error('Convert error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`svg-converter running on port ${PORT}`));
