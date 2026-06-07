const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Extrai o file ID de qualquer formato de URL do Google Drive
function extractDriveFileId(url) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]{10,})/,   // /file/d/ID
    /[?&]id=([a-zA-Z0-9_-]{10,})/,        // ?id=ID
    /\/open\?id=([a-zA-Z0-9_-]{10,})/,    // /open?id=ID
    /\/d\/([a-zA-Z0-9_-]{10,})\/view/,    // /d/ID/view
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function isDriveUrl(url) {
  return /drive\.google\.com/i.test(url);
}

async function downloadFromDrive(url, destPath) {
  const fileId = extractDriveFileId(url);
  if (!fileId) throw new Error('Não foi possível extrair o file ID da URL do Google Drive');

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyPath) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado no .env');

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Verifica metadados primeiro (nome, tamanho, tipo)
  const meta = await drive.files.get({
    fileId,
    fields: 'name,size,mimeType',
  });

  const MAX_BYTES = 500 * 1024 * 1024; // 500 MB
  if (meta.data.size && parseInt(meta.data.size, 10) > MAX_BYTES) {
    throw new Error(`Arquivo muito grande: ${(parseInt(meta.data.size,10)/1_048_576).toFixed(0)} MB (máximo 500 MB)`);
  }

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    let downloaded = 0;
    const dest = fs.createWriteStream(destPath);
    res.data
      .on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > MAX_BYTES) {
          dest.destroy();
          reject(new Error('Arquivo excedeu limite de 500 MB durante download'));
        }
      })
      .on('error', reject)
      .pipe(dest)
      .on('finish', resolve)
      .on('error', reject);
  });

  return { name: meta.data.name, mimeType: meta.data.mimeType };
}

module.exports = { isDriveUrl, downloadFromDrive, extractDriveFileId };
