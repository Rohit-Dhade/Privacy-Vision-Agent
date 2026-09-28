/**
 * tools/verify-redaction-proof.js
 *
 * Logic for tools/verify-redaction-proof.html.
 *
 * WHY THIS IS A SEPARATE FILE: it used to be an inline <script> inside the
 * HTML page. That works when the page is opened straight from disk
 * (file://), but the extension's "Open Independent Verifier" button opens
 * it as chrome-extension://.../tools/verify-redaction-proof.html, and
 * Manifest V3's Content Security Policy for extension pages
 * (script-src 'self' — see manifest.json) blocks ALL inline scripts there.
 * The page rendered, but the Verify button had no handler, so pasting a
 * proof and clicking Verify did nothing. External scripts from the
 * extension's own origin are allowed, so the fix is simply this file.
 *
 * The verification itself is utils/merkleProof.js's verifyRedactionProof()
 * — the exact same file the extension uses to generate proofs. Nothing
 * here talks to the network.
 */
(function () {
  const els = {
    input: document.getElementById('proofInput'),
    file: document.getElementById('proofFile'),
    btn: document.getElementById('verifyBtn'),
    loadLatest: document.getElementById('loadLatestBtn'),
    tamper: document.getElementById('tamperBtn'),
    loadNote: document.getElementById('loadNote'),
    result: document.getElementById('result'),
  };

  const REQUIRED_FIELDS = [
    'version', 'algorithm', 'timestamp', 'tileSize', 'gridWidth', 'gridHeight',
    'totalTiles', 'merkleRoot', 'redactedTileCount', 'redactedTileIndices',
    'redactedTiles', 'signature', 'publicKeyJwk',
  ];

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  /** Accepts the downloaded proof as-is, and also the common "I pasted
   *  something that CONTAINS the proof" cases (an object with a
   *  redactionProof/proof field, or an array of proofs — first one wins). */
  function findProof(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 4) return null;
    if (!Array.isArray(value) && typeof value.merkleRoot === 'string' && Array.isArray(value.redactedTiles)) return value;
    const candidates = Array.isArray(value)
      ? value
      : [value.redactionProof, value.proof, value.latestRedactionProof, ...Object.values(value)];
    for (const c of candidates) {
      const found = findProof(c, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function showCard(html) {
    els.result.style.display = 'block';
    els.result.innerHTML = `<div class="card">${html}</div>`;
  }

  function parseInput() {
    const raw = (els.input.value || '').trim();
    if (!raw) {
      showCard('<span class="badge badge-fail">✗ NOTHING TO VERIFY</span><div class="errlist">Paste the downloaded redaction-proof-*.json content, or choose the file.</div>');
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      showCard(`<span class="badge badge-fail">✗ INVALID JSON</span><div class="errlist">${escapeHtml(e.message)}. Make sure you pasted the whole file, including the first "{" and the last "}".</div>`);
      return null;
    }
    const proof = findProof(parsed);
    if (!proof) {
      const missing = REQUIRED_FIELDS.filter((f) => !(parsed && typeof parsed === 'object' && f in parsed));
      showCard(`<span class="badge badge-fail">✗ NOT A REDACTION PROOF</span><div class="errlist">This JSON is valid, but it is not a redaction proof. Missing: ${escapeHtml(missing.join(', '))}. Use the file from "Download Redaction Proof (JSON)" in the Privacy Proof tab (not the Privacy Receipt or page summary).</div>`);
      return null;
    }
    const missing = REQUIRED_FIELDS.filter((f) => !(f in proof));
    if (missing.length) {
      showCard(`<span class="badge badge-fail">✗ INCOMPLETE PROOF</span><div class="errlist">Missing field(s): ${escapeHtml(missing.join(', '))}. The file may have been truncated or edited.</div>`);
      return null;
    }
    return proof;
  }

  async function verifyAndRender(proof, { tamperNote = '' } = {}) {
    if (typeof window.__BA_MerkleProof === 'undefined') {
      showCard('<span class="badge badge-fail">✗ VERIFIER LIBRARY MISSING</span><div class="errlist">../utils/merkleProof.js did not load — keep this file\'s folder structure intact (tools/ next to utils/).</div>');
      return;
    }
    if (!window.crypto || !window.crypto.subtle) {
      showCard('<span class="badge badge-fail">✗ WEB CRYPTO UNAVAILABLE</span><div class="errlist">This browser context has no crypto.subtle. Open this page from the extension, from https://, or from a local file in Chrome.</div>');
      return;
    }
    els.btn.disabled = true;
    els.btn.textContent = 'Verifying…';
    try {
      const v = await window.__BA_MerkleProof.verifyRedactionProof(proof);
      const badge = v.overallValid
        ? '<span class="badge badge-pass">✓ PROOF VALID</span>'
        : '<span class="badge badge-fail">✗ PROOF INVALID</span>';
      const tilesHtml = (v.tileResults || []).map((t) =>
        `<div class="tile ${t.valid ? 'tile-ok' : 'tile-bad'}" title="tile ${t.index} (row ${t.row}, col ${t.col}): ${t.valid ? 'valid' : 'INVALID'}"></div>`
      ).join('');
      const zeroNote = (proof.redactedTileCount === 0)
        ? '<div class="hint">This screenshot had nothing to redact, so there are no tiles to prove — the signature over the commitment is still checked.</div>'
        : '';
      showCard(`
        ${tamperNote ? `<div class="tamper-note">${escapeHtml(tamperNote)}</div>` : ''}
        ${badge}
        <div class="row"><span class="row-label">Signature valid</span><span class="row-val ${v.signatureValid ? 'ok' : 'bad'}">${v.signatureValid ? 'YES' : 'NO'}</span></div>
        <div class="row"><span class="row-label">All inclusion proofs valid</span><span class="row-val ${v.inclusionProofsValid ? 'ok' : 'bad'}">${v.inclusionProofsValid ? 'YES' : 'NO'}</span></div>
        <div class="row"><span class="row-label">Merkle root</span><span class="row-val">${escapeHtml((proof.merkleRoot || '').slice(0, 24))}…</span></div>
        <div class="row"><span class="row-label">Redacted tiles proven</span><span class="row-val">${(v.tileResults || []).filter((t) => t.valid).length} / ${escapeHtml(proof.redactedTileCount ?? '?')}</span></div>
        <div class="row"><span class="row-label">Screenshot grid</span><span class="row-val">${escapeHtml(proof.gridWidth ?? '?')} × ${escapeHtml(proof.gridHeight ?? '?')} tiles (${escapeHtml(proof.tileSize ?? '?')}px each)</span></div>
        <div class="row"><span class="row-label">Committed at</span><span class="row-val">${proof.timestamp ? escapeHtml(new Date(proof.timestamp).toLocaleString()) : '?'}</span></div>
        ${v.errors && v.errors.length ? `<div class="errlist">${v.errors.map(escapeHtml).join('<br>')}</div>` : ''}
        ${zeroNote}
        <div class="tiles">${tilesHtml}</div>
      `);
      return v;
    } catch (err) {
      showCard(`<span class="badge badge-fail">✗ VERIFICATION ERROR</span><div class="errlist">${escapeHtml(err.message)}</div>`);
      return null;
    } finally {
      els.btn.disabled = false;
      els.btn.textContent = 'Verify Proof';
    }
  }

  els.file.addEventListener('change', async () => {
    const file = els.file.files[0];
    if (!file) return;
    els.input.value = await file.text();
    els.tamper.disabled = false;
  });

  els.input.addEventListener('input', () => { els.tamper.disabled = !els.input.value.trim(); });

  els.btn.addEventListener('click', async () => {
    const proof = parseInput();
    if (proof) await verifyAndRender(proof);
  });

  // Demonstrates the property judges care about: change ONE character of
  // a signed field and verification must fail. Works on a copy — the
  // pasted proof is left untouched.
  els.tamper.addEventListener('click', async () => {
    const proof = parseInput();
    if (!proof) return;
    const copy = JSON.parse(JSON.stringify(proof));
    let note;
    if (Array.isArray(copy.redactedTiles) && copy.redactedTiles.length > 0) {
      const h = copy.redactedTiles[0].leafHash || '';
      copy.redactedTiles[0].leafHash = (h[0] === '0' ? '1' : '0') + h.slice(1);
      note = `Tamper test: changed 1 hex character of tile ${copy.redactedTiles[0].index}'s hash in a copy of this proof. A correct verifier must now report INVALID.`;
    } else {
      copy.timestamp = Number(copy.timestamp) + 1;
      note = 'Tamper test: changed the signed timestamp by 1 ms in a copy of this proof. A correct verifier must now report INVALID.';
    }
    await verifyAndRender(copy, { tamperNote: note });
  });

  // Convenience when opened from the extension: popup.js stashes the most
  // recent proof in chrome.storage.session right before opening this page.
  // The verification that follows is exactly the same as for a pasted file.
  const session = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) ? chrome.storage.session : null;
  if (session) {
    session.get('pvLatestRedactionProof').then((res) => {
      const latest = res && res.pvLatestRedactionProof;
      if (!latest) return;
      els.loadLatest.hidden = false;
      els.loadLatest.addEventListener('click', () => {
        els.input.value = JSON.stringify(latest, null, 2);
        els.tamper.disabled = false;
        els.loadNote.textContent = 'Loaded the latest proof from the extension. You can also paste a downloaded file instead — the check is identical.';
      });
    }).catch(() => {});
  }
})();
