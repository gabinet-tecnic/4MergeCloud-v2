// Integració amb Google Drive (Picker + Drive API).
// Deixa que l'usuari obri fitxers (GLB/GLTF/PLY/OBJ/XYZ/4mc) directament del seu Drive.
// Els valors CLIENT_ID i API_KEY són identificadors públics, protegits per restriccions
// de domini a Google Cloud (només funcionen des de https://gabinet-tecnic.github.io).

(function () {
  const CLIENT_ID = '66166800696-qbbqsktu87paiq0bg2a35n16fm3itj20.apps.googleusercontent.com';
  const API_KEY   = 'AIzaSyASZGSd9gaen43vS6mWMAyNXevQOmSMxdA';
  const SCOPES    = 'https://www.googleapis.com/auth/drive.readonly';

  let tokenClient = null;
  let accessToken = null;
  let pickerReady = false;

  function log(msg) { try { window.diag && window.diag('[drive] ' + msg); } catch (_) {} console.log('[drive]', msg); }

  function loadPicker() {
    return new Promise((resolve, reject) => {
      if (pickerReady) return resolve();
      if (!window.gapi) return reject(new Error('gapi no carregat encara'));
      gapi.load('picker', { callback: () => { pickerReady = true; resolve(); }, onerror: reject });
    });
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    if (!window.google?.accounts?.oauth2) throw new Error('Google Identity Services no carregat');
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: () => {}, // s'assigna al vol
    });
    return tokenClient;
  }

  function requestToken() {
    return new Promise((resolve, reject) => {
      try {
        const tc = ensureTokenClient();
        tc.callback = (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          accessToken = resp.access_token;
          resolve(resp.access_token);
        };
        // Si ja tenim un token vàlid, l'aprofitem
        if (accessToken) return resolve(accessToken);
        tc.requestAccessToken({ prompt: '' });
      } catch (e) { reject(e); }
    });
  }

  async function showPicker(token) {
    await loadPicker();
    return new Promise((resolve) => {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setSelectFolderEnabled(false)
        .setIncludeFolders(true)
        .setMimeTypes([
          'model/gltf-binary',
          'model/gltf+json',
          'application/octet-stream',
          'text/plain',
          'application/json',
        ].join(','));
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .setAppId(CLIENT_ID.split('-')[0])
        .addView(view)
        .setTitle('Obrir des de Google Drive')
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            resolve(data.docs || []);
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve([]);
          }
        })
        .build();
      picker.setVisible(true);
    });
  }

  async function downloadFile(fileId, name) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!res.ok) throw new Error('Error descarregant ' + name + ': ' + res.status);
    const blob = await res.blob();
    // Convertim en File perquè handleFiles el tracti com un input normal
    return new File([blob], name || 'drive_file', { type: blob.type || 'application/octet-stream' });
  }

  async function openFromDrive() {
    try {
      const token = await requestToken();
      const docs = await showPicker(token);
      if (!docs.length) return;
      const files = [];
      for (const d of docs) {
        const f = await downloadFile(d.id, d.name);
        files.push(f);
      }
      // Passa els fitxers a la funció de càrrega existent, si està exposada.
      if (typeof window.handleFiles === 'function') {
        await window.handleFiles(files);
      } else {
        // fallback: simula un canvi al input
        const fi = document.getElementById('fileInput');
        if (fi) {
          const dt = new DataTransfer();
          for (const f of files) dt.items.add(f);
          fi.files = dt.files;
          fi.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          alert('No s\'ha pogut passar el fitxer a l\'app.');
        }
      }
    } catch (e) {
      log('error: ' + e.message);
      alert('Google Drive: ' + e.message);
    }
  }

  function bindButton() {
    const btn = document.getElementById('tbDrive');
    if (!btn) return;
    btn.addEventListener('click', openFromDrive);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButton);
  } else {
    bindButton();
  }
})();
