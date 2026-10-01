/*
 * spindle/story scene runtime.
 *
 * Served as /runtime/story.js with GSAP and its plugins prepended. A scene is a
 * plain HTML page that registers a builder with Story.scene(). The builder adds
 * every animation to one paused timeline, and the editor, thumbnailer and video
 * renderer all drive that timeline with Story.seek(t). Nothing in a scene may
 * depend on wall-clock time, which is what makes renders frame-exact.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const meta = (name) => document.querySelector(`meta[name="story:${name}"]`)?.getAttribute('content') ?? null;

  const plugins = [
    'CustomEase', 'CustomBounce', 'CustomWiggle', 'DrawSVGPlugin', 'MorphSVGPlugin', 'MotionPathPlugin',
    'SplitText', 'ScrambleTextPlugin', 'TextPlugin', 'EasePack', 'Physics2DPlugin', 'PhysicsPropsPlugin',
  ];
  gsap.registerPlugin(...plugins.map((name) => window[name]).filter(Boolean));
  gsap.ticker.lagSmoothing(0);

  const tl = gsap.timeline({ paused: true, defaults: { ease: 'power3.out', duration: 0.6 } });
  const builders = [];
  const frameHooks = [];
  const errors = [];
  const embedded = params.has('embed') || params.has('render') || window.top !== window;

  const width = Number(params.get('w') || meta('width') || 1920);
  const height = Number(params.get('h') || meta('height') || 1080);
  document.documentElement.style.setProperty('--story-w', `${width}px`);
  document.documentElement.style.setProperty('--story-h', `${height}px`);

  window.addEventListener('error', (e) => errors.push(String(e.error?.stack || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.stack || e.reason)));

  const $ = (sel, root = document) => (typeof sel === 'string' ? root.querySelector(sel) : sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function point(target) {
    if (target && typeof target.x === 'number' && typeof target.y === 'number' && !(target instanceof Element)) {
      return target;
    }
    const el = $(target);
    if (!el) throw new Error(`Story: no element for ${target}`);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** Seeded PRNG so "random" layouts are identical on every render. */
  function random(seed = 1) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A pointer you can glide across the scene. Returns tweens to place on the timeline. */
  function cursor(options = {}) {
    const { x = width / 2, y = height / 2, parent = document.body, size = 28, theme = 'light' } = options;
    const el = document.createElement('div');
    el.className = 'story-cursor';
    el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 28 28" fill="none">
      <path d="M6 3.5v19.2l5.1-4.9 3.3 7.5 3.4-1.5-3.3-7.4h7.1L6 3.5z" fill="${theme === 'dark' ? '#fff' : '#111'}"
        stroke="${theme === 'dark' ? '#111' : '#fff'}" stroke-width="1.6" stroke-linejoin="round"/></svg>
      <span class="story-cursor-ring"></span>`;
    parent.appendChild(el);
    gsap.set(el, { x, y });
    const ring = el.querySelector('.story-cursor-ring');
    gsap.set(ring, { scale: 0, opacity: 0 });
    return {
      el,
      moveTo(target, vars = {}) {
        const { dx = 0, dy = 0, ...rest } = vars;
        const p = point(target);
        return gsap.to(el, { x: p.x + dx, y: p.y + dy, duration: 0.8, ease: 'power2.inOut', ...rest });
      },
      click(vars = {}) {
        const c = gsap.timeline({ data: { storyCue: 'click' } });
        c.to(el, { scale: 0.86, duration: 0.09, ease: 'power2.out', ...vars })
          .fromTo(ring, { scale: 0.2, opacity: 0.5 }, { scale: 1.6, opacity: 0, duration: 0.45, ease: 'power2.out' }, 0)
          .to(el, { scale: 1, duration: 0.18, ease: 'power2.out' }, 0.09);
        return c;
      },
      show(vars = {}) { return gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.25, ...vars }); },
      hide(vars = {}) { return gsap.to(el, { opacity: 0, duration: 0.25, ...vars }); },
    };
  }

  /** Types text into an element, character by character. */
  function type(target, text, vars = {}) {
    const el = $(target);
    const { caret = false, ...rest } = vars;
    const state = { n: 0 };
    el.textContent = '';
    if (caret) el.classList.add('story-caret');
    return gsap.to(state, {
      n: text.length,
      duration: Math.max(0.2, text.length * 0.045),
      ease: 'none',
      data: { storyCue: 'typing', chars: text.length },
      ...rest,
      onUpdate() { el.textContent = text.slice(0, Math.round(state.n)); },
    });
  }

  /** Counts a number up or down inside an element. */
  function count(target, from, to, vars = {}) {
    const el = $(target);
    const { format = (n) => Math.round(n).toLocaleString('en-US'), ...rest } = vars;
    const state = { n: from };
    el.textContent = format(from);
    return gsap.to(state, { n: to, duration: 1, ease: 'power2.out', ...rest, onUpdate() { el.textContent = format(state.n); } });
  }

  // Sound cues. Scenes call Story.sound('whoosh', 1.2); helpers tag their tweens (click, typing).
  const sounds = [];
  function sound(type, t, opts = {}) {
    sounds.push({ ...opts, type, t: Number(t) });
  }

  /** Every sound cue in the scene, in scene seconds, for the soundtrack renderer. */
  function cues() {
    const out = sounds.map((s) => ({ ...s, source: 'scene' }));
    const walk = (timeline, offset) => {
      for (const child of timeline.getChildren(false, true, true)) {
        const start = offset + child.startTime();
        const cue = child.data && child.data.storyCue;
        if (cue) out.push({ type: cue, t: start, d: child.duration(), chars: child.data.chars, source: 'helper' });
        if (child instanceof gsap.core.Timeline) walk(child, start);
      }
    };
    walk(tl, 0);
    return out.filter((c) => Number.isFinite(c.t) && c.t >= 0 && c.t <= declaredDuration()).sort((a, b) => a.t - b.t);
  }

  let current = 0;
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));

  function declaredDuration() {
    const d = Number(meta('duration'));
    return Number.isFinite(d) && d > 0 ? d : Math.max(tl.duration(), 1);
  }

  function syncMedia(t, wait) {
    const pending = [];
    for (const anim of document.getAnimations()) {
      anim.pause();
      anim.currentTime = t * 1000;
    }
    for (const v of $$('video')) {
      const start = Number(v.dataset.start || 0);
      const target = Math.max(0, t - start) * (Number(v.dataset.rate) || 1);
      v.pause();
      if (Math.abs(v.currentTime - target) > 0.001) {
        if (wait) pending.push(new Promise((r) => v.addEventListener('seeked', r, { once: true })));
        v.currentTime = target;
      }
    }
    return pending;
  }

  function seek(t, options = {}) {
    current = Math.max(0, t);
    tl.seek(current, false);
    for (const hook of frameHooks) {
      try { hook(current, current / Story.duration); } catch (e) { errors.push(String(e.stack || e)); }
    }
    const pending = syncMedia(current, options.wait);
    return pending.length ? Promise.all(pending).then(() => current) : current;
  }

  /**
   * Tweens created with gsap.to() etc. instead of on the timeline would run on wall-clock
   * time and differ between preview and export. Move them onto the scene timeline at their delay.
   */
  function adoptStrayTweens() {
    for (const child of gsap.globalTimeline.getChildren(false, true, true)) {
      if (child === tl || child.duration() === 0) continue;
      gsap.globalTimeline.remove(child);
      tl.add(child, 0);
      console.warn('Story: moved a tween that was not on the scene timeline to t=' + child.startTime().toFixed(2) + 's');
    }
  }

  async function boot() {
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    await document.fonts.ready;
    await Promise.all($$('img').map((img) => (img.complete ? img.decode?.().catch(() => {}) : new Promise((r) => {
      img.addEventListener('load', r, { once: true });
      img.addEventListener('error', r, { once: true });
    }))));
    for (const build of builders) {
      try {
        const out = build(tl, { gsap, $, $$, tl, Story });
        if (out && typeof out.then === 'function') await out;
      } catch (e) {
        errors.push(String(e.stack || e));
        console.error(e);
      }
    }
    adoptStrayTweens();
    seek(Number(params.get('t') || 0));
    // Let layout settle. rAF never fires in hidden tabs, hence the timeout.
    await new Promise((r) => {
      requestAnimationFrame(() => requestAnimationFrame(r));
      setTimeout(r, 100);
    });
    Story.isReady = true;
    readyResolve();
    window.parent?.postMessage({ type: 'story:ready', duration: Story.duration, errors }, '*');
    if ((!embedded || params.has('play')) && !params.has('t')) autoplay();
  }

  function autoplay() {
    const start = performance.now();
    const loop = (now) => {
      seek(((now - start) / 1000) % Story.duration);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  const Story = {
    gsap,
    timeline: tl,
    width,
    height,
    errors,
    isReady: false,
    ready,
    get duration() { return declaredDuration(); },
    get time() { return current; },
    /** Register the scene builder. Runs once fonts and images are loaded. */
    scene(fn) { builders.push(fn); },
    /** Run a callback on every seek: (t, progress) => void. For canvas, counters, anything procedural. */
    onFrame(fn) { frameHooks.push(fn); },
    seek,
    random,
    sound,
    cues,
    cursor,
    type,
    count,
    point,
    $,
    $$,
  };

  window.Story = Story;
  boot();
})();
