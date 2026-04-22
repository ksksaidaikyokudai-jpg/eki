// eki. — Phase A: Camera → Claude API → Location display

// ─────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────
const MODEL        = 'claude-sonnet-4-6';
const API_URL      = 'https://api.anthropic.com/v1/messages';
const KEY_APIKEY   = 'eki_apikey';
const KEY_TRAINING = 'eki_training';
const MAX_ENTRIES  = 50;

// ─────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────
const video          = document.getElementById('video');
const previewImg     = document.getElementById('preview-img');
const placeholder    = document.getElementById('camera-placeholder');
const startCameraBtn = document.getElementById('start-camera-btn');
const captureBtn     = document.getElementById('capture-btn');
const uploadBtn      = document.getElementById('upload-btn');
const fileInput      = document.getElementById('file-input');
const analyzingEl    = document.getElementById('analyzing');
const resultsPanel   = document.getElementById('results-panel');
const resultsContent = document.getElementById('results-content');
const closeBtn       = document.getElementById('close-btn');
const settingsBtn    = document.getElementById('settings-btn');
const settingsModal  = document.getElementById('settings-modal');
const apiKeyInput    = document.getElementById('api-key-input');
const saveKeyBtn     = document.getElementById('save-key-btn');

// ─────────────────────────────────────────────────────────
// 状態
// ─────────────────────────────────────────────────────────
let cameraActive        = false; // カメラストリームが有効かどうか
let uploadedImageBase64 = null;  // アップロードモード中の画像データ

// ─────────────────────────────────────────────────────────
// カメラ管理
// ─────────────────────────────────────────────────────────

// プレースホルダーにメッセージを表示してカメラビューを隠す
function showPlaceholder(title, detail, btnLabel = 'Start Camera') {
  video.style.display        = 'none';
  previewImg.style.display   = 'none';
  placeholder.style.display  = 'flex';
  document.getElementById('cam-err-title').textContent  = title;
  document.getElementById('cam-err-detail').textContent = detail;
  startCameraBtn.disabled    = false;
  startCameraBtn.textContent = btnLabel;
}

// カメラ起動 — iOS Safariではユーザー操作（click）内から呼ぶこと
// ページロード時に自動呼び出しすると iOS Safari で権限ダイアログが出ない
async function startCamera() {
  cameraActive = false;
  placeholder.style.display = 'flex';
  video.style.display       = 'none';
  startCameraBtn.disabled   = true;
  startCameraBtn.textContent = 'Starting…';
  document.getElementById('cam-err-title').textContent  = 'Starting camera…';
  document.getElementById('cam-err-detail').textContent = 'Allow camera access when prompted.';

  if (!navigator.mediaDevices?.getUserMedia) {
    showPlaceholder(
      'Camera not available',
      'Use a secure connection (https), or upload a photo with the 🖼️ button below.',
      'Retry'
    );
    return;
  }

  // getUserMedia は1回だけ await する
  // ループで複数回 await すると iOS Safari のジェスチャーコンテキストが失われる
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
  } catch (err) {
    const name = err.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      showPlaceholder(
        'Camera access denied',
        'Allow camera in Settings → Safari → Camera, or use the 🖼️ button to upload a photo.',
        'Retry'
      );
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      showPlaceholder(
        'No camera found',
        'No camera detected. Use the 🖼️ button to upload a photo.',
        'Retry'
      );
    } else {
      showPlaceholder(
        name || 'Camera error',
        (err.message || 'Unable to access camera.') + ' Use the 🖼️ button to upload a photo.',
        'Retry'
      );
    }
    return;
  }

  // video を先に表示してから srcObject を設定する
  // iOS Safari は display:none の要素で autoplay が動かないことがある
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  placeholder.style.display = 'none';
  video.style.display       = 'block';
  video.srcObject           = stream;

  // 映像が実際に始まったことを確認してから cameraActive をセット
  // 5秒以内に loadedmetadata が来なければエラー扱い
  const playTimeout = setTimeout(() => {
    if (!cameraActive) {
      stopStream(stream);
      showPlaceholder(
        'Camera timed out',
        'Video failed to start. Try again, or use the 🖼️ button to upload a photo.',
        'Retry'
      );
    }
  }, 5000);

  video.onloadedmetadata = () => {
    clearTimeout(playTimeout);
    video.play().catch(() => {});
    cameraActive = true;
    video.onloadedmetadata = null;
  };

  // すでにメタデータが揃っている場合（リトライ時など）
  if (video.readyState >= 1) {
    clearTimeout(playTimeout);
    video.play().catch(() => {});
    cameraActive = true;
    video.onloadedmetadata = null;
  }
}

