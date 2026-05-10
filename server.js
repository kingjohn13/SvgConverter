const express = require('express');
const sharp   = require('sharp');
const multer  = require('multer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'svg-converter' }));

function isLightColor(colorStr) {
  if (!colorStr) return false;
  colorStr = colorStr.trim().toLowerCase();
  if (colorStr === 'white' || colorStr === '#fff' || colorStr === '#ffffff') return true;
  const hex3 = colorStr.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex3) {
    return parseInt(hex3[1]+hex3[1],16)>200 && parseInt(hex3[2]+hex3[2],16)>200 && parseInt(hex3[3]+hex3[3],16)>200;
  }
  const hex6 = colorStr.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (hex6) {
    return parseInt(hex6[1],16)>200 && parseInt(hex6[2],16)>200 && parseInt(hex6[3],16)>200;
  }
  return false;
}

function isDarkColor(colorStr) {
  if (!colorStr) return false;
  colorStr = colorStr.trim().toLowerCase();
  if (colorStr === 'black' || colorStr === '#000' || colorStr === '#000000') return true;
  const hex3 = colorStr.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex3) {
    return parseInt(hex3[1]+hex3[1],16)<40 && parseInt(hex3[2]+hex3[2],16)<40 && parseInt(hex3[3]+hex3[3],16)<40;
  }
  const hex6 = colorStr.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (hex6) {
    return parseInt(hex6[1],16)<40 && parseInt(hex6[2],16)<40 && parseInt(hex6[3],16)<40;
  }
  return false;
}

function cleanAndResizeSvg(svgBuffer, canvasWidth, canvasHeight, bleedMm, removeBg) {
  // removeBg: 'none' | 'white' | 'black' | 'both'
  let svg = svgBuffer.toString('utf8');

  // 1. CLEAN METADATA
  svg = svg.replace(/<\?xml[^?]*\?>/gi, '');
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');
  svg = svg.replace(/<sodipodi:[^>]*\/>/gi, '');
  svg = svg.replace(/<inkscape:[^>]*\/>/gi, '');
  svg = svg.replace(/\s(sodipodi|inkscape):[a-z-]+="[^"]*"/gi, '');
  svg = svg.replace(/<defs>\s*<\/defs>/gi, '');
  svg = svg.replace(/<g[^>]*>\s*<\/g>/gi, '');

  // 2. REMOVE BACKGROUND PATHS based on removeBg setting
  if (removeBg !== 'none') {
    svg = svg.replace(/<path([^>]*)\/>/gi, function(match, attrs) {
      const fillMatch = attrs.match(/\bfill="([^"]*)"/i) || attrs.match(/\bfill='([^']*)'/i);
      if (fillMatch) {
        const color = fillMatch[1];
        const isLight = isLightColor(color);
        const isDark  = isDarkColor(color);
        const removeLight = removeBg === 'white' || removeBg === 'both';
        const removeDark  = removeBg === 'black' || removeBg === 'both';
        if ((isLight && removeLight) || (isDark && removeDark)) {
          const hasOriginTransform = !attrs.includes('transform=') || /translate\s*\(\s*0\s*,\s*0\s*\)/i.test(attrs);
          if (hasOriginTransform) return '';
        }
      }
      return match;
    });
  }

  // 3. REMOVE BACKGROUND RECTS based on removeBg setting
  if (removeBg !== 'none') {
    svg = svg.replace(/<rect([^>]*)>/gi, function(match, attrs) {
      const removeLight = removeBg === 'white' || removeBg === 'both';
      const removeDark  = removeBg === 'black' || removeBg === 'both';

      // Check fill attribute
      const fillMatch = attrs.match(/\bfill="([^"]*)"/i) || attrs.match(/\bfill='([^']*)'/i);
      if (fillMatch) {
        if (removeLight && isLightColor(fillMatch[1])) return '';
        if (removeDark  && isDarkColor(fillMatch[1]))  return '';
      }

      // Check fill inside style attribute
      const styleMatch = attrs.match(/\bstyle="[^"]*fill\s*:\s*([^;}"'\s]+)/i);
      if (styleMatch) {
        if (removeLight && isLightColor(styleMatch[1])) return '';
        if (removeDark  && isDarkColor(styleMatch[1]))  return '';
      }

      // Always remove full-canvas 100% rects
      if (/\bwidth="100%"/i.test(attrs) && /\bheight="100%"/i.test(attrs)) return '';

      return match;
    });
    svg = svg.replace(/<\/rect>/gi, '');
  }

  // 4. REMOVE STROKES
  svg = svg.replace(/\bstroke="(?!none)[^"]*"/gi, 'stroke="none"');
  svg = svg.replace(/\bstroke='(?!none)[^']*'/gi, "stroke='none'");
  svg = svg.replace(/\bstroke-width="[^"]*"/gi, '');
  svg = svg.replace(/\bstroke-width='[^']*'/gi, '');

  // 5. GET VIEWBOX
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

  // 6. RESIZE + CENTER + BLEED
  const BLEED_PX = Math.round(bleedMm * (300 / 25.4));
  const SAFE_W   = canvasWidth  - BLEED_PX * 2;
  const SAFE_H   = canvasHeight - BLEED_PX * 2;
  const scale    = Math.min(SAFE_W / vbW, SAFE_H / vbH);
  const offsetX  = BLEED_PX + (SAFE_W - vbW * scale) / 2 - vbX * scale;
  const offsetY  = BLEED_PX + (SAFE_H - vbH * scale) / 2 - vbY * scale;

  // 7. REWRITE SVG ROOT
  svg = svg.replace(/<svg([^>]*)>/i, function(match, attrs) {
    attrs = attrs
      .replace(/\bwidth="[^"]*"/gi, '')
      .replace(/\bheight="[^"]*"/gi, '')
      .replace(/\bviewBox="[^"]*"/gi, '')
      .replace(/\bpreserveAspectRatio="[^"]*"/gi, '')
      .replace(/\bxmlns(:[a-z]+)?="[^"]*"/gi, '')
      .replace(/\bxmlns(:[a-z]+)?='[^']*'/gi, '')
      .trim();
    return '<svg' + (attrs ? ' ' + attrs : '') +
      ' width="' + canvasWidth + '"' +
      ' height="' + canvasHeight + '"' +
      ' viewBox="0 0 ' + canvasWidth + ' ' + canvasHeight + '"' +
      ' preserveAspectRatio="xMidYMid meet"' +
      ' xmlns="http://www.w3.org/2000/svg"' +
      ' style="background:transparent">';
  });

  // 8. WRAP IN TRANSFORM
  svg = svg.replace(/(<svg[^>]*>)([\s\S]*)(<\/svg>)/i, function(_, open, inner, close) {
    return open +
      '<g transform="translate(' + offsetX.toFixed(2) + ',' + offsetY.toFixed(2) + ') scale(' + scale.toFixed(6) + ')">' +
      inner +
      '</g>' +
      close;
  });

  return Buffer.from(svg, 'utf8');
}

