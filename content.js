// Axiom Translator — standalone extension
// Translates tweet / community / account popups on axiom.trade.
// Preserves HTML markup; links (<a>) are never translated.
(() => {
  'use strict';

  // ── Translation core ───────────────────────────────────────────────────────

  const cache   = new Map();   // text → translated
  const pending = new Map();   // requestId → { key, resolve }

  function genId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function hasCyrillic(t) {
    return /[а-яёА-ЯЁ]/.test(t);
  }

  async function translate(text) {
    const key = text.trim();
    if (!key || key.length < 2) return '';
    if (hasCyrillic(key))       return '';
    if (cache.has(key))         return cache.get(key);

    const id = genId();
    return new Promise(resolve => {
      pending.set(id, { key, resolve });
      chrome.runtime.sendMessage({
        type: 'TRANSLATE_REQ',
        payload: { requestId: id, text: key, targetLang: 'ru' },
      });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve(''); }
      }, 6000);
    });
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (!msg || msg.type !== 'TRANSLATE_RES') return;
    const { requestId, translated } = msg.payload || {};
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    if (translated) cache.set(p.key, translated);
    p.resolve(translated || '');
  });

  // ── Text-node helpers ──────────────────────────────────────────────────────

  // Collect non-empty text nodes under `root` that are NOT inside <a> tags.
  function getTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement?.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        // Skip link text — links stay original
        let el = node.parentElement;
        while (el && el !== root) {
          if (el.tagName === 'A') return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // Snapshot current values of text nodes.
  function snapshot(nodes) {
    return nodes.map(n => ({ node: n, original: n.nodeValue }));
  }

  // Translate all snapped nodes in parallel; return [{node, original, translated, changed}].
  async function translateSnaps(snaps) {
    return Promise.all(snaps.map(async ({ node, original }) => {
      const trimmed = original.trim();
      if (!trimmed || hasCyrillic(trimmed)) {
        return { node, original, translated: original, changed: false };
      }
      const result = await translate(trimmed);
      if (!result || result === trimmed) {
        return { node, original, translated: original, changed: false };
      }
      // Preserve leading/trailing whitespace from the original node value.
      const lead  = original.match(/^\s*/)[0];
      const trail = original.match(/\s*$/)[0];
      return { node, original, translated: lead + result + trail, changed: true };
    }));
  }

  function applyTranslation(results) {
    for (const r of results) r.node.nodeValue = r.translated;
  }

  function applyOriginal(results) {
    for (const r of results) r.node.nodeValue = r.original;
  }

  // ── Popup detection ────────────────────────────────────────────────────────

  function isPopup(el) {
    if (!(el instanceof Element) || el.tagName !== 'DIV') return false;
    const c = el.className || '';
    return c.includes('pointer-events-auto') && c.includes('fixed');
  }

  function popupKind(popup) {
    if (Array.from(popup.querySelectorAll('span')).some(s => s.textContent.trim() === 'Members'))
      return 'community';
    // Tweet popup always has a gap-[6px] container regardless of font size.
    // (Short tweets use larger fonts: 20px/22px, not just 18px.)
    if (popup.querySelector('[class*="gap-[6px]"]')) return 'tweet';
    return 'account';
  }

  // ── Sticky viewport toggle button ──────────────────────────────────────────
  // Appears in the bottom-right corner whenever a translated popup is visible.
  // Stays fixed during any scrolling of the page or the popup.

  let stickyBtn   = null;
  let activeState = null;  // { groups, isTranslated, inPopupBtn? }

  function ensureSticky() {
    if (stickyBtn) return;
    stickyBtn = document.createElement('button');
    stickyBtn.id = 'axiom-tr-sticky';
    Object.assign(stickyBtn.style, {
      position:       'fixed',
      bottom:         '22px',
      right:          '22px',
      zIndex:         '2147483647',
      display:        'none',
      alignItems:     'center',
      gap:            '6px',
      padding:        '8px 18px',
      borderRadius:   '9999px',
      border:         '1px solid rgba(108,201,251,0.6)',
      background:     'rgba(12,20,34,0.97)',
      color:          '#6CC9FB',
      fontSize:       '13px',
      fontWeight:     '600',
      cursor:         'pointer',
      fontFamily:     'inherit',
      backdropFilter: 'blur(10px)',
      boxShadow:      '0 2px 20px rgba(0,0,0,0.55)',
      transition:     'opacity 120ms,transform 120ms',
      whiteSpace:     'nowrap',
      lineHeight:     '1',
    });
    stickyBtn.addEventListener('mouseenter', () => { stickyBtn.style.opacity = '0.85'; });
    stickyBtn.addEventListener('mouseleave', () => { stickyBtn.style.opacity = '1'; });
    stickyBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!activeState) return;
      activeState.isTranslated = !activeState.isTranslated;
      for (const grp of activeState.groups) {
        activeState.isTranslated ? applyTranslation(grp) : applyOriginal(grp);
      }
      refreshStickyLabel();
      // Keep in-popup toggle button label in sync.
      if (activeState.inPopupBtn) {
        activeState.inPopupBtn.textContent =
          activeState.isTranslated ? '🔤 Показать оригинал' : '🌐 Перевести';
      }
    });
    document.body.appendChild(stickyBtn);
  }

  function showSticky(state) {
    ensureSticky();
    activeState = state;
    stickyBtn.style.display = 'flex';
    refreshStickyLabel();
  }

  function hideSticky() {
    if (stickyBtn) stickyBtn.style.display = 'none';
    activeState = null;
  }

  function refreshStickyLabel() {
    if (!stickyBtn || !activeState) return;
    stickyBtn.textContent = activeState.isTranslated ? '🔤 Оригинал' : '🌐 Перевести';
  }

  // ── Tweet popup ────────────────────────────────────────────────────────────
  // Auto-translates on appear (like community/account).
  // Scans the ENTIRE popup so quoted tweets (outside gap-[6px]) are also covered.

  async function setupTweetPopup(popup) {
    const box = popup.querySelector('[class*="gap-[6px]"]');
    if (!box) return;
    if (popup.querySelector('.axiom-tr-btn')) return;

    // Find tweet text — axiom uses different font sizes depending on tweet length
    // (short tweets → 22px/20px, long tweets → 18px/16px).
    const mainEl =
      box.querySelector('[class*="text-[22px]"]') ||
      box.querySelector('[class*="text-[20px]"]') ||
      box.querySelector('[class*="text-[18px]"]') ||
      box.querySelector('[class*="text-[16px]"]') ||
      box.querySelector('[class*="text-wrap"]');
    if (!mainEl) return;

    const mainText = mainEl.textContent.trim();
    if (!mainText || mainText.length < 2) return;
    // Skip if the tweet is already in Russian.
    if (hasCyrillic(mainText)) return;

    // Toggle button — absolute top-right; appears immediately with "..." while translating.
    const btn = document.createElement('button');
    btn.className = 'axiom-tr-btn';
    Object.assign(btn.style, {
      position:       'absolute',
      top:            '10px',
      right:          '12px',
      zIndex:         '20',
      display:        'flex',
      alignItems:     'center',
      gap:            '4px',
      background:     'rgba(12,20,34,0.75)',
      border:         '1px solid rgba(139,152,166,0.35)',
      borderRadius:   '9999px',
      padding:        '3px 10px 3px 8px',
      color:          '#8B98A6',
      cursor:         'default',
      fontFamily:     'inherit',
      backdropFilter: 'blur(6px)',
      transition:     'color 120ms, border-color 120ms',
      lineHeight:     '1',
    });
    btn.innerHTML =
      '<span style="font-size:13px;line-height:1">🌐</span>' +
      '<span style="font-size:12px;font-weight:500">...</span>';
    const label = btn.querySelector('span:last-child');
    // Append before translating — snapshot is taken from text nodes that exist now.
    popup.appendChild(btn);

    // Collect text nodes smartly using document position relative to `box`:
    //   • Nodes INSIDE box (gap-[6px]): main tweet + quoted tweet if nested inside
    //   • Nodes AFTER box in DOM order: quoted tweet if it lives outside gap-[6px]
    //   • Nodes BEFORE box: profile header (Joined, followers…) — EXCLUDED
    //
    // compareDocumentPosition returns FOLLOWING (4) for nodes that are either
    // descendants of box OR that come after box in tree order — exactly what we need.
    const allPopupNodes = getTextNodes(popup).filter(n => !btn.contains(n));
    const snaps = snapshot(
      allPopupNodes.filter(n => !!(box.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING))
    );

    // ── Auto-translate immediately on popup appear ──
    const results = await translateSnaps(snaps);
    if (!document.contains(popup)) return;

    const changed = results.filter(r => r.changed);
    if (!changed.length) {
      // Nothing to translate — hide the button.
      btn.remove();
      return;
    }

    applyTranslation(results);
    const state = { groups: [results], isTranslated: true };

    // Update button to toggle state.
    label.textContent     = 'Оригинал';
    btn.style.color       = '#6CC9FB';
    btn.style.borderColor = 'rgba(108,201,251,0.45)';
    btn.style.cursor      = 'pointer';

    btn.addEventListener('mouseenter', () => {
      btn.style.color = '#e2e8f0';
      btn.style.borderColor = 'rgba(108,201,251,0.65)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.color = state.isTranslated ? '#6CC9FB' : '#8B98A6';
      btn.style.borderColor = state.isTranslated
        ? 'rgba(108,201,251,0.45)'
        : 'rgba(139,152,166,0.35)';
    });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      state.isTranslated = !state.isTranslated;
      for (const grp of state.groups) {
        state.isTranslated ? applyTranslation(grp) : applyOriginal(grp);
      }
      label.textContent     = state.isTranslated ? 'Оригинал' : 'Перевести';
      btn.style.color       = state.isTranslated ? '#6CC9FB' : '#8B98A6';
      btn.style.borderColor = state.isTranslated
        ? 'rgba(108,201,251,0.45)'
        : 'rgba(139,152,166,0.35)';
      refreshStickyLabel();
    });

    showSticky(state);
  }

  // ── Community / Account popup ──────────────────────────────────────────────
  // Auto-translates on appear; adds a sticky in-popup toggle above "View" button.

  async function setupDescPopup(popup) {
    const descEl = popup.querySelector('p.break-words');
    if (!descEl) return;
    if (popup.querySelector('.axiom-tr-toggle')) return;

    const text = descEl.textContent.trim();
    if (!text || text.length < 4 || hasCyrillic(text)) return;

    // Toggle button — same absolute top-right style as tweet popup.
    // Appended first so we can show "..." while translating.
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'axiom-tr-toggle';
    Object.assign(toggleBtn.style, {
      position:       'absolute',
      top:            '10px',
      right:          '12px',
      zIndex:         '20',
      display:        'flex',
      alignItems:     'center',
      gap:            '4px',
      background:     'rgba(12,20,34,0.75)',
      border:         '1px solid rgba(139,152,166,0.35)',
      borderRadius:   '9999px',
      padding:        '3px 10px 3px 8px',
      color:          '#8B98A6',
      cursor:         'default',
      fontFamily:     'inherit',
      backdropFilter: 'blur(6px)',
      transition:     'color 120ms, border-color 120ms',
      lineHeight:     '1',
    });
    toggleBtn.innerHTML =
      '<span style="font-size:13px;line-height:1">🌐</span>' +
      '<span style="font-size:12px;font-weight:500">...</span>';
    const label = toggleBtn.querySelector('span:last-child');
    popup.appendChild(toggleBtn);

    const snaps   = snapshot(getTextNodes(descEl));
    const results = await translateSnaps(snaps);
    if (!document.contains(popup)) return;
    if (!results.some(r => r.changed)) {
      toggleBtn.remove();
      return;
    }

    applyTranslation(results);
    const state = { groups: [results], isTranslated: true };

    label.textContent       = 'Оригинал';
    toggleBtn.style.color   = '#6CC9FB';
    toggleBtn.style.borderColor = 'rgba(108,201,251,0.45)';
    toggleBtn.style.cursor  = 'pointer';

    toggleBtn.addEventListener('mouseenter', () => {
      toggleBtn.style.color       = '#e2e8f0';
      toggleBtn.style.borderColor = 'rgba(108,201,251,0.65)';
    });
    toggleBtn.addEventListener('mouseleave', () => {
      toggleBtn.style.color       = state.isTranslated ? '#6CC9FB' : '#8B98A6';
      toggleBtn.style.borderColor = state.isTranslated
        ? 'rgba(108,201,251,0.45)'
        : 'rgba(139,152,166,0.35)';
    });
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      state.isTranslated = !state.isTranslated;
      for (const grp of state.groups) {
        state.isTranslated ? applyTranslation(grp) : applyOriginal(grp);
      }
      label.textContent       = state.isTranslated ? 'Оригинал' : 'Перевести';
      toggleBtn.style.color   = state.isTranslated ? '#6CC9FB' : '#8B98A6';
      toggleBtn.style.borderColor = state.isTranslated
        ? 'rgba(108,201,251,0.45)'
        : 'rgba(139,152,166,0.35)';
      refreshStickyLabel();
    });

    state.inPopupBtn = toggleBtn;
    showSticky(state);
  }

  // ── Main popup handler ─────────────────────────────────────────────────────

  async function onPopupAdded(popup) {
    // Give the page a moment to finish rendering the popup content.
    await new Promise(r => setTimeout(r, 230));
    if (!document.contains(popup)) return;

    const kind = popupKind(popup);
    if (kind === 'tweet') await setupTweetPopup(popup);
    else                  await setupDescPopup(popup);
  }

  function onPopupRemoved() {
    // Restore originals in the (now detached) nodes so the next hover is clean.
    if (activeState) {
      for (const grp of activeState.groups) {
        try { applyOriginal(grp); } catch {}
      }
    }
    hideSticky();
  }

  // ── MutationObserver ───────────────────────────────────────────────────────

  ensureSticky();

  new MutationObserver(muts => {
    for (const mut of muts) {
      for (const node of mut.addedNodes)   { if (isPopup(node)) onPopupAdded(node);   }
      for (const node of mut.removedNodes) { if (isPopup(node)) onPopupRemoved(node); }
    }
  }).observe(document.body, { childList: true });

})();
