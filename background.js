chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'TRANSLATE_REQ') return;
  const { requestId, text, targetLang = 'ru' } = msg.payload || {};
  if (!requestId || !text) return;

  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(targetLang) +
    '&dt=t&q=' +
    encodeURIComponent(text);

  const reply = (translated) => {
    const tabId = sender?.tab?.id;
    if (!tabId) return;
    chrome.tabs.sendMessage(
      tabId,
      { type: 'TRANSLATE_RES', payload: { requestId, translated } },
      () => { chrome.runtime.lastError; }
    );
  };

  fetch(url)
    .then(r => r.text())
    .then(raw => {
      let out = '';
      try {
        const data = JSON.parse(raw);
        out = data[0].map(c => c?.[0] || '').join('');
      } catch {}
      reply(out);
    })
    .catch(() => reply(''));
});
