const express = require('express');
const sharp   = require('sharp');
const multer  = require('multer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'svg-converter' }));

// ── POST /convert ─────────────────────────────────────────────────────────────
// Accepts either:
//   multipart/form-data  with field "file" (SVG binary)
//   application/json     with field "svg"  (SVG string, base64 or raw)
//
// Optional query params / json body fields:
//   width, height, density, compressionLevel
// ─────────────────────────────────────────────────────────────────────────────
app.post('/convert', upload.single('file'), async (req, res) => {
  try {
    const width            = parseInt(req.query.width  || req.body?.width  || 4500);
    const height           = parseInt(req.query.height || req.body?.height || 5400);
    const density          = parseInt(req.query.density          || req.body?.density          || 300);
    const compressionLevel = parseInt(req.query.compressionLevel || req.body?.compressionLevel || 6);

    let svgBuffer;

    if (req.file) {
      // multipart upload
      svgBuffer = req.file.buffer;
    } else if (req.body?.svg) {
      // JSON body — accept raw SVG string or base64
      const raw = req.body.svg;
      svgBuffer = raw.startsWith('<')
        ? Buffer.from(raw, 'utf8')
        : Buffer.from(raw, 'base64');
    } else {
      return res.status(400).json({ error: 'No SVG provided. Send multipart "file" field or JSON "svg" field.' });
    }

    const pngBuffer = await sharp(svgBuffer, { density })
      .resize(width, height, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
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
