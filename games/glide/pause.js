// Pause — one file, dropped unchanged into every game directory.
//
// A phone interrupts you constantly, and "die or close the tab" is not an exit.
// This owns the button, the card, the keys and the auto-pause when the app goes
// to the background. It does NOT own the clock: a game asks `pause.active` at
// the top of its own loop and skips its update, so every game keeps its own
// idea of what "frozen" means.
//
//   const pause = installPause({ canPause: () => state === 'playing' });
//   ...
//   function tick(now) {
//     requestAnimationFrame(tick);
//     if (pause.active) { last = now; return; }   // eat the gap, draw nothing
//     ...
//   }

const CSS = `
.pz-btn {
  position: fixed;
  z-index: 40;
  width: 44px;
  height: 44px;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 999px;
  background: rgba(22,22,31,.66);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: rgba(245,245,247,.82);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: transform 120ms cubic-bezier(.16,1,.3,1), color 120ms, background-color 120ms;
}
.pz-btn.on { display: inline-flex; }
.pz-btn:active { transform: scale(.92); }
.pz-veil {
  position: fixed;
  inset: 0;
  z-index: 41;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(10,10,15,.72);
  -webkit-backdrop-filter: blur(7px);
  backdrop-filter: blur(7px);
  animation: pz-fade 200ms cubic-bezier(.16,1,.3,1) both;
  -webkit-tap-highlight-color: transparent;
}
.pz-veil[hidden] { display: none; }
.pz-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
  animation: pz-rise 240ms cubic-bezier(.22,1.2,.36,1) both;
}
.pz-title {
  font-size: clamp(34px, 11vw, 52px);
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--pz-accent, #7c5cff);
}
.pz-resume {
  min-width: 168px;
  height: 46px;
  padding: 0 22px;
  border: 0;
  border-radius: 12px;
  background: var(--pz-accent, #7c5cff);
  color: #0a0a0f;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 120ms cubic-bezier(.16,1,.3,1);
}
.pz-resume:active { transform: scale(.96); }
.pz-hint {
  font-size: 12px;
  letter-spacing: .04em;
  color: rgba(245,245,247,.45);
}
@keyframes pz-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes pz-rise {
  from { opacity: 0; transform: translateY(10px) scale(.96) }
  to { opacity: 1; transform: none }
}
@media (prefers-reduced-motion: reduce) {
  .pz-veil, .pz-card { animation-duration: 1ms; }
}
`;

const ICON = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
  '<rect x="7" y="5" width="3.6" height="14" rx="1.4" fill="currentColor"/>' +
  '<rect x="13.4" y="5" width="3.6" height="14" rx="1.4" fill="currentColor"/></svg>';

export function installPause(opts = {}) {
  const canPause = opts.canPause || (() => true);
  const top = opts.top == null ? 14 : opts.top;
  const right = opts.right == null ? 14 : opts.right;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // borrow the game's own accent so the card belongs to the game it covers
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim();
  if (accent) document.documentElement.style.setProperty('--pz-accent', accent);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pz-btn';
  btn.setAttribute('aria-label', 'Pause');
  btn.innerHTML = ICON;
  btn.style.top = `calc(env(safe-area-inset-top) + ${top}px)`;
  btn.style.right = `calc(env(safe-area-inset-right) + ${right}px)`;

  const veil = document.createElement('div');
  veil.className = 'pz-veil';
  veil.hidden = true;
  veil.innerHTML =
    '<div class="pz-card">' +
      '<div class="pz-title">Paused</div>' +
      '<button class="pz-resume" type="button">Resume</button>' +
      '<div class="pz-hint">tap anywhere to resume</div>' +
    '</div>';

  document.body.appendChild(btn);
  document.body.appendChild(veil);

  let active = false;
  let toggledAt = -1e9;

  function pause() {
    if (active || !canPause()) return;
    active = true;
    toggledAt = performance.now();
    veil.hidden = false;
    btn.classList.remove('on');
    opts.onPause?.();
  }

  function resume() {
    if (!active) return;
    active = false;
    toggledAt = performance.now();
    veil.hidden = true;
    sync();
    opts.onResume?.();
  }

  // Whichever way you toggle, the *other* control lands under the finger that
  // did it, and the compatibility click at the end of that same tap hits the
  // newcomer — pausing, then instantly un-pausing (or the reverse). Both
  // directions ignore input for a beat after a toggle.
  const settled = () => performance.now() - toggledAt > 260;

  function toggle() { active ? resume() : pause(); }

  // the button only exists while there is something to freeze
  function sync() {
    btn.classList.toggle('on', !active && !!canPause());
  }
  setInterval(sync, 220);
  sync();

  // Act on pointerdown, not click: it feels immediate, and it means a
  // cancelled tap never leaves the game in the wrong state. `click` stays
  // wired for keyboard activation of the focused button — both paths are
  // idempotent, so a tap that produces both is harmless.
  //
  // Everything here stops propagation: most of these games treat a tap
  // anywhere as "start" or "jump", and the tap that pauses must not also be
  // played. preventDefault is deliberately limited to pointerdown/mousedown
  // (cancelling touchstart would suppress the click that keyboards rely on).
  const stop = (e) => e.stopPropagation();
  const act = (fn) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  for (const ev of ['pointerup', 'touchstart', 'touchend', 'mouseup']) {
    btn.addEventListener(ev, stop);
    veil.addEventListener(ev, stop);
  }
  for (const ev of ['pointerdown', 'mousedown', 'click']) {
    btn.addEventListener(ev, act(() => { if (settled()) pause(); }));
    veil.addEventListener(ev, act(() => { if (settled()) resume(); }));
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (!active && !canPause()) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  }, true);

  // going to the background always pauses: coming back to a game that has been
  // running without you is worse than coming back to a card
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  addEventListener('blur', () => pause());

  return {
    get active() { return active; },
    pause, resume, toggle,
  };
}