app.post('/convert', upload.single('file'), async (req, res) => {
  try {
    const width            = parseInt(req.query.width            || req.body && req.body.width            || 4500);
    const height           = parseInt(req.query.height           || req.body && req.body.height           || 5400);
    const density          = parseInt(req.query.density          || req.body && req.body.density          || 300);
    const compressionLevel = parseInt(req.query.compressionLevel || req.body && req.body.compressionLevel || 6);
    const bleedMm          = parseFloat(req.query.bleedMm        || req.body && req.body.bleedMm          || 3);
    const removeBg         = (req.query.removeBg                 || req.body && req.body.removeBg         || 'white').toLowerCase();

    // Validate removeBg value
    const validRemoveBg = ['none', 'white', 'black', 'both'];
    const cleanRemoveBg = validRemoveBg.includes(removeBg) ? removeBg : 'white';

    let rawSvgBuffer;
    if (req.file) {
      rawSvgBuffer = req.file.buffer;
    } else if (req.body && req.body.svg) {
      const raw = req.body.svg;
      rawSvgBuffer = raw.trimStart().startsWith('<') ? Buffer.from(raw, 'utf8') : Buffer.from(raw, 'base64');
    } else {
      return res.status(400).json({ error: 'No SVG provided.' });
    }

    const cleanedSvgBuffer = cleanAndResizeSvg(rawSvgBuffer, width, height, bleedMm, cleanRemoveBg);

    const renderDensity = Math.min(density, 72);
    const tempBuffer = await sharp(cleanedSvgBuffer, { density: renderDensity, limitInputPixels: false })
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer();

    const pngBuffer = await sharp(tempBuffer, { limitInputPixels: false })
      .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel })
      .toBuffer();

    const filename = (req.file && req.file.originalname ? req.file.originalname : 'output').replace(/\.[^.]+$/, '') + '.png';

    res.set({
      'Content-Type':        'image/png',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
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
app.listen(PORT, () => console.log('svg-converter running on port ' + PORT));
