// Install prompt — one file, dropped unchanged into every app directory.
//
// Every app here is separately installable, so every app carries the same
// "Add to Home Screen" affordance. Chrome hands us a `beforeinstallprompt`
// event to defer and re-fire on tap; iOS has no such event, so there the
// button opens a share-sheet walkthrough tip instead — which makes the tip
// the *only* install path on iOS, and therefore worth protecting.
//
//   installPrompt();   // wires #install, #install-tip, #install-tip-close
//
// ---- Why this is a module and not twelve inline copies --------------------
//
// It used to be an IIFE pasted into each app — six in `index.html`, six in
// `game.js` — and it drifted into four variants. The variants differed in
// exactly the thing that matters: whether the button swallows the pointer
// events it sits on top of. In Hop and Breaker the button lives inside
// `#stage`, whose `pointerdown` starts the game, so tapping "Add to Home
// Screen" launched the player into a running game behind the tip. Owning
// the tap-swallowing here is the whole point of the file.

// The markup every app ships (`hidden` until we know an install is possible).
const BTN = 'install';
const TIP = 'install-tip';
const CLOSE = 'install-tip-close';

export function installPrompt() {
  const btn = document.getElementById(BTN);
  const tip = document.getElementById(TIP);
  const close = document.getElementById(CLOSE);
  if (!btn || !tip) return;

  // Already installed: there is nothing to offer.
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  // no beforeinstallprompt on iOS, so the tip is the only route in
  if (isIOS) btn.hidden = false;

  // The control sits on top of a game surface that is listening for taps.
  // Swallow every phase, not just `click` — the games act on `pointerdown`,
  // which fires first and would start the game underneath the tip.
  for (const el of [btn, tip]) {
    for (const t of ['pointerdown', 'pointerup', 'click']) {
      el.addEventListener(t, (e) => e.stopPropagation());
    }
  }

  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === 'accepted') btn.hidden = true;
      deferred = null;
    } else {
      tip.hidden = false;
    }
  });

  if (close) close.addEventListener('click', () => { tip.hidden = true; });
  // backdrop tap dismisses, per the "primary verbs get the whole screen" rule
  tip.addEventListener('click', (e) => { if (e.target === tip) tip.hidden = true; });

  addEventListener('appinstalled', () => { btn.hidden = true; });
}
