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

  // Suporta duas formas de credencial:
  // 1. GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT — conteúdo do JSON (Railway, Heroku, etc.)
  // 2. GOOGLE_SERVICE_ACCOUNT_JSON — caminho para o arquivo (local/VPS)
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT contém JSON inválido');
    }
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'utf8'));
  } else {
    throw new Error('Configure GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT (Railway) ou GOOGLE_SERVICE_ACCOUNT_JSON (local)');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
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

// Extrai folder ID de URL de pasta do Drive
function extractDriveFolderId(url) {
  const m = url.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  return m ? m[1] : null;
}

// Lista arquivos de imagem numa pasta do Drive e faz download para destDir
async function downloadFolderImages(folderUrl, destDir) {
  const folderId = extractDriveFolderId(folderUrl);
  if (!folderId) throw new Error('Não foi possível extrair o folder ID da URL do Google Drive');

  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT) {
    try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT); }
    catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT contém JSON inválido'); }
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'utf8'));
  } else {
    throw new Error('Configure GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT (Railway) ou GOOGLE_SERVICE_ACCOUNT_JSON (local)');
  }

  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });

  const list = await drive.files.list({
    q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 20,
  });

  const files = list.data.files || [];
  if (files.length === 0) return [];

  const paths = [];
  for (const file of files) {
    const ext = file.mimeType.includes('png') ? 'png' : file.mimeType.includes('webp') ? 'webp' : 'jpg';
    const destPath = path.join(destDir, `photo_${file.id}.${ext}`);
    const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(destPath);
      res.data.pipe(dest).on('finish', resolve).on('error', reject);
      res.data.on('error', reject);
    });
    paths.push(destPath);
  }

  return paths;
}

module.exports = { isDriveUrl, downloadFromDrive, extractDriveFileId, downloadFolderImages };