// ストリームを安全に停止する
function stopStream(stream) {
  stream?.getTracks().forEach(t => t.stop());
}

// カメラフレームをbase64 JPEGとして取得
function captureFrame() {
  if (!cameraActive || video.videoWidth === 0) {
    throw new Error('Camera is not ready. Please start the camera first.');
  }
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

// ─────────────────────────────────────────────────────────
// 画像解析 — 独立関数（TODO: [フェーズC] RAG/ベクトルDBへ差し替え）
// ─────────────────────────────────────────────────────────
async function analyzeImage(imageBase64) {
  const apiKey = localStorage.getItem(KEY_APIKEY);
  if (!apiKey) throw new Error('API key not set. Tap ⚙️ to configure it.');

  const prompt = `You are an expert navigation assistant for major Japanese railway stations, \
specializing in barrier-free routes for tourists carrying large luggage or using wheelchairs.

Analyze this image and identify the current location inside a Japanese train station.

Respond with ONLY a valid JSON object — no markdown, no code fences:
{
  "station": "Shinjuku" | "Tokyo" | "Shibuya" | "Ikebukuro" | "Other" | "Unknown",
  "station_ja": "Japanese station name (e.g. 新宿駅)",
  "area": "specific area in English (gate, concourse, platform, etc.)",
  "confidence": "high" | "medium" | "low",
  "landmarks": ["visible sign or landmark 1", "visible sign or landmark 2"],
  "recommended_exit": "best exit name for someone with large luggage",
  "steps": [
    { "icon": "elevator" | "walk" | "turn_right" | "turn_left" | "straight" | "exit" | "escalator", "text": "step instruction" }
  ],
  "notes": "important info for accessibility or luggage"
}

Rules:
- Always prefer elevator routes over stairs or escalators
- If image is not a train station, set confidence "low" and explain in notes
- Provide 3–6 clear steps; use signs visible in the image to improve accuracy
- Keep each step short and action-oriented`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }

  const data  = await res.json();
  const raw   = data.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Unexpected response format from AI.');
  return JSON.parse(match[0]);
}

// ─────────────────────────────────────────────────────────
// 訓練データ保存（TODO: [フェーズB] 正解ラベル付けUIと連携）
// ─────────────────────────────────────────────────────────
function saveTrainingEntry(result) {
  const entries = JSON.parse(localStorage.getItem(KEY_TRAINING) || '[]');
  entries.push({ id: Date.now(), timestamp: new Date().toISOString(), result, correct: null });
  if (entries.length > MAX_ENTRIES) entries.shift();
  localStorage.setItem(KEY_TRAINING, JSON.stringify(entries));
}

// ─────────────────────────────────────────────────────────
// アップロード処理
// ─────────────────────────────────────────────────────────
function handleUploadClick() {
  fileInput.click();
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    uploadedImageBase64 = dataUrl.split(',')[1];

    // プレビュー表示（カメラ・プレースホルダーを隠す）
    video.style.display       = 'none';
    placeholder.style.display = 'none';
    previewImg.src             = dataUrl;
    previewImg.style.display  = 'block';
  };
  reader.readAsDataURL(file);
  fileInput.value = ''; // 同じファイルを再選択できるようリセット
});

// ─────────────────────────────────────────────────────────
// 撮影／アップロード → 解析フロー
// ─────────────────────────────────────────────────────────
async function handleCapture() {
  captureBtn.disabled = true;
  captureBtn.classList.add('loading');
  analyzingEl.classList.add('on');
  resultsPanel.classList.remove('open');

  try {
    // アップロード画像があればそちらを優先、なければカメラフレームを取得
    const img    = uploadedImageBase64 ?? captureFrame();
    const result = await analyzeImage(img);
    saveTrainingEntry(result);
    renderResult(result);
  } catch (err) {
    renderError(err.message || 'Something went wrong. Please try again.');
  } finally {
    captureBtn.disabled = false;
    captureBtn.classList.remove('loading');
    analyzingEl.classList.remove('on');
  }
}

