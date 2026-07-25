// Updates — one file, dropped unchanged into every app directory.
//
// These are offline-first PWAs: the service worker serves the cached copy
// first, so a shipped fix can sit on the server for days without the player
// ever seeing it. This makes the update loop visible and puts it in the
// player's hands:
//
//   - on launch it registers the worker and actively checks for a new one;
//   - if one is ready it says so, and reloading is one tap;
//   - the same control forces a check on demand, and reports the answer
//     (including the running version) instead of doing nothing visible.
//
// It never reloads on its own. A game in progress is not worth a silent
// refresh, however new the build is.
//
//   installUpdates({ canShow: () => state !== 'playing' });   // fixed, bottom
//   installUpdates({ mount: document.querySelector('footer') }); // in the flow

const CSS = `
.up-dock {
  position: fixed;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom) + 12px);
  z-index: 30;
  display: none;
  transform: translateX(-50%);
  -webkit-tap-highlight-color: transparent;
}
.up-dock.on { display: block; }
/* a scrolling page (the hub) mounts the control in its own footer instead —
   a fixed pill would sit on top of a card forever */
.up-dock.inline {
  position: static;
  transform: none;
  text-align: center;
}
.up-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 15px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 999px;
  background: rgba(22,22,31,.62);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: rgba(245,245,247,.5);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .01em;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(.16,1,.3,1), color 160ms, background-color 160ms;
}
.up-btn:active { transform: scale(.96); }
.up-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: .55;
}
/* an update is waiting: the same control, promoted */
.up-dock.ready .up-btn {
  background: var(--up-accent, #7c5cff);
  border-color: transparent;
  color: #0a0a0f;
  font-weight: 700;
  animation: up-rise 420ms cubic-bezier(.22,1.2,.36,1) both;
}
.up-dock.ready .up-dot {
  opacity: 1;
  animation: up-pulse 1.6s ease-in-out infinite;
}
.up-dock.busy .up-btn { color: rgba(245,245,247,.75); }
@keyframes up-rise {
  from { opacity: 0; transform: translateY(12px) scale(.9) }
  to { opacity: 1; transform: none }
}
@keyframes up-pulse {
  0%, 100% { opacity: 1 }
  50% { opacity: .25 }
}
@media (prefers-reduced-motion: reduce) {
  .up-dock.ready .up-btn, .up-dock.ready .up-dot { animation-duration: 1ms; }
}
`;

const IDLE_LABEL = 'Check for updates';

export function installUpdates(opts = {}) {
  const canShow = opts.canShow || (() => true);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim();
  if (accent) document.documentElement.style.setProperty('--up-accent', accent);

  const dock = document.createElement('div');
  dock.className = 'up-dock';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'up-btn';
  const dot = document.createElement('span');
  dot.className = 'up-dot';
  const label = document.createElement('span');
  label.textContent = IDLE_LABEL;
  btn.append(dot, label);
  dock.appendChild(btn);
  if (opts.mount) {
    dock.classList.add('inline');
    opts.mount.appendChild(dock);
  } else {
    document.body.appendChild(dock);
  }

  let ready = false;          // a new worker is installed and waiting for a reload
  let busy = false;
  let version = '';
  let reg = null;
  let flash = 0;              // timestamp: a transient message is showing

  function say(text, ms) {
    label.textContent = text;
    if (ms) {
      const at = Date.now();
      flash = at;
      setTimeout(() => { if (flash === at) { flash = 0; paint(); } }, ms);
    }
  }

  function paint() {
    dock.classList.toggle('ready', ready);
    dock.classList.toggle('busy', busy);
    dock.classList.toggle('on', !!canShow());
    if (flash) return;
    if (ready) label.textContent = 'Update ready · Reload';
    else if (busy) label.textContent = 'Checking…';
    else label.textContent = IDLE_LABEL;
  }
  setInterval(paint, 300);
  paint();

  function markReady() {
    if (ready) return;
    ready = true;
    flash = 0;
    paint();
  }

  // Every app in the collection has its own worker, and the hub's worker has
  // the widest scope — open a game from the hub's cache and the *hub* is
  // controlling the page while the game's own worker installs underneath it.
  // That is a first install, not an update, so "is this our worker?" has to
  // mean the script, not merely the presence of one.
  const OUR_SW = new URL('./sw.js', location.href).href;
  const oursInCharge = () => {
    const c = navigator.serviceWorker.controller;
    return !!c && c.scriptURL === OUR_SW;
  };

  // Ask the running worker what it is serving. Purely informational, but a
  // "check for updates" that can't name the version it settled on is asking
  // to be taken on faith.
  function askVersion() {
    if (!oursInCharge()) return;
    try { navigator.serviceWorker.controller.postMessage('version'); } catch (_) {}
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'version') {
        version = String(e.data.version || '').replace(/^am-/, '');
      }
    });

    // A worker taking over mid-session means new assets are already live in
    // the cache while this page still runs the old code: that is an update.
    // The first install also claims this page, and that is NOT one — the
    // give-away is whether *our* worker was already in charge beforehand.
    let hadOurs = oursInCharge();
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      askVersion();
      if (hadOurs) markReady();
      hadOurs = oursInCharge() || hadOurs;
    });

    const watch = (r) => {
      reg = r;
      askVersion();
      if (r.waiting && oursInCharge()) markReady();
      r.addEventListener('updatefound', () => {
        const fresh = r.installing;
        if (!fresh) return;
        fresh.addEventListener('statechange', () => {
          // nothing of ours in charge means this is a first install
          if (fresh.state === 'installed' && oursInCharge()) markReady();
          if (fresh.state === 'activated') askVersion();
        });
      });
    };

    addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((r) => {
          watch(r);
          // the launch check the player never has to ask for
          return r.update().catch(() => {});
        })
        .catch(() => {});
    });
  }

  async function check() {
    if (ready) { location.reload(); return; }
    if (busy) return;
    if (!('serviceWorker' in navigator) || !reg) {
      say('Updates unavailable', 2600);
      return;
    }
    // an offline check quietly succeeds against the HTTP cache, which would
    // let it claim "up to date" without having asked anyone
    if (!navigator.onLine) {
      say('Offline · can\u2019t check', 2600);
      return;
    }
    busy = true;
    paint();
    const startedAt = Date.now();
    try {
      await reg.update();
      // give a freshly-found worker a moment to reach `installed`
      await new Promise((r) => setTimeout(r, Math.max(0, 900 - (Date.now() - startedAt))));
      busy = false;
      if (!ready) say(version ? `Up to date · ${version}` : 'Up to date', 2600);
      paint();
    } catch (_) {
      busy = false;
      say(navigator.onLine ? 'Check failed' : 'Offline · can’t check', 2600);
      paint();
    }
  }

  // Same tap-swallowing as the pause control: these games treat a tap
  // anywhere as "start", and the tap that checks for updates must not
  // also begin a run.
  const stop = (e) => e.stopPropagation();
  for (const ev of ['pointerup', 'touchstart', 'touchend', 'mouseup']) {
    btn.addEventListener(ev, stop);
  }
  for (const ev of ['pointerdown', 'click']) {
    btn.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      // pointerdown drives taps and mouse; a detail-less click is the
      // keyboard activating the focused button
      if (e.type === 'pointerdown' || !e.detail) check();
    });
  }

  return {
    get ready() { return ready; },
    get version() { return version; },
    check,
  };
}
