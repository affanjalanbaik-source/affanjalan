'use strict';

/*
 * Custom storefront preview controls. Audio is fetched only after a visitor
 * presses Play; no native controls/download UI is exposed. Source URLs come
 * from the live catalog API, never from fabricated defaults.
 */
(() => {
  const catalogPromise = fetch('/api/catalog', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  }).then((response) => {
    if (!response.ok) throw new Error('The preview catalog is unavailable.');
    return response.json();
  }).then((payload) => new Map(
    (Array.isArray(payload.beats) ? payload.beats : []).map((beat) => [String(beat.id), beat])
  ));

  let activePlayer = null;

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const value = Math.floor(seconds);
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  };

  function setStatus(card, text) {
    const status = card.querySelector('.preview-status');
    if (status) status.textContent = text;
  }

  function updateButton(button, isPlaying, title) {
    button.setAttribute('aria-label', `${isPlaying ? 'Pause' : 'Play'} preview: ${title}`);
    button.setAttribute('aria-pressed', String(isPlaying));
    button.innerHTML = isPlaying
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  }

  function install(button) {
    if (button.dataset.previewControlsReady) return;
    button.dataset.previewControlsReady = 'true';
    const card = button.closest('.beat-card');
    if (!card) return;

    const id = button.dataset.preview;
    const title = card.querySelector('.card-title')?.textContent?.trim() || 'beat';
    const status = card.querySelector('.preview-status');
    const playerUi = document.createElement('div');
    playerUi.className = 'preview-player';
    playerUi.setAttribute('aria-label', `${title} audio preview controls`);
    playerUi.innerHTML = `
      <input class="preview-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek ${title} preview" disabled>
      <span class="preview-time" aria-live="off">0:00 / 0:00</span>
    `;
    if (status) status.insertAdjacentElement('afterend', playerUi);

    const seek = playerUi.querySelector('.preview-seek');
    const timeLabel = playerUi.querySelector('.preview-time');
    const audio = new Audio();
    audio.preload = 'none';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');

    const syncTime = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
      if (!seek.matches(':active')) seek.value = duration ? String(Math.round(current / duration * 1000)) : '0';
    };

    audio.addEventListener('loadedmetadata', () => {
      seek.disabled = !Number.isFinite(audio.duration) || audio.duration <= 0;
      syncTime();
    });
    audio.addEventListener('timeupdate', syncTime);
    audio.addEventListener('durationchange', syncTime);
    audio.addEventListener('ended', () => {
      updateButton(button, false, title);
      setStatus(card, 'Preview ended. Tap play to listen again.');
      if (activePlayer === audio) activePlayer = null;
      audio.currentTime = 0;
      syncTime();
    });
    audio.addEventListener('error', () => {
      updateButton(button, false, title);
      setStatus(card, 'Preview could not be loaded. Please try again later.');
      if (activePlayer === audio) activePlayer = null;
    });

    seek.addEventListener('input', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Number(seek.value) / 1000 * audio.duration;
        syncTime();
      }
    });

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      if (audio.paused && !audio.src) {
        setStatus(card, 'Checking preview…');
        let source;
        try {
          const catalog = await catalogPromise;
          source = catalog.get(String(id))?.preview;
        } catch (_) {
          setStatus(card, 'Preview service is currently unavailable.');
          return;
        }
        if (!source) {
          updateButton(button, false, title);
          button.disabled = true;
          setStatus(card, 'Preview unavailable — no audio has been uploaded for this beat.');
          return;
        }
        try {
          const url = new URL(source, window.location.href);
          if (url.origin !== window.location.origin) throw new Error('Preview must be served by this site.');
          audio.src = url.href;
          audio.load();
        } catch (_) {
          setStatus(card, 'Preview URL is invalid. Please contact the site owner.');
          return;
        }
      }

      if (!audio.paused) {
        audio.pause();
        updateButton(button, false, title);
        setStatus(card, 'Preview paused.');
        return;
      }

      if (activePlayer && activePlayer !== audio) {
        activePlayer.pause();
        document.querySelectorAll('.preview-button[aria-pressed="true"]').forEach((activeButton) => {
          const activeCard = activeButton.closest('.beat-card');
          const activeTitle = activeCard?.querySelector('.card-title')?.textContent?.trim() || 'beat';
          updateButton(activeButton, false, activeTitle);
          setStatus(activeCard, 'Preview paused.');
        });
      }
      activePlayer = audio;
      setStatus(card, 'Loading preview…');
      try {
        await audio.play();
        updateButton(button, true, title);
        setStatus(card, 'Playing preview.');
      } catch (_) {
        updateButton(button, false, title);
        setStatus(card, 'Playback failed. Tap play to try again.');
        if (activePlayer === audio) activePlayer = null;
      }
    });

    catalogPromise.then((catalog) => {
      const beat = catalog.get(String(id));
      if (!beat?.preview) {
        button.disabled = true;
        button.title = 'Preview unavailable';
        setStatus(card, 'Preview unavailable — no audio has been uploaded.');
      } else {
        setStatus(card, 'Preview ready. Tap play to listen.');
      }
    }).catch(() => {
      button.disabled = true;
      setStatus(card, 'Preview service is currently unavailable.');
    });
  }

  function scan(root = document) {
    if (root.matches?.('.preview-button[data-preview]')) install(root);
    root.querySelectorAll?.('.preview-button[data-preview]').forEach(install);
  }

  scan();
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) scan(node);
    }));
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });

  const style = document.createElement('style');
  style.textContent = `
    .preview-player{display:flex;align-items:center;gap:9px;min-width:0;margin:-4px 0 0}
    .preview-player .preview-seek{flex:1;min-width:50px;width:100%;height:28px;accent-color:#171717;touch-action:pan-x}
    .preview-time{flex:none;color:#737373;font-size:.72rem;font-variant-numeric:tabular-nums}
    .preview-button:disabled{opacity:.55;cursor:not-allowed}
    @media(prefers-reduced-motion:reduce){.preview-player *{scroll-behavior:auto}}
  `;
  document.head.append(style);
})();