// ─────────────────────────────────────────────────────────
// 結果表示
// ─────────────────────────────────────────────────────────
const ICONS = {
  elevator:   '🛗',
  escalator:  '↗️',
  walk:       '🚶',
  turn_right: '➡️',
  turn_left:  '⬅️',
  straight:   '⬆️',
  exit:       '🚪',
  stairs:     '🪜',
};

function renderResult(r) {
  const stepsHTML = (r.steps || []).map(s => `
    <div class="step">
      <div class="step-icon">${ICONS[s.icon] || '📍'}</div>
      <div class="step-text">${esc(s.text)}</div>
    </div>`).join('');

  const landmarkText = r.landmarks?.length
    ? `<div class="landmarks">Visible: ${r.landmarks.map(esc).join(' · ')}</div>` : '';

  resultsContent.innerHTML = `
    <div class="station-row">
      <div class="conf-dot ${r.confidence}"></div>
      <span class="station-name">${r.station !== 'Unknown' ? esc(r.station) + ' Station' : 'Unknown Station'}</span>
      ${r.station_ja ? `<span class="station-ja">${esc(r.station_ja)}</span>` : ''}
    </div>

    <div class="area-title">${esc(r.area || 'Location identified')}</div>

    ${r.recommended_exit ? `
    <div class="exit-card">
      <div class="exit-label">🧳 Recommended Exit</div>
      <div class="exit-name">${esc(r.recommended_exit)}</div>
    </div>` : ''}

    ${landmarkText}

    ${stepsHTML.length ? `<div class="steps-label">Directions</div>${stepsHTML}` : ''}

    ${r.notes ? `<div class="notes">ℹ️ ${esc(r.notes)}</div>` : ''}
  `;

  resultsPanel.classList.add('open');
}

function renderError(msg) {
  resultsContent.innerHTML = `<div class="err">⚠️<br><br>${esc(msg)}</div>`;
  resultsPanel.classList.add('open');
}

// XSSエスケープ
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────
// 設定
// ─────────────────────────────────────────────────────────
function openSettings() {
  apiKeyInput.value = localStorage.getItem(KEY_APIKEY) || '';
  settingsModal.classList.add('open');
  setTimeout(() => apiKeyInput.focus(), 100);
}

function saveSettings() {
  const key = apiKeyInput.value.trim();
  if (!key) { alert('Please enter a valid API key.'); return; }
  localStorage.setItem(KEY_APIKEY, key);
  settingsModal.classList.remove('open');
}

// ─────────────────────────────────────────────────────────
// イベント登録
// ─────────────────────────────────────────────────────────
captureBtn.addEventListener('click', handleCapture);
uploadBtn.addEventListener('click', handleUploadClick);
startCameraBtn.addEventListener('click', startCamera);

closeBtn.addEventListener('click', () => {
  resultsPanel.classList.remove('open');
  // アップロードプレビューが出ていた場合は元のビューに戻す
  if (uploadedImageBase64) {
    uploadedImageBase64      = null;
    previewImg.style.display = 'none';
    previewImg.src           = '';
  }
  // 常にカメラ状態に合わせてビューを復元
  if (cameraActive) {
    placeholder.style.display = 'none';
    video.style.display       = 'block';
  } else {
    showPlaceholder('Tap to start camera', 'Allow camera access when prompted.');
  }
});

settingsBtn.addEventListener('click', openSettings);
saveKeyBtn.addEventListener('click', saveSettings);
settingsModal.addEventListener('click', e => {
  if (e.target === settingsModal) settingsModal.classList.remove('open');
});
apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings(); });

// ─────────────────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────────────────
function init() {
  // iOS Safari: getUserMedia はユーザー操作内からのみ許可される
  // → プレースホルダーを表示してボタンタップを待つ
  // デスクトップ: ページロード時に自動起動
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isIOS) {
    showPlaceholder('Tap to start camera', 'Allow camera access when prompted.');
  } else {
    startCamera();
  }

  // APIキー未設定なら起動直後に設定を開く
  if (!localStorage.getItem(KEY_APIKEY)) {
    setTimeout(openSettings, 600);
  }
}

init();
