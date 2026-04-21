// eki. — Phase A: Camera → Claude API → Location display

const MODEL           = 'claude-sonnet-4-6';
const API_URL         = 'https://api.anthropic.com/v1/messages';
const KEY_APIKEY      = 'eki_apikey';
const KEY_TRAINING    = 'eki_training';
const MAX_ENTRIES     = 50;

// DOM refs
const video          = document.getElementById('video');
const previewImg     = document.getElementById('preview-img');
const placeholder    = document.getElementById('camera-placeholder');
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

// アップロードモード中は画像base64をここに保持
let uploadedImageBase64 = null;

// ─────────────────────────────────────────────────────────
// カメラ初期化（段階的フォールバック・Safari対応）
// ─────────────────────────────────────────────────────────
async function initCamera() {
  // iOS Safari など mediaDevices 未対応ブラウザのガード
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError('NotSupportedError');
    return;
  }

  // 試す制約を順番に定義（厳しい順）
  const attempts = [
    { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    { facingMode: { ideal: 'environment' } },
    { facingMode: 'environment' },  // Safari は文字列指定を好む場合がある
    { facingMode: 'user' },
    true, // 制約なし
  ];

  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      video.srcObject = stream;
      // iOS Safari は autoplay だけでは再生されないため明示的に呼ぶ
      await video.play();
      video.style.display = 'block';
      placeholder.style.display = 'none';
      return;
    } catch {
      // 次の制約を試す
    }
  }

  // 全て失敗 — エラー種別に応じたメッセージ
  try {
    await navigator.mediaDevices.getUserMedia({ video: true });
  } catch (err) {
    showCameraError(err.name);
  }
}

function showCameraError(errName) {
  video.style.display = 'none';
  placeholder.style.display = 'flex';
  const title  = document.getElementById('cam-err-title');
  const detail = document.getElementById('cam-err-detail');
  if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
    title.textContent  = 'Camera permission denied';
    detail.textContent = 'Allow camera access in browser settings, then reload';
  } else if (errName === 'NotFoundError') {
    title.textContent  = 'No camera found';
    detail.textContent = 'Use 🖼️ to upload a photo instead';
  } else if (errName === 'NotSupportedError' || errName === 'SecurityError') {
    title.textContent  = 'Camera blocked';
    detail.textContent = 'HTTPS required — check the URL starts with https://';
  } else {
    title.textContent  = 'Camera unavailable';
    detail.textContent = 'Use 🖼️ to upload a photo instead';
  }
}

// ─────────────────────────────────────────────────────────
// フレームをbase64 JPEGとして取得
// ─────────────────────────────────────────────────────────
function captureFrame() {
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
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
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }

  const data = await res.json();
  const raw  = data.content[0].text.trim();

  // JSONブロックを確実に抽出
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
// アイコンマッピング
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

// ─────────────────────────────────────────────────────────
// 結果表示
// ─────────────────────────────────────────────────────────
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

function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────
// 画像アップロード処理
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

    // カメラを隠してプレビュー表示
    video.style.display = 'none';
    placeholder.style.display = 'none';
    previewImg.src = dataUrl;
    previewImg.style.display = 'block';
  };
  reader.readAsDataURL(file);
  fileInput.value = ''; // 同じファイルを再選択できるようリセット
});

// ─────────────────────────────────────────────────────────
// 撮影/アップロード → 解析フロー
// ─────────────────────────────────────────────────────────
async function handleCapture() {
  captureBtn.disabled = true;
  captureBtn.classList.add('loading');
  analyzingEl.classList.add('on');
  resultsPanel.classList.remove('open');

  try {
    // アップロード画像があればそちらを優先
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
// イベント
// ─────────────────────────────────────────────────────────
captureBtn.addEventListener('click', handleCapture);
uploadBtn.addEventListener('click', handleUploadClick);
closeBtn.addEventListener('click', () => {
  resultsPanel.classList.remove('open');
  // カメラビューに戻す
  if (uploadedImageBase64) {
    uploadedImageBase64 = null;
    previewImg.style.display = 'none';
    previewImg.src = '';
    video.style.display = 'block';
  }
});
settingsBtn.addEventListener('click', openSettings);
saveKeyBtn.addEventListener('click', saveSettings);
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

// Enterキーで保存
apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings(); });

// ─────────────────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────────────────
initCamera();

// APIキー未設定なら起動直後に設定を開く
if (!localStorage.getItem(KEY_APIKEY)) {
  setTimeout(openSettings, 600);
}
