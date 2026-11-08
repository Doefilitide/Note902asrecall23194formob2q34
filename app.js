/**
 * NoteRecall Mobile PWA Application
 * 100% Offline Active Recall Engine with Exact Desktop Parity.
 */

(function () {
  'use strict';

  // ── App State ────────────────────────────────────────────────
  const state = {
    pack: null,               // Active loaded pack object
    reviews: [],              // All recorded reviews for active pack
    reviewQueue: [],          // Active cards in study queue
    scopeTotalCards: 0,       // Total cards in this session scope
    completedInScope: 0,      // Successfully completed cards in scope
    activeCard: null,         // Current card at index 0
    revealed: false,          // Answer revealed state
    hintLevel: 0,             // Current hint expansion level
    cardStartTime: 0,         // Timestamp when card appeared
    recallLatencySec: null,   // Milliseconds elapsed to reveal
    manuallyRevealed: new Set(), // Locally unmasked cloze IDs
    reviewOrder: 'folder',    // 'folder' (sequential) or 'mixed'
    focusMode: 'isolated',    // 'isolated' (Card Focus) or 'full' (Full Note)
    currentScopePath: null,   // Folder path string being studied, or null for all
    folderQueueIndex: 0,      // Index in folder-by-folder progression
    folderGroups: [],         // Array of { folderPath, cards }
    lastActionSnapshot: null, // For Undo support

    // Adaptive Timer State
    timerEnabled: false,
    isAdaptive: false,
    baseTimerSec: 0,
    currentTimerSec: 0,
    timeLeft: 0,
    timerInterval: null,
    timerExpired: false,
    adaptiveStep: 2,
    adaptiveMin: 5
  };

  // ── Hub Base URL for Universal / GitHub Pages Hosting ────────
  function getHubUrl(endpoint) {
    let hub = localStorage.getItem('nr_laptop_hub_url') || '';
    if (!hub) return endpoint;
    hub = hub.replace(/\/+$/, '');
    return hub + endpoint;
  }

  // Parse ?hub= from URL if opened via QR or direct link
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const hubParam = urlParams.get('hub');
    if (hubParam) {
      localStorage.setItem('nr_laptop_hub_url', hubParam.trim().replace(/\/+$/, ''));
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  } catch (e) {}

  // DOM Elements
  const $main = document.getElementById('mainContainer');
  const $btnLoadPack = document.getElementById('btnLoadPack');
  const $btnExportLog = document.getElementById('btnExportLog');
  const $fileInput = document.getElementById('fileInput');
  const $swipeFlash = document.getElementById('swipeFlash');

  // Interactive Toast Notifications
  let toastTimer = null;
  function showToast(msg, duration = 3000) {
    const $toast = document.getElementById('pwaToast');
    if (!$toast) return;
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $toast.classList.remove('show');
    }, duration);
  }

  function updateSyncStatusUI(status, count) {
    const $badge = document.getElementById('syncStatusBadge');
    if (!$badge) return;
    if (status === 'synced') {
      $badge.className = 'badge badge-synced';
      $badge.textContent = '🟢 Synced';
      $badge.title = 'All reviews are synced with laptop';
    } else if (status === 'offline') {
      $badge.className = 'badge badge-pending';
      const c = (count !== undefined) ? count : (state.reviews ? state.reviews.length : 0);
      $badge.textContent = `🟡 Offline (${c})`;
      $badge.title = `${c} review(s) stored on phone. Will sync automatically when connected to laptop.`;
    } else if (status === 'syncing') {
      $badge.className = 'badge';
      $badge.textContent = '⚡ Syncing...';
      $badge.title = 'Syncing reviews with laptop hub';
    }
  }

  // ── Initialization ───────────────────────────────────────────
  async function init() {
    setupGlobalEvents();
    const savedPack = await window.NoteRecallDB.getActivePack();
    if (savedPack) {
      state.pack = savedPack;
      state.reviews = await window.NoteRecallDB.getReviewsForPack(savedPack.packId);

      const ps = savedPack.settings || {};
      const savedTimer = localStorage.getItem('nr_pwa_timer_sec');
      const savedAdaptive = localStorage.getItem('nr_pwa_adaptive_timer');
      state.baseTimerSec = savedTimer !== null ? (parseInt(savedTimer, 10) || 0) : (ps.reviewTimerSec || 0);
      state.isAdaptive = savedAdaptive !== null ? (savedAdaptive === 'true') : !!ps.adaptiveTimer;
      state.adaptiveStep = ps.adaptiveTimerStep || 2;
      state.adaptiveMin = ps.adaptiveTimerMin || 5;
      state.currentTimerSec = state.baseTimerSec;
      state.timerEnabled = state.baseTimerSec > 0;

      renderHome();
      // Catch up any reviews completed on other devices (Phone ⇄ iPad)
      if (navigator.onLine) {
        syncActiveReviewsWithHub();
      } else {
        updateSyncStatusUI('offline', state.reviews.length);
      }
    } else {
      // Try fetching latest pack from desktop companion if on Wi-Fi
      fetchLatestPackFromDesktop().then(async pack => {
        if (pack) {
          await loadPackData(pack);
          syncActiveReviewsWithHub();
        } else {
          renderEmptyState();
        }
      }).catch(() => renderEmptyState());
    }
  }

  function setupGlobalEvents() {
    $btnLoadPack.onclick = () => $fileInput.click();
    $fileInput.onchange = handleFileSelect;
    $btnExportLog.onclick = () => exportReviewLog(true);

    // Gesture listeners for swipe-to-reveal and swipe-to-grade
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    // Catch up when device is unlocked or app tab is switched to
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkLaptopForPack();
        if (state.pack) {
          autoSyncReviewsToHub();
          syncActiveReviewsWithHub();
        }
      }
    });
    window.addEventListener('focus', () => {
      checkLaptopForPack();
      if (state.pack) {
        autoSyncReviewsToHub();
        syncActiveReviewsWithHub();
      }
    });

    // Auto-sync when reconnecting to Wi-Fi / coming online
    window.addEventListener('online', () => {
      console.log('[NoteRecall PWA] Device reconnected to network.');
      showToast('📶 Reconnected! Syncing with laptop...');
      checkLaptopForPack();
      if (state.pack) {
        autoSyncReviewsToHub();
        syncActiveReviewsWithHub();
      }
    });

    window.addEventListener('offline', () => {
      console.log('[NoteRecall PWA] Device went offline.');
      updateSyncStatusUI('offline');
      showToast('✈️ Offline mode active. All reviews saved locally.');
    });

    // Background local Wi-Fi auto-sync:
    // 1. Poll for newly exported packs from laptop every 4 seconds
    setInterval(checkLaptopForPack, 4000);
    // 2. Auto-return completed reviews to laptop every 10 seconds
    setInterval(autoSyncReviewsToHub, 10000);
    // Initial check right after boot
    setTimeout(checkLaptopForPack, 1000);
  }

  // ── Pack Loading & Parsing ───────────────────────────────────
  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const pack = JSON.parse(event.target.result);
        if (!pack || !Array.isArray(pack.cards)) {
          alert('Invalid pack format: Missing cards array.');
          return;
        }
        await loadPackData(pack);
      } catch (err) {
        alert('Failed to parse pack JSON: ' + err.message);
      }
    };
    reader.readAsText(file);
    $fileInput.value = '';
  }

  async function loadPackData(pack) {
    state.pack = pack;
    await window.NoteRecallDB.savePack(pack);
    state.reviews = await window.NoteRecallDB.getReviewsForPack(pack.packId);

    // Initialize Timer Settings from pack or mobile localStorage overrides
    const ps = pack.settings || {};
    const savedTimer = localStorage.getItem('nr_pwa_timer_sec');
    const savedAdaptive = localStorage.getItem('nr_pwa_adaptive_timer');
    if (savedTimer !== null) {
      state.baseTimerSec = parseInt(savedTimer, 10) || 0;
    } else {
      state.baseTimerSec = ps.reviewTimerSec || 0;
    }
    if (savedAdaptive !== null) {
      state.isAdaptive = savedAdaptive === 'true';
    } else {
      state.isAdaptive = !!ps.adaptiveTimer;
    }
    state.adaptiveStep = ps.adaptiveTimerStep || 2;
    state.adaptiveMin = ps.adaptiveTimerMin || 5;
    state.currentTimerSec = state.baseTimerSec;
    state.timerEnabled = state.baseTimerSec > 0;

    renderHome();
    updateSyncStatusUI('synced');
    showToast(`📦 Pack loaded: ${pack.cards ? pack.cards.length : 0} cards ready offline!`);
  }

  // ── Local Wi-Fi Auto-Sync Engine (Pack Detection & Auto-Return) ─
  let discoveredPackMeta = null;
  let lastSyncedReviewCount = 0;

  async function checkLaptopForPack() {
    if (!navigator.onLine) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(getHubUrl('/api/pack/meta'), { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.ok || !data.packId) {
        hideNewPackBanner();
        return;
      }

      // If no pack is currently loaded at all, auto-fetch and load immediately!
      if (!state.pack) {
        const pack = await fetchLatestPackFromDesktop();
        if (pack && pack.packId === data.packId) {
          await loadPackData(pack);
          syncActiveReviewsWithHub();
          showToast(`⚡ Auto-loaded ${data.cardCount || 0} cards from laptop!`);
        }
        return;
      }

      // If a new pack is available that is different from currently loaded pack
      if (state.pack.packId !== data.packId) {
        discoveredPackMeta = data;
        showNewPackBanner(data);
      } else {
        hideNewPackBanner();
      }
    } catch (e) {
      // Hub unreachable (offline / away from WiFi)
    }
  }

  function showNewPackBanner(meta) {
    const banner = document.getElementById('newPackBanner');
    if (!banner) return;
    banner.innerHTML = `
      <div class="new-pack-banner-info">
        <span style="font-size: 20px;">📦</span>
        <div>
          <div class="new-pack-banner-title">New deck ready from laptop</div>
          <div class="new-pack-banner-sub">${meta.cardCount || 'Multiple'} cards available to study</div>
        </div>
      </div>
      <div class="new-pack-banner-actions">
        <button class="btn btn-primary" onclick="window.NoteRecallMobile.loadDiscoveredPack()" style="padding: 6px 12px; font-size: 12px;">Load Deck</button>
        <button class="btn btn-secondary" onclick="window.NoteRecallMobile.dismissDiscoveredPack()" style="padding: 6px 10px; font-size: 12px;">Dismiss</button>
      </div>
    `;
    banner.style.display = 'flex';
  }

  function hideNewPackBanner() {
    const banner = document.getElementById('newPackBanner');
    if (banner) banner.style.display = 'none';
  }

  async function loadDiscoveredPack() {
    hideNewPackBanner();
    showToast('⏳ Downloading pack from laptop...');
    const pack = await fetchLatestPackFromDesktop();
    if (pack) {
      await loadPackData(pack);
      syncActiveReviewsWithHub();
      showToast(`✅ Loaded ${pack.cards ? pack.cards.length : 0} cards from laptop!`);
    } else {
      showToast('❌ Failed to download pack from laptop.');
    }
  }

  function dismissDiscoveredPack() {
    hideNewPackBanner();
  }

  async function autoSyncReviewsToHub() {
    if (!state.pack || !navigator.onLine) return;
    try {
      const reviews = await window.NoteRecallDB.getReviewsForPack(state.pack.packId);
      if (reviews.length === 0 || reviews.length === lastSyncedReviewCount) return;

      const payload = {
        version: 1,
        packId: state.pack.packId,
        exportedAt: new Date().toISOString(),
        device: 'NoteRecall-Mobile-PWA',
        reviewCount: reviews.length,
        reviews: reviews.map(r => ({
          cardId: r.cardId,
          grade: r.grade,
          timestamp: r.timestamp,
          latencyMs: r.latencyMs,
          hintUsed: !!r.hintUsed
        }))
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(getHubUrl('/api/pack/log'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        lastSyncedReviewCount = reviews.length;
        updateSyncStatusUI('synced');
        showToast(`⚡ ${reviews.length} reviews auto-synced with laptop`);
      }
    } catch (e) {
      // Laptop not reachable
    }
  }

  async function fetchLatestPackFromDesktop() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(getHubUrl('/api/pack/latest'), { cache: 'no-cache', signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {}
    return null;
  }

  // ── Tree & Progress Calculations ────────────────────────────
  function getReviewedCardIds() {
    const set = new Set();
    state.reviews.forEach(r => {
      // If card was successfully graded (>= 2) in this pack
      if (r.grade >= 2) set.add(r.cardId);
    });
    return set;
  }

  function buildFolderTree() {
    if (!state.pack || !state.pack.cards) return null;
    const reviewedSet = getReviewedCardIds();
    const root = { name: 'All Cards', path: '', children: {}, total: 0, due: 0, cards: [] };

    state.pack.cards.forEach(card => {
      const isDone = reviewedSet.has(card.id);
      root.total++;
      if (!isDone) root.due++;

      const folderParts = Array.isArray(card.folderPath) && card.folderPath.length > 0
        ? card.folderPath
        : ['Uncategorized'];

      let curr = root;
      let pathAccum = '';
      folderParts.forEach((part, idx) => {
        pathAccum = pathAccum ? `${pathAccum} > ${part}` : part;
        if (!curr.children[part]) {
          curr.children[part] = {
            name: part,
            path: pathAccum,
            children: {},
            total: 0,
            due: 0,
            cards: []
          };
        }
        curr = curr.children[part];
        curr.total++;
        if (!isDone) curr.due++;
      });
      curr.cards.push(card);
    });

    return root;
  }

  // ── Render Views ─────────────────────────────────────────────
  function renderEmptyState() {
    $main.innerHTML = `
      <div class="home-scroll">
        <div class="pack-card" style="text-align:center; padding: 36px 20px;">
          <div style="font-size: 48px; margin-bottom: 12px;">📦</div>
          <h2 style="font-size: 20px; font-weight: 800; margin-bottom: 8px;">No Review Pack Loaded</h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 20px; line-height: 1.6;">
            On your laptop NoteRecall, click <b>"📦 Pack"</b> on the top bar to export today's cards. If you're on the same Wi-Fi, it will load here automatically!
          </p>
          <div style="display:flex; flex-direction:column; gap:10px; align-items:center;">
            <button class="btn btn-primary" onclick="window.NoteRecallMobile && window.NoteRecallMobile.retryFetchPack()" style="padding: 12px 24px; font-size: 15px;">
              🔄 Check Laptop for Pack
            </button>
            <button class="btn btn-secondary" onclick="document.getElementById('fileInput').click()" style="padding: 10px 20px; font-size: 14px;">
              📂 Or Load pack.json manually
            </button>
          </div>
          <div style="margin-top: 24px; padding: 14px; background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.2); border-radius: 10px; text-align: left; font-size: 12px; line-height: 1.6; color: var(--text-secondary);">
            <b style="color: var(--accent);">✈️ 100% Offline Study Tips:</b><br>
            1. Load your pack while connected to your laptop at home.<br>
            2. Once loaded, all cards are stored safely inside your phone.<br>
            3. You can leave home, turn off Wi-Fi, and study completely offline!<br>
            4. When you return home to your Wi-Fi, your reviews will auto-sync back to your laptop.
          </div>
        </div>
      </div>
    `;
  }

  function renderHome() {
    const tree = buildFolderTree();
    if (!tree) return renderEmptyState();

    const reviewedCount = getReviewedCardIds().size;
    const totalCount = state.pack.cards.length;
    const remainingCount = totalCount - reviewedCount;
    const pct = totalCount > 0 ? Math.round((reviewedCount / totalCount) * 100) : 0;
    const exportDate = new Date(state.pack.exportedAt).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    $main.innerHTML = `
      <div class="home-scroll">
        <!-- Pack Overview Card -->
        <div class="pack-card">
          <div class="pack-header">
            <div>
              <div class="pack-title">📦 ${escapeHtml(state.pack.title || 'Study Pack')}</div>
              <div style="font-size: 11px; color: var(--text-secondary);">Exported ${exportDate}</div>
            </div>
            <button class="btn btn-secondary" onclick="window.NoteRecallMobile.clearPackPrompt()" style="font-size: 11px; padding: 4px 8px;">✕ Clear</button>
          </div>

          <div class="pack-stats">
            <div><strong>${remainingCount}</strong> Due</div>
            <div><strong>${reviewedCount}</strong> Done</div>
            <div><strong>${totalCount}</strong> Total</div>
            <div style="margin-left: auto; color: var(--accent); font-weight: 700;">${pct}%</div>
          </div>

          <div class="tree-progress" style="height: 6px; border-radius: 4px; overflow: hidden;">
            <div class="tree-progress-fill" style="width: ${pct}%;"></div>
          </div>

          <!-- Study Order Controls -->
          <div style="display:flex; align-items:center; justify-content:space-between; margin-top: 4px;">
            <span style="font-size: 12px; font-weight: 600; color: var(--text-secondary);">Study Mode:</span>
            <div class="segmented-control">
              <button class="${state.reviewOrder === 'folder' ? 'active' : ''}" onclick="window.NoteRecallMobile.setOrder('folder')">📁 By Folder</button>
              <button class="${state.reviewOrder === 'mixed' ? 'active' : ''}" onclick="window.NoteRecallMobile.setOrder('mixed')">🔀 Mixed</button>
            </div>
          </div>

          <!-- Review All Due Button -->
          ${remainingCount > 0 ? `
            <button class="btn btn-primary" onclick="window.NoteRecallMobile.startReview('')" style="padding: 12px; font-size: 15px; margin-top: 4px;">
              ⚡ Review All Due (${remainingCount} cards)
            </button>
          ` : `
            <div style="text-align: center; color: var(--success); font-weight: 700; font-size: 14px; padding: 8px;">
              🎉 All cards in this pack completed!
            </div>
          `}
        </div>

        <!-- Folder Hierarchy -->
        <div style="font-size: 13px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">
          Folders & Subtopics
        </div>

        <div class="folder-tree">
          ${renderTreeNodes(tree.children, '')}
        </div>
      </div>
    `;
  }

  function renderTreeNodes(children, parentPath) {
    const keys = Object.keys(children);
    if (keys.length === 0) return '';

    return keys.map(key => {
      const node = children[key];
      const hasChildren = Object.keys(node.children).length > 0;
      const pct = node.total > 0 ? Math.round(((node.total - node.due) / node.total) * 100) : 0;
      const nodePath = node.path;

      return `
        <div class="tree-node" data-path="${escapeHtml(nodePath)}">
          <div class="tree-row" onclick="window.NoteRecallMobile.startReview('${escapeHtml(nodePath)}')">
            <div class="tree-left">
              <span class="tree-arrow ${hasChildren ? 'expanded' : ''}" onclick="event.stopPropagation(); window.NoteRecallMobile.toggleTree(this)">
                ${hasChildren ? '▶' : '•'}
              </span>
              <span class="tree-name">📁 ${escapeHtml(node.name)}</span>
            </div>
            <div class="tree-right">
              <span class="due-pill ${node.due === 0 ? 'zero' : ''}">${node.due} due</span>
            </div>
          </div>
          <div class="tree-progress">
            <div class="tree-progress-fill" style="width: ${pct}%;"></div>
          </div>
          ${hasChildren ? `
            <div class="tree-children">
              ${renderTreeNodes(node.children, nodePath)}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  // ── Browser Fullscreen & Address Bar Docking ─────────────────
  function isAppFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  }

  function enterFullscreen() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone || isAppFullscreen()) return;

    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) {
      req.call(el).then(() => {
        updateFullscreenUI();
      }).catch(() => {
        // Fallback for environments requiring direct button tap
      });
    }
    // Safari iOS fallback: collapses address bar on scroll
    try { window.scrollTo(0, 1); } catch (e) {}
  }

  function exitFullscreen() {
    if (!isAppFullscreen()) return;
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (exit) {
      exit.call(document).catch(() => {});
    }
  }

  function toggleFullscreen() {
    if (isAppFullscreen()) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }

  function updateFullscreenUI() {
    const btn = document.getElementById('btnFullscreen');
    if (btn) {
      btn.innerHTML = isAppFullscreen() ? '✕ Full' : '⛶ Full';
    }
  }

  document.addEventListener('fullscreenchange', updateFullscreenUI);
  document.addEventListener('webkitfullscreenchange', updateFullscreenUI);

  // ── Review Session Launcher ──────────────────────────────────
  function startReview(scopePath) {
    enterFullscreen();
    state.currentScopePath = scopePath;
    const reviewedSet = getReviewedCardIds();

    // Filter cards matching this folder scope that are not yet reviewed
    const candidateCards = state.pack.cards.filter(c => {
      if (reviewedSet.has(c.id)) return false;
      if (!scopePath) return true; // root = all
      const pathStr = (c.folderPath || ['Uncategorized']).join(' > ');
      return pathStr === scopePath || pathStr.startsWith(scopePath + ' >');
    });

    if (candidateCards.length === 0) {
      alert('All cards in this folder are already reviewed!');
      return;
    }

    state.scopeTotalCards = candidateCards.length;
    state.completedInScope = 0;

    if (state.reviewOrder === 'folder') {
      // Group by distinct folder path
      const groupMap = new Map();
      candidateCards.forEach(c => {
        const p = (c.folderPath || ['Uncategorized']).join(' > ');
        if (!groupMap.has(p)) groupMap.set(p, []);
        groupMap.get(p).push(c);
      });
      state.folderGroups = Array.from(groupMap.entries()).map(([path, cards]) => ({ folderPath: path, cards }));
      state.folderQueueIndex = 0;
      state.reviewQueue = [...state.folderGroups[0].cards];
    } else {
      // Mixed: interleave / shuffle
      state.folderGroups = [];
      state.folderQueueIndex = 0;
      state.reviewQueue = [...candidateCards].sort(() => Math.random() - 0.5);
    }

    launchActiveCard();
  }

  function launchActiveCard() {
    if (state.reviewQueue.length === 0) {
      // Check if there is a next folder in folder-by-folder mode
      if (state.reviewOrder === 'folder' && state.folderQueueIndex + 1 < state.folderGroups.length) {
        state.folderQueueIndex++;
        const nextGroup = state.folderGroups[state.folderQueueIndex];
        const prevGroup = state.folderGroups[state.folderQueueIndex - 1];

        renderInterFolderPrompt(prevGroup.folderPath, nextGroup.folderPath, nextGroup.cards.length);
        return;
      }

      // Entire session complete!
      renderSessionComplete();
      return;
    }

    state.activeCard = state.reviewQueue[0];
    state.revealed = false;
    state.hintLevel = 0;
    state.cardStartTime = Date.now();
    state.recallLatencySec = null;
    state.manuallyRevealed = new Set();

    renderReviewCard();
    startTimerForCard();
  }

  // ── Dark Mode (Isolated Focus) Extraction Engine ────────────────────────
  function buildIsolatedRecallHTML(html, targetNum, revealed, hintLevel, manuallyRevealed) {
    const processedFull = buildRecallHTML(html, targetNum, revealed, hintLevel, manuallyRevealed);
    const div = document.createElement('div');
    div.innerHTML = processedFull;

    const targetSpan = div.querySelector('.cloze-target');
    if (!targetSpan) return { promptHtml: null, targetHtml: processedFull };

    const isBlock = (el) => el && /^(P|LI|TR|H1|H2|H3|BLOCKQUOTE|PRE|DIV|UL|OL|TABLE)$/i.test(el.nodeName);

    // 1. Check Table
    const tr = targetSpan.closest('tr');
    const table = targetSpan.closest('table');
    if (tr && table) {
      const miniTable = document.createElement('table');
      miniTable.className = table.className;
      const theadRow = table.querySelector('thead tr') || table.querySelector('tr:first-child');
      if (theadRow && theadRow !== tr) {
        miniTable.appendChild(theadRow.cloneNode(true));
      }
      miniTable.appendChild(tr.cloneNode(true));

      let promptEl = null;
      let prev = table.previousElementSibling;
      if (prev && /^(P|H1|H2|H3|BLOCKQUOTE)$/i.test(prev.nodeName)) {
        promptEl = prev.cloneNode(true);
      }
      return {
        promptHtml: promptEl ? promptEl.innerHTML : null,
        targetHtml: miniTable.outerHTML
      };
    }

    // 2. Check List (ul / ol)
    const li = targetSpan.closest('li');
    const list = targetSpan.closest('ul, ol');
    if (li && list) {
      const clonedList = list.cloneNode(false);
      const allItems = Array.from(list.querySelectorAll('li'));
      const targetIdx = allItems.indexOf(li);

      const startIdx = Math.max(0, targetIdx - 1);
      const endIdx = Math.min(allItems.length - 1, targetIdx + 1);

      for (let i = startIdx; i <= endIdx; i++) {
        const clonedItem = allItems[i].cloneNode(true);
        if (i === targetIdx) {
          clonedItem.classList.add('spotlight-target');
        } else {
          clonedItem.classList.add('spotlight-dim');
        }
        clonedList.appendChild(clonedItem);
      }

      let promptEl = null;
      let prev = list.previousElementSibling;
      if (prev && /^(P|H1|H2|H3|BLOCKQUOTE)$/i.test(prev.nodeName)) {
        promptEl = prev.cloneNode(true);
      }
      return {
        promptHtml: promptEl ? promptEl.innerHTML : null,
        targetHtml: clonedList.outerHTML
      };
    }

    // 3. Standalone Paragraph / Block
    let block = targetSpan.parentElement;
    while (block && block !== div && !isBlock(block)) {
      block = block.parentElement;
    }
    if (!block || block === div) block = targetSpan;

    let promptEl = null;
    let prev = block.previousElementSibling;
    if (prev && /^(P|H1|H2|H3|BLOCKQUOTE)$/i.test(prev.nodeName)) {
      const prevText = prev.textContent.trim();
      if (prev.querySelector('b, strong') || prevText.endsWith(':') || /^(H1|H2|H3)$/i.test(prev.nodeName) || prevText.length < 120) {
        promptEl = prev.cloneNode(true);
      }
    }

    return {
      promptHtml: promptEl ? promptEl.innerHTML : null,
      targetHtml: block.outerHTML
    };
  }

  // ── In-Note Heading Hierarchy Engine (H1 > H2 > H3 > H4) ───────
  function extractTopicHeading(noteContent, clozeNum) {
    if (!noteContent) return null;
    try {
      const div = document.createElement('div');
      div.innerHTML = noteContent;
      const targetStr = String(clozeNum);
      const clozeEl = Array.from(div.querySelectorAll('span.cloze')).find(s => String(s.getAttribute('data-c')) === targetStr);

      // Find all heading elements and clozes in document order
      const allNodes = Array.from(div.querySelectorAll('h1, h2, h3, h4, span.cloze'));
      const clozeIdx = clozeEl ? allNodes.indexOf(clozeEl) : -1;

      if (clozeIdx !== -1) {
        const priorNodes = allNodes.slice(0, clozeIdx);
        let lastH1 = null, lastH2 = null, lastH3 = null, lastH4 = null;

        priorNodes.forEach(node => {
          const tag = node.tagName;
          const txt = node.textContent.trim();
          if (!txt) return;
          if (tag === 'H1') { lastH1 = txt; lastH2 = null; lastH3 = null; lastH4 = null; }
          else if (tag === 'H2') { lastH2 = txt; lastH3 = null; lastH4 = null; }
          else if (tag === 'H3') { lastH3 = txt; lastH4 = null; }
          else if (tag === 'H4') { lastH4 = txt; }
        });

        const path = [lastH1, lastH2, lastH3, lastH4].filter(Boolean);
        if (path.length > 0) {
          return path.join(' › ');
        }
      }

      // Fallback for full note mode or clozes before the first sub-heading:
      // Show the first heading found anywhere in the note so the pill is always populated
      const anyH = div.querySelector('h1, h2, h3, h4');
      return anyH ? anyH.textContent.trim() : null;
    } catch (e) {
      return null;
    }
  }

  function toggleFocusMode() {
    state.focusMode = state.focusMode === 'isolated' ? 'full' : 'isolated';
    renderReviewCard();
  }

  function smoothScrollToTarget(container, targetEl) {
    if (!container || !targetEl) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    const currentScroll = container.scrollTop;
    const targetOffset = (targetRect.top - containerRect.top) + currentScroll;
    const targetCenter = targetOffset - (containerRect.height / 2) + (targetRect.height / 2);
    const finalScroll = Math.max(0, Math.min(targetCenter, container.scrollHeight - container.clientHeight));

    container.scrollTo({
      top: finalScroll,
      behavior: 'smooth'
    });
  }

  // ── In-Session Card Rendering ─────────────────────────────────
  function renderReviewCard(isNewCard = false) {
    const card = state.activeCard;
    const note = (state.pack.notes && state.pack.notes[card.noteId]) || {
      title: card.noteTitle || 'Untitled Note',
      content: card.contentHtml || ''
    };

    const breadcrumb = (card.folderPath && card.folderPath.join(' ➔ ')) || 'General';
    const total = state.scopeTotalCards;
    const done = state.completedInScope;
    const progressPct = total > 0 ? (done / total) * 100 : 0;

    const topicHeading = extractTopicHeading(note.content, card.clozeNum);
    const headingPillText = topicHeading ? `📌 ${topicHeading}` : (card.folderPath && card.folderPath.length > 0 ? `📁 ${card.folderPath.join(' ➔ ')}` : `📌 ${note.title}`);

    let recallHtml = '';
    if (state.focusMode === 'isolated') {
      const iso = buildIsolatedRecallHTML(
        note.content,
        card.clozeNum,
        state.revealed,
        state.hintLevel,
        state.manuallyRevealed
      );
      if (iso.promptHtml) {
        recallHtml = `<div class="isolated-prompt"><span class="isolated-prompt-label">📌 Context / Prompt</span>${iso.promptHtml}</div><div class="isolated-content">${iso.targetHtml}</div>`;
      } else {
        recallHtml = `<div class="isolated-content">${iso.targetHtml}</div>`;
      }
    } else {
      recallHtml = buildRecallHTML(
        note.content,
        card.clozeNum,
        state.revealed,
        state.hintLevel,
        state.manuallyRevealed
      );
    }

    const existingArea = document.getElementById('reviewCardArea');
    const existingContent = document.getElementById('reviewContentArea');

    // In-place transition: update the existing card view directly (ZERO scroll from top)
    if (existingArea && existingContent) {
      const progressFill = document.querySelector('.session-progress-fill');
      if (progressFill) progressFill.style.width = `${progressPct}%`;

      const progressText = document.querySelector('.review-progress-text');
      if (progressText) {
        progressText.innerHTML = `
          <span>${done} / ${total} done</span>
          <span id="reviewTimerBadgeEl" class="review-timer-badge ${state.timeLeft <= 5 && state.currentTimerSec > 0 ? 'urgent' : ''}" onclick="window.NoteRecallMobile.openTimerSettings()" title="Tap to configure timer">
            ${state.timerEnabled && state.currentTimerSec > 0 ? `⏱ <span id="timerSecondsText">${state.timeLeft}</span>s${state.isAdaptive ? ` <span class="flow-badge">⚡ Flow ${state.currentTimerSec}s</span>` : ''}` : '⏱ Off'}
          </span>
        `;
      }

      const timerTrack = document.getElementById('timerStripTrack');
      if (timerTrack) {
        timerTrack.style.display = state.timerEnabled && state.currentTimerSec > 0 && !state.revealed ? 'block' : 'none';
      }
      const timerFill = document.getElementById('timerStripFill');
      if (timerFill) {
        timerFill.style.width = `${state.currentTimerSec > 0 ? (state.timeLeft / state.currentTimerSec) * 100 : 0}%`;
        if (state.timeLeft <= 5) timerFill.classList.add('urgent');
        else timerFill.classList.remove('urgent');
      }

      const focusBtn = document.getElementById('btnFocusMode');
      if (focusBtn) focusBtn.textContent = state.focusMode === 'isolated' ? '🎯 Focus' : '📄 Note';

      const fullBtn = document.getElementById('btnFullscreen');
      if (fullBtn) fullBtn.textContent = isAppFullscreen() ? '✕ Full' : '⛶ Full';

      const undoBtn = document.getElementById('btnUndo');
      if (undoBtn) undoBtn.disabled = !state.lastActionSnapshot;

      const noteTitle = document.querySelector('.review-note-title');
      if (noteTitle) noteTitle.textContent = note.title;

      const breadcrumbEl = document.querySelector('.review-breadcrumb');
      if (breadcrumbEl) breadcrumbEl.textContent = headingPillText;

      existingContent.className = 'review-content spotlight-active' + (state.revealed ? ' revealed' : '');
      existingContent.innerHTML = recallHtml;

      const hintMsg = document.getElementById('tapToRevealHint');
      if (hintMsg) hintMsg.style.display = !state.revealed ? 'flex' : 'none';

      const footer = document.getElementById('reviewFooterArea');
      if (footer) footer.innerHTML = !state.revealed ? renderUnrevealedActions() : renderRevealedActions();

      existingArea.className = `review-card-area ${state.focusMode === 'isolated' ? 'mode-isolated' : 'mode-full'}`;

      setupClozeClickListeners();

      const cardBox = document.getElementById('reviewCardBox');
      if (cardBox) {
        cardBox.classList.remove('card-entering');
        void cardBox.offsetWidth;
        cardBox.classList.add('card-entering');
      }

      // In isolated card focus: stay firmly centered at top of card (zero scroll jump down)
      // In full note mode: smoothly center directly on the target cloze in the note with zero jitter
      if (state.focusMode === 'isolated') {
        existingArea.scrollTop = 0;
      } else {
        requestAnimationFrame(() => {
          const targetEl = existingContent.querySelector('.cloze-target');
          if (targetEl) {
            smoothScrollToTarget(existingArea, targetEl);
            targetEl.classList.remove('mode-switch-focus');
            void targetEl.offsetWidth;
            targetEl.classList.add('mode-switch-focus');
          }
        });
      }
      return;
    }

    // First card of session: render full review shell
    $main.innerHTML = `
      <div class="review-view">
        <!-- Review Header -->
        <div class="review-header">
          <button class="btn btn-icon" onclick="window.NoteRecallMobile.closeReview()" title="Back to folders">✕</button>
          <div class="review-progress-text">
            <span>${done} / ${total} done</span>
            <span id="reviewTimerBadgeEl" class="review-timer-badge ${state.timeLeft <= 5 && state.currentTimerSec > 0 ? 'urgent' : ''}" onclick="window.NoteRecallMobile.openTimerSettings()" title="Tap to configure timer">
              ${state.timerEnabled && state.currentTimerSec > 0 ? `⏱ <span id="timerSecondsText">${state.timeLeft}</span>s${state.isAdaptive ? ` <span class="flow-badge">⚡ Flow ${state.currentTimerSec}s</span>` : ''}` : '⏱ Off'}
            </span>
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <button id="btnFocusMode" class="btn btn-secondary" onclick="window.NoteRecallMobile.toggleFocusMode()" style="font-size: 11px; padding: 4px 8px;" title="Toggle Isolated Focus / Full Note">
              ${state.focusMode === 'isolated' ? '🎯 Focus' : '📄 Note'}
            </button>
            <button id="btnFullscreen" class="btn btn-secondary" onclick="window.NoteRecallMobile.toggleFullscreen()" style="font-size: 11px; padding: 4px 8px;" title="Dock browser address bar & toggle Fullscreen">
              ${isAppFullscreen() ? '✕ Full' : '⛶ Full'}
            </button>
            <button id="btnUndo" class="btn btn-secondary" onclick="window.NoteRecallMobile.undoLastGrade()" style="font-size: 11px; padding: 4px 8px;" ${state.lastActionSnapshot ? '' : 'disabled'}>
              ↩ Undo
            </button>
          </div>
        </div>

        <!-- Progress Track (exact match of desktop NoteRecall) -->
        <div class="session-progress-track">
          <div class="session-progress-fill" style="width: ${progressPct}%;"></div>
        </div>

        <!-- Timer Track (exact match of desktop NoteRecall) -->
        <div class="timer-strip-track" id="timerStripTrack" style="display: ${state.timerEnabled && state.currentTimerSec > 0 && !state.revealed ? 'block' : 'none'};">
          <div class="timer-strip-fill ${state.timeLeft <= 5 ? 'urgent' : ''}" id="timerStripFill" style="width: ${state.currentTimerSec > 0 ? (state.timeLeft / state.currentTimerSec) * 100 : 0}%;"></div>
        </div>

        <!-- Card Scroll Body -->
        <div class="review-card-area ${state.focusMode === 'isolated' ? 'mode-isolated' : 'mode-full'}" id="reviewCardArea">
          <div class="review-card-box" id="reviewCardBox" onclick="window.NoteRecallMobile.onCardBoxClick(event)">
            <div class="review-note-title">${escapeHtml(note.title)}</div>
            <div class="review-breadcrumb" title="Current topic heading">${escapeHtml(headingPillText)}</div>

            <div id="reviewContentArea" class="review-content spotlight-active ${state.revealed ? 'revealed' : ''}">
              ${recallHtml}
            </div>

            <div id="tapToRevealHint" style="display:${!state.revealed ? 'flex' : 'none'}; align-items:center; justify-content:center; gap:6px; margin-top:14px; font-size:12px; color:var(--text-secondary); opacity:0.85;">
              <span>👆 Tap card or button to reveal</span>
            </div>
          </div>
        </div>

        <!-- Floating Action Bar -->
        <div class="review-footer" id="reviewFooterArea">
          ${!state.revealed ? renderUnrevealedActions() : renderRevealedActions()}
        </div>
      </div>
    `;

    // Hook up local cloze clicks (unmask other clozes & tap target to reveal)
    setupClozeClickListeners();

    const cardArea = document.getElementById('reviewCardArea');
    if (cardArea) {
      if (state.focusMode === 'isolated') {
        cardArea.scrollTop = 0;
      } else {
        requestAnimationFrame(() => {
          const targetEl = cardArea.querySelector('.cloze-target');
          if (targetEl) {
            smoothScrollToTarget(cardArea, targetEl);
            targetEl.classList.remove('mode-switch-focus');
            void targetEl.offsetWidth;
            targetEl.classList.add('mode-switch-focus');
          }
        });
      }
    }
  }

  function renderUnrevealedActions() {
    return `
      <div class="unrevealed-actions">
        <button class="btn-show-answer" onclick="window.NoteRecallMobile.doReveal()">
          👁️ Show Answer
        </button>
        <div class="action-row">
          <button id="btnCycleHint" class="btn btn-secondary" style="flex:1;" onclick="window.NoteRecallMobile.cycleHint()">
            💡 Hint ${state.hintLevel > 0 ? `(${state.hintLevel})` : '[M···]'}
          </button>
          <button class="btn btn-secondary" style="flex:1;" onclick="window.NoteRecallMobile.skipCard()">
            ⏭ Skip
          </button>
        </div>
      </div>
    `;
  }

  function renderRevealedActions() {
    const lat = state.recallLatencySec || 0;
    const isHintCapped = state.hintLevel > 0;

    let badgeClass = 'deliberate';
    let badgeText = `⏳ Deliberate Recall (${lat.toFixed(1)}s)`;

    if (isHintCapped) {
      badgeClass = 'hint-capped';
      badgeText = `💡 Assisted with hint · Grade capped to Hard`;
    } else if (lat <= 3.5) {
      badgeClass = 'instant';
      badgeText = `⚡ Instant Spontaneous Recall (${lat.toFixed(1)}s)`;
    } else if (lat <= 8.0) {
      badgeClass = 'quick';
      badgeText = `⏱️ Quick Recall (${lat.toFixed(1)}s)`;
    }

    return `
      <div style="display:flex; flex-direction:column; gap:8px;">
        <div class="spontaneity-badge ${badgeClass}">
          ${badgeText}
        </div>

        <div class="grade-buttons">
          <button class="grade-btn grade-again" onclick="window.NoteRecallMobile.doGrade(1)">
            Again
            <small>&lt; 10m</small>
          </button>
          <button class="grade-btn grade-hard" onclick="window.NoteRecallMobile.doGrade(2)">
            Hard
            <small>Hard</small>
          </button>
          <button class="grade-btn grade-good ${isHintCapped ? 'hint-capped' : ''}" onclick="window.NoteRecallMobile.doGrade(3)">
            ${isHintCapped ? 'Good (→ Hard)' : 'Good'}
            <small>${isHintCapped ? 'Hard' : 'Good'}</small>
          </button>
          <button class="grade-btn grade-easy ${isHintCapped ? 'hint-capped' : ''}" onclick="window.NoteRecallMobile.doGrade(4)">
            ${isHintCapped ? 'Easy (→ Hard)' : 'Easy'}
            <small>${isHintCapped ? 'Hard' : 'Easy'}</small>
          </button>
        </div>
      </div>
    `;
  }

  // ── HTML Cloze & Spotlight Laser Engine ───────────────────────
  function buildRecallHTML(html, targetNum, revealed, hintLevel, manuallyRevealed) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;

    const targetStr = String(targetNum);
    const clozes = Array.from(div.querySelectorAll('span.cloze'));
    const targetSpan = clozes.find(span => String(span.getAttribute('data-c')) === targetStr);

    if (targetSpan) {
      let block = targetSpan.parentElement;
      while (block && block !== div && !/^(P|LI|TR|BLOCKQUOTE|PRE|DIV)$/i.test(block.nodeName)) {
        block = block.parentElement;
      }
      if (block && block !== div) {
        block.classList.add('spotlight-target-block');
      }
    }

    function computeHintString(rawText, level) {
      if (!rawText) return '[···]';
      const words = rawText.trim().split(/\s+/);
      const rendered = words.map(w => {
        if (!w) return '';
        const len = Math.min(level, w.length);
        return w.slice(0, len) + '···';
      });
      return '[' + rendered.join(' ') + ']';
    }

    clozes.forEach(span => {
      const dataC = String(span.getAttribute('data-c'));
      const isTarget = dataC === targetStr;
      const rawHtml = span.getAttribute('data-orig-html') || span.innerHTML;
      const rawText = span.getAttribute('data-orig') || span.textContent;
      span.setAttribute('data-orig-html', rawHtml);
      span.setAttribute('data-orig', rawText);

      if (isTarget) {
        span.classList.add('cloze-target');
        span.classList.remove('cloze-other');
        if (!revealed) {
          span.classList.add('cloze-hidden');
          span.classList.remove('cloze-revealed');
          if (hintLevel === 0) {
            span.textContent = '[···]';
          } else {
            span.textContent = computeHintString(rawText, hintLevel);
          }
        } else {
          span.classList.add('cloze-revealed');
          span.classList.remove('cloze-hidden');
          span.innerHTML = rawHtml;
        }
      } else {
        // Non-target clozes: ALWAYS retain cloze-other class so click delegation never breaks
        span.classList.add('cloze-other');
        span.classList.remove('cloze-target');
        const isManuallyRevealed = manuallyRevealed && manuallyRevealed.has(dataC);
        if (isManuallyRevealed) {
          span.classList.add('cloze-revealed');
          span.classList.remove('cloze-hidden');
          span.innerHTML = rawHtml;
        } else {
          span.classList.add('cloze-hidden');
          span.classList.remove('cloze-revealed');
          span.textContent = '[···]';
        }
      }
    });

    return div.innerHTML;
  }

  function toggleOtherCloze(rawEl) {
    if (!rawEl) return;
    const el = rawEl.closest('.cloze') || rawEl;
    const cNum = String(el.getAttribute('data-c'));
    const isRevealed = el.classList.contains('cloze-revealed');
    let origHtml = el.getAttribute('data-orig-html') || el.getAttribute('data-orig');

    // Fail-safe: if missing, look up original cloze HTML directly from note source
    if (!origHtml || origHtml === '[···]') {
      const note = state.pack.notes && state.pack.notes[state.activeCard.noteId];
      if (note && note.content) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = note.content;
        const matchingSpan = tempDiv.querySelector(`.cloze[data-c="${cNum}"]`);
        if (matchingSpan) {
          origHtml = matchingSpan.innerHTML;
        }
      }
    }
    if (!origHtml) origHtml = el.innerHTML;
    el.setAttribute('data-orig-html', origHtml);

    if (isRevealed) {
      el.classList.remove('cloze-revealed');
      el.classList.add('cloze-hidden');
      el.textContent = '[···]';
      state.manuallyRevealed.delete(cNum);
    } else {
      el.classList.remove('cloze-hidden');
      el.classList.add('cloze-revealed');
      el.innerHTML = origHtml;
      state.manuallyRevealed.add(cNum);
    }
  }

  function setupClozeClickListeners() {
    // Delegated to onCardBoxClick on #reviewCardBox for a single unified pipeline
  }

  let _lastCardTapTime = 0;
  let _singleTapTimeout = null;

  function onCardBoxClick(e) {
    if (e.target.closest('button, .btn, a, input, select, .grade-btn')) {
      return;
    }

    // 1. Tapped non-due cloze -> toggle in-place (ZERO impact on grading or main card)
    const other = e.target.closest('.cloze-other') || e.target.closest('.cloze:not(.cloze-target)');
    if (other) {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(_singleTapTimeout);
      _singleTapTimeout = null;
      _lastCardTapTime = 0;
      toggleOtherCloze(other);
      return;
    }

    // 2. Tapped active target cloze -> reveal immediately
    const target = e.target.closest('.cloze-target');
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(_singleTapTimeout);
      _singleTapTimeout = null;
      _lastCardTapTime = 0;
      if (!state.revealed) {
        doReveal();
      }
      return;
    }

    // 3. Tapped card background -> check for DOUBLE TAP TO SKIP!
    const now = Date.now();
    const timeSinceLastTap = now - _lastCardTapTime;

    if (timeSinceLastTap > 0 && timeSinceLastTap < 320) {
      // Double tap confirmed! Cancel pending single tap and SKIP!
      clearTimeout(_singleTapTimeout);
      _singleTapTimeout = null;
      _lastCardTapTime = 0;
      flash('Skip ⏭', 'sf-skip');
      skipCard();
      return;
    }

    // First tap: record timestamp
    _lastCardTapTime = now;

    // Schedule single tap action with a brief 250ms window for double-tap detection
    if (!state.revealed) {
      clearTimeout(_singleTapTimeout);
      _singleTapTimeout = setTimeout(() => {
        _singleTapTimeout = null;
        if (!state.revealed) {
          enterFullscreen();
          doReveal();
        }
      }, 250);
    } else {
      enterFullscreen();
    }
  }

  // ── Review Actions (Reveal, Hint, Skip, Grade) ────────────────
  // In-place reveal with ZERO scroll jumps
  function doReveal() {
    if (state.revealed || !state.activeCard) return;
    stopTimer();
    state.revealed = true;
    state.recallLatencySec = Math.max(0.1, (Date.now() - state.cardStartTime) / 1000);

    // In-place cloze text reveal
    const targetEl = document.querySelector('.cloze-target');
    if (targetEl) {
      targetEl.classList.remove('cloze-hidden');
      targetEl.classList.add('cloze-revealed');
      const origHtml = targetEl.getAttribute('data-orig-html') || targetEl.getAttribute('data-orig') || targetEl.textContent;
      targetEl.innerHTML = origHtml;
    }

    const contentArea = document.getElementById('reviewContentArea');
    if (contentArea) contentArea.classList.add('revealed');

    const hintMsg = document.getElementById('tapToRevealHint');
    if (hintMsg) hintMsg.style.display = 'none';

    // In-place footer update to ratings buttons (ZERO scroll movement)
    const footer = document.getElementById('reviewFooterArea');
    if (footer) footer.innerHTML = renderRevealedActions();
  }

  // In-place hint expansion with ZERO scroll jumps
  function cycleHint() {
    if (state.revealed || !state.activeCard) return;
    state.hintLevel = (state.hintLevel || 0) + 1;

    const targetEl = document.querySelector('.cloze-target');
    if (targetEl) {
      const rawText = targetEl.getAttribute('data-orig') || targetEl.textContent;
      targetEl.setAttribute('data-orig', rawText);
      const words = rawText.trim().split(/\s+/);
      const rendered = words.map(w => {
        if (!w) return '';
        const len = Math.min(state.hintLevel, w.length);
        return w.slice(0, len) + '···';
      });
      targetEl.textContent = '[' + rendered.join(' ') + ']';
    }

    const hintBtn = document.getElementById('btnCycleHint');
    if (hintBtn) {
      hintBtn.innerHTML = `💡 Hint (${state.hintLevel})`;
    }
  }

  function skipCard() {
    if (state.reviewQueue.length <= 1) return;
    stopTimer();
    if (state.isAdaptive) {
      state.currentTimerSec = Math.min(120, state.currentTimerSec + state.adaptiveStep);
    }
    const skipped = state.reviewQueue.shift();
    state.reviewQueue.push(skipped);
    launchActiveCard();
  }

  var gradingDebounce = false;
  async function doGrade(gradeVal) {
    if (gradingDebounce || !state.activeCard) return;
    gradingDebounce = true;
    setTimeout(() => { gradingDebounce = false; }, 350);

    stopTimer();

    const card = state.activeCard;
    const effectiveGrade = (state.hintLevel > 0 && gradeVal > 2) ? 2 : gradeVal;

    // Adaptive Flow calculation
    if (state.isAdaptive) {
      if (effectiveGrade >= 3) {
        state.currentTimerSec = Math.max(state.adaptiveMin, state.currentTimerSec - state.adaptiveStep);
      } else {
        state.currentTimerSec = Math.min(120, state.currentTimerSec + state.adaptiveStep);
      }
    }

    // Flash feedback
    const flashMap = {
      1: ['Again ↺', 'sf-again'],
      2: ['Hard ⚡', 'sf-hard'],
      3: ['Good ✓', 'sf-good'],
      4: ['Easy ★', 'sf-easy']
    };
    if (flashMap[gradeVal]) flash(flashMap[gradeVal][0], flashMap[gradeVal][1]);

    // Save snapshot for Undo
    state.lastActionSnapshot = {
      card: { ...card },
      queueSnapshot: [...state.reviewQueue],
      completedInScope: state.completedInScope,
      latency: state.recallLatencySec,
      hintLevel: state.hintLevel
    };

    // Record review log in IndexedDB
    const reviewEntry = {
      cardId: card.id,
      grade: effectiveGrade,
      timestamp: Date.now(),
      latencyMs: Math.round((state.recallLatencySec || 1) * 1000),
      hintUsed: state.hintLevel > 0,
      packId: state.pack.packId
    };
    const logId = await window.NoteRecallDB.appendReview(reviewEntry);
    state.lastActionSnapshot.logId = logId;
    state.reviews.push(reviewEntry);
    triggerBackgroundSync();

    // Queue Progression
    const againGap = (state.pack.settings && state.pack.settings.againGap) || 5;

    if (effectiveGrade === 1) {
      // Intra-session retry: re-insert after againGap cards
      state.reviewQueue.shift();
      const insertIdx = Math.min(againGap, state.reviewQueue.length);
      state.reviewQueue.splice(insertIdx, 0, card);
    } else {
      // Completed successfully in this session
      state.reviewQueue.shift();
      state.completedInScope++;
    }

    launchActiveCard();
  }

  async function undoLastGrade() {
    const snap = state.lastActionSnapshot;
    if (!snap) return;

    if (snap.logId) {
      await window.NoteRecallDB.deleteReviewById(snap.logId);
      state.reviews = state.reviews.filter(r => r.timestamp !== snap.card.lastReview);
    }

    state.reviewQueue = [...snap.queueSnapshot];
    state.activeCard = snap.card;
    state.completedInScope = snap.completedInScope;
    state.hintLevel = snap.hintLevel;
    state.revealed = true;
    state.recallLatencySec = snap.latency;
    state.lastActionSnapshot = null;

    renderReviewCard();
  }

  // ── Touch & Gesture Handling ──────────────────────────────────
  let _touchStartX = 0, _touchStartY = 0, _touchStartTime = 0;
  function handleTouchStart(e) {
    if (!e.touches || !e.touches[0]) return;
    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
    _touchStartTime = Date.now();
  }

  function handleTouchEnd(e) {
    if (!state.activeCard || !e.changedTouches || !e.changedTouches[0]) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - _touchStartX;
    const dy = touch.clientY - _touchStartY;
    const dt = Date.now() - _touchStartTime;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    // If touching inside interactive buttons/links or navigation, don't override
    const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
    if (targetEl && (targetEl.closest('button, .btn, .grade-btn, .top-nav, .review-header, .review-footer, input'))) {
      return;
    }

    // Gesture Swipes (threshold >= 45px, fast enough dt < 650ms)
    // Horizontal Swipes (Left / Right) - strictly horizontal (absX > absY * 1.5) so vertical scrolling is 100% unimpeded
    if (absX >= 45 && absX > absY * 1.5 && dt < 650) {
      if (!state.revealed) {
        doReveal();
        return;
      }
      if (dx > 0) {
        doGrade(3); // Swipe Right -> Good
      } else {
        doGrade(1); // Swipe Left -> Again
      }
      return;
    }
    // (Note: Vertical swipe grading for Hard & Easy removed to prevent scroll interference)
  }

  function flash(text, cls) {
    $swipeFlash.textContent = text;
    $swipeFlash.className = `swipe-flash show ${cls}`;
    setTimeout(() => { $swipeFlash.className = 'swipe-flash'; }, 350);
  }

  async function forceRefresh() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) {
          await reg.unregister();
        }
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        for (const k of keys) {
          await caches.delete(k);
        }
      }
    } catch (e) {}
    window.location.reload(true);
  }

  // ── Inter-Folder Transition Modal ────────────────────────────
  function renderInterFolderPrompt(prevPath, nextPath, nextCount) {
    $main.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-card">
          <div style="font-size: 36px; text-align: center;">🎉</div>
          <div class="modal-title" style="text-align: center;">
            ${escapeHtml(prevPath)} Complete!
          </div>
          <p class="modal-text" style="text-align: center;">
            Great job! Ready to move on to <b>${escapeHtml(nextPath)}</b> (${nextCount} cards)?
          </p>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
            <button class="btn btn-primary" onclick="window.NoteRecallMobile.continueToNextFolder()" style="padding: 12px; font-size: 15px;">
              ▶ Continue to ${escapeHtml(nextPath)}
            </button>
            <button class="btn btn-secondary" onclick="window.NoteRecallMobile.closeReview()" style="padding: 10px;">
              ☕ Take a Break / Back to Folders
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderSessionComplete() {
    // Auto-export review log and sync back to laptop when session ends
    autoSyncReviewsToHub();
    exportReviewLog(false);

    $main.innerHTML = `
      <div class="home-scroll" style="justify-content: center; align-items: center; min-height: 80vh;">
        <div class="pack-card" style="text-align: center; padding: 40px 24px; max-width: 440px;">
          <div style="font-size: 48px; margin-bottom: 12px;">🌟</div>
          <h2 style="font-size: 22px; font-weight: 800; margin-bottom: 8px;">Session Complete!</h2>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 24px; line-height: 1.6;">
            All <b>${state.completedInScope}</b> cards in this session were reviewed.<br>
            Your progress log was saved to phone storage and exported.
          </p>
          <button class="btn btn-primary" onclick="window.NoteRecallMobile.closeReview()" style="padding: 12px 24px; font-size: 15px; align-self: center;">
            🏠 Back to Folder Tree
          </button>
        </div>
      </div>
    `;
  }

  // ── Sync Back & Log Exporter ─────────────────────────────────
  let syncDebounceTimer = null;
  function triggerBackgroundSync() {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
      autoSyncReviewsToHub();
      exportReviewLog(false);
    }, 1500);
  }

  async function exportReviewLog(showAlert = true) {
    if (!state.pack) {
      if (showAlert) alert('No active pack loaded.');
      return;
    }
    const reviews = await window.NoteRecallDB.getReviewsForPack(state.pack.packId);
    if (reviews.length === 0) {
      if (showAlert) alert('No reviews have been completed yet to export.');
      updateSyncStatusUI('synced');
      return;
    }

    const payload = {
      version: 1,
      packId: state.pack.packId,
      exportedAt: new Date().toISOString(),
      device: 'NoteRecall-Mobile-PWA',
      reviewCount: reviews.length,
      reviews: reviews.map(r => ({
        cardId: r.cardId,
        grade: r.grade,
        timestamp: r.timestamp,
        latencyMs: r.latencyMs,
        hintUsed: !!r.hintUsed
      }))
    };

    const jsonStr = JSON.stringify(payload, null, 2);
    updateSyncStatusUI('syncing');

    // Try posting directly to laptop hub if reachable, aborting after 2.5s if offline
    let postedLive = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(getHubUrl('/api/pack/log'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonStr,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        postedLive = true;
        updateSyncStatusUI('synced');
        showToast(`⚡ Synced ${reviews.length} reviews to laptop!`);
        if (showAlert) alert(`⚡ Live synced ${reviews.length} reviews directly back to laptop!`);
      }
    } catch (e) {
      // Laptop not reachable (e.g. offline / away from home Wi-Fi)
      updateSyncStatusUI('offline', reviews.length);
    }

    // Only download file if manually triggered and not posted live (e.g. offline study)
    if (showAlert && !postedLive) {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `noterecall-sync-log.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      alert(`Exported "${a.download}" (${reviews.length} reviews).\n\nReviews are saved on your phone and will also auto-sync when you reconnect to your home Wi-Fi!`);
    }
  }

  // ── Multi-Device Review Catch-up (Phone ⇄ iPad) ───────────────
  async function syncActiveReviewsWithHub() {
    if (!state.pack) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(getHubUrl('/api/pack/reviews'), { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.packId || !Array.isArray(data.reviews)) return;
      if (state.pack.packId !== data.packId) return;

      let newlyAdded = 0;
      for (const remoteRev of data.reviews) {
        const alreadyHas = state.reviews.some(r => r.cardId === remoteRev.cardId && r.timestamp === remoteRev.timestamp);
        if (!alreadyHas) {
          await window.NoteRecallDB.saveReview({
            ...remoteRev,
            packId: state.pack.packId
          });
          state.reviews.push(remoteRev);
          newlyAdded++;
        }
      }

      if (newlyAdded > 0) {
        console.log(`[NoteRecall] Multi-device catch-up: applied ${newlyAdded} new reviews from another device.`);
        showToast(`🔄 Synced ${newlyAdded} reviews from another device`);
        const reviewedIds = new Set(state.reviews.map(r => r.cardId));
        const prevQueueLen = state.reviewQueue.length;
        state.reviewQueue = state.reviewQueue.filter(c => !reviewedIds.has(c.id));
        state.completedInScope = state.reviews.length;

        // If active card was completed elsewhere, advance queue
        if (state.activeCard && reviewedIds.has(state.activeCard.id)) {
          launchActiveCard();
        } else if (document.getElementById('reviewCardArea')) {
          renderReviewCard();
        } else if (document.getElementById('treeContainer')) {
          renderHome();
        }
      }
      updateSyncStatusUI('synced');
    } catch (e) {
      // Offline / laptop sleeping - safe to ignore
      const unapplied = state.reviews ? state.reviews.length : 0;
      updateSyncStatusUI('offline', unapplied);
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Adaptive Flow Timer Engine ──────────────────────────────
  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    const track = document.getElementById('timerStripTrack');
    if (track) track.style.display = 'none';
  }

  function handleTimerExpired() {
    stopTimer();
    state.timerExpired = true;
    if (state.isAdaptive) {
      state.currentTimerSec = Math.min(120, state.currentTimerSec + state.adaptiveStep);
    }
    doReveal();
    showToast('⏱ Time expired! Answer revealed.');
  }

  function startTimerForCard() {
    stopTimer();
    if (!state.timerEnabled || state.currentTimerSec <= 0 || state.revealed || !state.activeCard) {
      return;
    }
    state.timeLeft = state.currentTimerSec;
    state.timerExpired = false;

    const track = document.getElementById('timerStripTrack');
    const fill = document.getElementById('timerStripFill');
    const badge = document.getElementById('reviewTimerBadgeEl');
    const secText = document.getElementById('timerSecondsText');

    if (track) track.style.display = 'block';
    if (fill) {
      fill.style.width = '100%';
      fill.classList.remove('urgent');
    }
    if (badge) {
      badge.className = 'review-timer-badge' + (state.timeLeft <= 5 ? ' urgent' : '');
      if (secText) secText.textContent = state.timeLeft;
    }

    state.timerInterval = setInterval(() => {
      state.timeLeft--;
      const pct = state.currentTimerSec > 0 ? (state.timeLeft / state.currentTimerSec) * 100 : 0;
      const fillEl = document.getElementById('timerStripFill');
      const badgeEl = document.getElementById('reviewTimerBadgeEl');
      const sText = document.getElementById('timerSecondsText');

      if (fillEl) {
        fillEl.style.width = `${Math.max(0, pct)}%`;
        if (state.timeLeft <= 5) fillEl.classList.add('urgent');
        else fillEl.classList.remove('urgent');
      }
      if (badgeEl) {
        if (state.timeLeft <= 5) badgeEl.classList.add('urgent');
        else badgeEl.classList.remove('urgent');
        if (sText) sText.textContent = Math.max(0, state.timeLeft);
      }

      if (state.timeLeft <= 0) {
        handleTimerExpired();
      }
    }, 1000);
  }

  function openTimerSettings() {
    const existing = document.getElementById('timerSettingsModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'timerSettingsModal';
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };
    modal.innerHTML = `
      <div class="modal-card" style="max-width: 360px;" onclick="event.stopPropagation()">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 class="modal-title" style="margin:0; font-size:17px;">⏱ Review Timer Settings</h3>
          <button class="btn btn-icon" onclick="document.getElementById('timerSettingsModal').remove()" style="padding:4px 8px;">✕</button>
        </div>
        <p class="modal-text" style="margin:0; font-size:13px;">
          Set a countdown per card. The answer auto-reveals when the timer hits 0s.
        </p>

        <div style="display:flex; flex-direction:column; gap:8px;">
          <label style="font-size:12px; font-weight:700; color:var(--text-secondary);">TIMER DURATION</label>
          <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:6px;">
            ${[0, 10, 15, 20, 30, 45, 60].map(s => `
              <button class="btn ${state.baseTimerSec === s ? 'btn-primary' : 'btn-secondary'}" 
                onclick="window.NoteRecallMobile.setTimerDuration(${s})"
                style="padding:8px 4px; font-size:12px; font-weight:700;">
                ${s === 0 ? 'Off' : `${s}s`}
              </button>
            `).join('')}
          </div>
        </div>

        <div style="padding:12px; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:10px; display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="window.NoteRecallMobile.toggleAdaptiveFlow()">
            <span style="font-size:13px; font-weight:700;">⚡ Adaptive Flow Timer</span>
            <input type="checkbox" ${state.isAdaptive ? 'checked' : ''} style="width:18px; height:18px; pointer-events:none;">
          </div>
          <p style="margin:0; font-size:11px; color:var(--text-secondary); line-height:1.4;">
            Dynamically adapts to recall speed: Correct answers accelerate next timer by -2s (min 5s); Hard/Again/Expired adds +2s.
          </p>
        </div>

        <button class="btn btn-primary" onclick="document.getElementById('timerSettingsModal').remove()" style="padding:10px; font-size:14px; font-weight:700;">
          Done
        </button>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function setTimerDuration(seconds) {
    state.baseTimerSec = seconds;
    state.currentTimerSec = seconds;
    state.timerEnabled = seconds > 0;
    localStorage.setItem('nr_pwa_timer_sec', String(seconds));
    const m = document.getElementById('timerSettingsModal');
    if (m) m.remove();
    showToast(seconds === 0 ? '⏱ Timer disabled' : `⏱ Timer set to ${seconds}s`);
    if (document.getElementById('reviewCardArea')) {
      renderReviewCard();
      startTimerForCard();
    }
  }

  function toggleAdaptiveFlow() {
    state.isAdaptive = !state.isAdaptive;
    localStorage.setItem('nr_pwa_adaptive_timer', String(state.isAdaptive));
    const m = document.getElementById('timerSettingsModal');
    if (m) m.remove();
    showToast(state.isAdaptive ? '⚡ Adaptive Flow Timer enabled!' : '⚡ Adaptive Flow Timer disabled');
    if (document.getElementById('reviewCardArea')) {
      renderReviewCard();
    }
  }

  function promptHubConfig() {
    const current = localStorage.getItem('nr_laptop_hub_url') || '';
    const input = prompt(
      "💻 Connect to Laptop NoteRecall Hub:\n\nEnter your laptop's IP address (e.g. http://10.24.234.201:8090).\nLeave blank if hosted directly from laptop:",
      current
    );
    if (input !== null) {
      const trimmed = input.trim().replace(/\/+$/, '');
      if (trimmed) {
        localStorage.setItem('nr_laptop_hub_url', trimmed);
        showToast('💻 Laptop Hub saved: ' + trimmed);
        fetchLatestPackFromDesktop().then(p => {
          if (p) {
            loadPackData(p);
            showToast('✅ Connected to laptop! Pack loaded.');
          } else {
            showToast('⚠️ Connected to laptop, but no pack exported yet.');
          }
        }).catch(() => {
          showToast('❌ Could not connect to laptop at ' + trimmed);
        });
      } else {
        localStorage.removeItem('nr_laptop_hub_url');
        showToast('💻 Hub cleared (using default origin)');
      }
    }
  }

  function closeReview() {
    exitFullscreen();
    renderHome();
  }

  // ── Public API for UI bindings ───────────────────────────────
  window.NoteRecallMobile = {
    startReview,
    closeReview,
    toggleFullscreen,
    doReveal,
    onCardBoxClick,
    cycleHint,
    skipCard,
    doGrade,
    undoLastGrade,
    toggleFocusMode,
    forceRefresh,
    syncWithHub: syncActiveReviewsWithHub,
    openTimerSettings,
    setTimerDuration,
    toggleAdaptiveFlow,
    promptHubConfig,
    loadDiscoveredPack,
    dismissDiscoveredPack,
    retryFetchPack: async () => {
      showToast('🔍 Checking laptop for pack...');
      const pack = await fetchLatestPackFromDesktop();
      if (pack) {
        await loadPackData(pack);
        syncActiveReviewsWithHub();
      } else {
        showToast('❌ No pack found on laptop. Export one from desktop first!');
      }
    },
    setOrder: (order) => {
      state.reviewOrder = order;
      renderHome();
    },
    continueToNextFolder: () => {
      const nextGroup = state.folderGroups[state.folderQueueIndex];
      state.reviewQueue = [...nextGroup.cards];
      launchActiveCard();
    },
    toggleTree: (el) => {
      el.classList.toggle('expanded');
      const parentNode = el.closest('.tree-node');
      const childrenEl = parentNode.querySelector('.tree-children');
      if (childrenEl) {
        childrenEl.style.display = el.classList.contains('expanded') ? 'flex' : 'none';
      }
    },
    clearPackPrompt: async () => {
      if (confirm('Clear current review pack and start fresh? Any un-synced reviews will be deleted.')) {
        await window.NoteRecallDB.clearActivePackData();
        state.pack = null;
        state.reviews = [];
        renderEmptyState();
      }
    }
  };

  // Launch app
  window.addEventListener('load', init);
})();
