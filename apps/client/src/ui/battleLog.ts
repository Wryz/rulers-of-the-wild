import type { Battle, BattleRecorder, MarkKind } from '../game/recorder';

const MARK_ICON: Record<MarkKind, string> = { hit: '✸', hurt: '✖', parry: '◆', down: '▼', gore: '☠', ko: '★', death: '☠' };
const STEP = 1 / 30;
const SPEEDS = [0.25, 0.5, 1, 2];

const fmt = (t: number) => {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The battle log: every battle this session, on video. Pick one, scrub through it, slow
 * it down, step it a frame at a time, jump to the moments that mattered — and save the
 * whole battle, or cut a clip out of it.
 */
export class BattleLog {
  private readonly el: HTMLDivElement;
  private selected: Battle | null = null;
  private video: HTMLVideoElement | null = null;
  private speed = 1;
  private clip: [number, number] = [0, 0];
  private raf = 0;
  private exporting = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    private readonly recorder: BattleRecorder,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'blog';
    root.appendChild(this.el);
    recorder.onChange = () => {
      if (this.isOpen) this.render();
    };
  }

  get isOpen() {
    return this.el.classList.contains('show');
  }

  /** @param battleId open on this battle (default: the latest). */
  open(battleId?: number) {
    this.selected = this.recorder.battles.find((b) => b.id === battleId) ?? this.recorder.battles[0] ?? null;
    this.resetClip();
    this.el.classList.add('show');
    this.render();
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler, true);
  }

  close() {
    if (!this.isOpen) return;
    cancelAnimationFrame(this.raf);
    this.video?.pause();
    this.video?.removeAttribute('src');
    this.selected?.video?.release();
    this.el.classList.remove('show');
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler, true);
    this.keyHandler = null;
    this.onClose?.();
  }

  private onKey(e: KeyboardEvent) {
    // (The log has the keyboard while it's open.)
    const v = this.video;
    // (Enter too: nothing behind the log should hear it.)
    const handled = ['Escape', 'Space', 'ArrowLeft', 'ArrowRight', 'KeyI', 'KeyO', 'Enter', 'NumpadEnter'];
    if (!handled.includes(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') return this.close();
    if (!v) return;
    if (e.code === 'Space') this.togglePlay();
    if (e.code === 'ArrowLeft') this.seek(v.currentTime - (e.shiftKey ? 5 : STEP));
    if (e.code === 'ArrowRight') this.seek(v.currentTime + (e.shiftKey ? 5 : STEP));
    if (e.code === 'KeyI') this.setClip(0);
    if (e.code === 'KeyO') this.setClip(1);
  }

  private resetClip() {
    const b = this.selected;
    if (!b) return;
    // Default clip: the finish, with a few seconds of lead-in.
    const end = b.marks.filter((m) => m.kind === 'ko' || m.kind === 'death' || m.kind === 'gore').pop()?.t ?? b.duration;
    this.clip = [Math.max(0, end - 6), Math.min(b.duration, end + 2.5)];
  }

  private render() {
    cancelAnimationFrame(this.raf);
    const battles = this.recorder.battles;
    const list = battles.length
      ? battles
          .map((b) => `
            <button class="bl-item ${b.id === this.selected?.id ? 'on' : ''}" data-id="${b.id}">
              <span class="bl-thumb">${b.thumb ? `<img src="${b.thumb}" alt="">` : ''}<i class="res ${b.result}">${b.result === 'won' ? 'WON' : b.result === 'lost' ? 'LOST' : 'LEFT'}</i></span>
              <span class="bl-meta"><b>Round ${b.round} · ${esc(b.opponent)}${b.boss ? ' <em>BOSS</em>' : ''}</b><small>${esc(b.arena)} · ${fmt(b.duration)} · ${b.marks.length} moments</small></span>
            </button>`)
          .join('')
      : '<p class="bl-empty">No battles yet — fight one and it shows up here.</p>';
    const b = this.selected;
    this.el.innerHTML = `
      <div class="bl-card">
        <header class="bl-head">
          <div><div class="bl-title">Battle Log</div><div class="bl-sub">Rewind, slow down and step through every battle this session — then save it or cut a clip.</div></div>
          <button class="bl-close" title="Close (Esc)">✕</button>
        </header>
        <div class="bl-body">
          <aside class="bl-list">${list}</aside>
          <section class="bl-main">${b ? this.player(b) : '<div class="bl-noplay">Pick a battle.</div>'}</section>
        </div>
      </div>`;
    this.el.querySelector('.bl-close')!.addEventListener('click', () => this.close());
    for (const it of Array.from(this.el.querySelectorAll<HTMLButtonElement>('.bl-item'))) {
      it.addEventListener('click', () => {
        this.video?.pause();
        const was = this.selected;
        this.selected = battles.find((x) => x.id === Number(it.dataset.id)) ?? null;
        if (was !== this.selected) was?.video?.release();
        this.resetClip();
        this.render();
      });
    }
    if (b) this.wire(b);
  }

  private player(b: Battle): string {
    const marks = b.marks
      .map((m, i) => `<button class="bl-mark k-${m.kind}" data-i="${i}" title="${esc(m.label)} · ${fmt(m.t)}" style="left:${(100 * m.t) / Math.max(0.01, b.duration)}%">${MARK_ICON[m.kind]}</button>`)
      .join('');
    const moments = b.marks.length
      ? b.marks.map((m, i) => `<button class="bl-moment k-${m.kind}" data-i="${i}"><i>${MARK_ICON[m.kind]}</i>${esc(m.label)}<small>${fmt(m.t)}</small></button>`).join('')
      : '<span class="bl-dim">Nothing much happened.</span>';
    const screen = b.video
      ? `<video class="bl-video" src="${b.video.url()}" playsinline muted preload="auto"></video>`
      : `<div class="bl-novideo">${this.noVideo(b)}</div>`;
    return `
      <div class="bl-screen">${screen}<div class="bl-big-play">▶</div></div>
      <div class="bl-controls">
        <button class="bl-btn play" title="Play / pause (Space)">▶</button>
        <button class="bl-btn" data-step="-5" title="Back 5 s (Shift ←)">« 5s</button>
        <button class="bl-btn" data-step="-${STEP}" title="Back a frame (←)">‹ 1f</button>
        <button class="bl-btn" data-step="${STEP}" title="Forward a frame (→)">1f ›</button>
        <button class="bl-btn" data-step="5" title="Forward 5 s (Shift →)">5s »</button>
        <span class="bl-time">0:00.0 / ${fmt(b.duration)}</span>
        <span class="bl-speeds">${SPEEDS.map((s) => `<button class="bl-btn spd ${s === this.speed ? 'on' : ''}" data-speed="${s}">${s}×</button>`).join('')}</span>
      </div>
      <div class="bl-timeline">
        <div class="bl-clip" style="left:${(100 * this.clip[0]) / Math.max(0.01, b.duration)}%;width:${(100 * (this.clip[1] - this.clip[0])) / Math.max(0.01, b.duration)}%"></div>
        <div class="bl-progress"></div>
        ${marks}
        <div class="bl-head-line"></div>
      </div>
      <div class="bl-moments">${moments}</div>
      <div class="bl-actions">
        <div class="bl-cliprow">
          <span class="bl-dim">Clip</span>
          <button class="bl-btn" data-clip="0" title="Set the clip's start to here (I)">Start here <kbd>I</kbd></button>
          <span class="bl-cliptime">${fmt(this.clip[0])} → ${fmt(this.clip[1])} <small>(${(this.clip[1] - this.clip[0]).toFixed(1)} s)</small></span>
          <button class="bl-btn" data-clip="1" title="Set the clip's end to here (O)">End here <kbd>O</kbd></button>
        </div>
        <div class="bl-saves">
          <button class="bl-save clip" ${b.video ? '' : 'disabled'}>✂ Save clip</button>
          <button class="bl-save full" ${b.video ? '' : 'disabled'}>⤓ Save whole battle</button>
        </div>
        <div class="bl-status"></div>
      </div>`;
  }

  private wire(b: Battle) {
    const v = this.el.querySelector<HTMLVideoElement>('.bl-video');
    this.video = v;
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s);
    const seekTo = (t: number) => this.seek(t);
    for (const m of Array.from(this.el.querySelectorAll<HTMLButtonElement>('.bl-mark, .bl-moment'))) {
      // Jump a moment before it, to see it coming.
      m.addEventListener('click', () => seekTo(b.marks[Number(m.dataset.i)].t - 1.2));
    }
    for (const s of Array.from(this.el.querySelectorAll<HTMLButtonElement>('[data-step]'))) s.addEventListener('click', () => v && seekTo(v.currentTime + Number(s.dataset.step)));
    for (const s of Array.from(this.el.querySelectorAll<HTMLButtonElement>('[data-speed]'))) {
      s.addEventListener('click', () => {
        this.speed = Number(s.dataset.speed);
        if (v) v.playbackRate = this.speed;
        for (const o of Array.from(this.el.querySelectorAll('.spd'))) o.classList.toggle('on', o === s);
      });
    }
    for (const s of Array.from(this.el.querySelectorAll<HTMLButtonElement>('[data-clip]'))) s.addEventListener('click', () => this.setClip(Number(s.dataset.clip) as 0 | 1));
    q('.play')?.addEventListener('click', () => this.togglePlay());
    q('.bl-screen')?.addEventListener('click', () => this.togglePlay());
    q('.bl-save.full')?.addEventListener('click', () => b.video && download(b.video.url(), `${fileName(b)}.${ext(b.video.mime)}`));
    q('.bl-save.clip')?.addEventListener('click', () => this.exportClip(b));
    const tl = q('.bl-timeline');
    if (tl) {
      let drag = false;
      const at = (e: PointerEvent) => {
        const r = tl.getBoundingClientRect();
        seekTo(((e.clientX - r.left) / r.width) * b.duration);
      };
      tl.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).classList.contains('bl-mark')) return;
        drag = true;
        tl.setPointerCapture(e.pointerId);
        at(e);
      });
      tl.addEventListener('pointermove', (e) => drag && at(e));
      tl.addEventListener('pointerup', () => (drag = false));
    }
    if (v) {
      v.playbackRate = this.speed;
      // (A recording straight off MediaRecorder may not know how long it is until it's been read to the end.)
      v.addEventListener('loadedmetadata', () => {
        if (!Number.isFinite(v.duration)) {
          const back = () => {
            v.removeEventListener('timeupdate', back);
            v.currentTime = 0;
          };
          v.addEventListener('timeupdate', back);
          v.currentTime = 1e9;
        }
      });
      v.addEventListener('ended', () => this.syncUi(b));
    }
    const loop = () => {
      this.syncUi(b);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  private syncUi(b: Battle) {
    const v = this.video;
    const t = v ? v.currentTime : 0;
    const frac = Math.min(1, t / Math.max(0.01, b.duration));
    const prog = this.el.querySelector<HTMLElement>('.bl-progress');
    if (prog) prog.style.width = `${frac * 100}%`;
    const line = this.el.querySelector<HTMLElement>('.bl-head-line');
    if (line) line.style.left = `${frac * 100}%`;
    const time = this.el.querySelector('.bl-time');
    if (time) time.textContent = `${fmt(t)} / ${fmt(b.duration)}`;
    const playing = !!v && !v.paused && !v.ended;
    const play = this.el.querySelector('.play');
    if (play) play.textContent = playing ? '❚❚' : '▶';
    this.el.querySelector('.bl-screen')?.classList.toggle('playing', playing);
  }

  private togglePlay() {
    const v = this.video;
    if (!v) return;
    if (v.paused || v.ended) {
      if (v.ended || v.currentTime >= (this.selected?.duration ?? Infinity) - 0.05) v.currentTime = 0;
      void v.play().catch(() => {});
    } else v.pause();
  }

  private seek(t: number) {
    const v = this.video;
    const b = this.selected;
    if (!v || !b) return;
    v.currentTime = Math.max(0, Math.min(b.duration, t));
  }

  private setClip(which: 0 | 1) {
    const v = this.video;
    const b = this.selected;
    if (!v || !b) return;
    const t = v.currentTime;
    if (which === 0) this.clip = [Math.min(t, this.clip[1] - 0.5), this.clip[1]];
    else this.clip = [this.clip[0], Math.max(t, this.clip[0] + 0.5)];
    this.clip = [Math.max(0, this.clip[0]), Math.min(b.duration, this.clip[1])];
    const box = this.el.querySelector<HTMLElement>('.bl-clip');
    if (box) {
      box.style.left = `${(100 * this.clip[0]) / b.duration}%`;
      box.style.width = `${(100 * (this.clip[1] - this.clip[0])) / b.duration}%`;
    }
    const ct = this.el.querySelector('.bl-cliptime');
    if (ct) ct.innerHTML = `${fmt(this.clip[0])} → ${fmt(this.clip[1])} <small>(${(this.clip[1] - this.clip[0]).toFixed(1)} s)</small>`;
  }

  private noVideo(b: Battle) {
    if (b.cleared) return 'This recording was cleared to make room for newer battles — the moments are still logged below.';
    if (!this.recorder.canRecord) return "This browser can't record video — the moments are still logged below.";
    if (!this.recorder.enabled) return 'Recording is off (Settings).';
    return Date.now() - b.when.getTime() < 10_000 ? 'Finishing the recording…' : 'No recording of this battle.';
  }

  /**
   * Cuts the clip. Encoded footage is cut straight out (instantly, from the keyframe at or
   * just before the start). Otherwise the section is played back (off screen, in real time)
   * into a new recording; where the browser can't do that, the whole battle is saved.
   */
  private async exportClip(b: Battle) {
    const footage = b.video;
    if (this.exporting || !footage) return;
    const status = this.el.querySelector<HTMLElement>('.bl-status');
    const say = (s: string) => {
      if (status) status.textContent = s;
    };
    const [from, to] = this.clip;
    const name = `${fileName(b)}-clip-${from.toFixed(0)}s`;
    const cut = footage.cut(from, to);
    if (cut) {
      const url = URL.createObjectURL(cut);
      download(url, `${name}.mp4`);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      say('Clip saved (MP4).');
      return;
    }
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.src = footage.url();
    const cap = (v as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }).captureStream?.bind(v) ?? (v as unknown as { mozCaptureStream?: () => MediaStream }).mozCaptureStream?.bind(v);
    const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(footage.mime) ? footage.mime : null;
    if (!cap || !mime) {
      say("This browser can't cut clips — saving the whole battle instead.");
      download(footage.url(), `${fileName(b)}.${ext(footage.mime)}`);
      return;
    }
    this.exporting = true;
    try {
      v.style.cssText = 'position:fixed;left:-9999px;width:640px;height:360px';
      document.body.appendChild(v);
      await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('load'));
      });
      v.currentTime = from;
      await new Promise<void>((res) => (v.onseeked = () => res()));
      const stream = cap();
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise<void>((res) => (rec.onstop = () => res()));
      rec.start(250);
      await v.play();
      await new Promise<void>((res) => {
        const tick = () => {
          say(`Cutting clip… ${(v.currentTime - from).toFixed(1)} / ${(to - from).toFixed(1)} s`);
          if (v.currentTime >= to || v.ended) return res();
          requestAnimationFrame(tick);
        };
        tick();
      });
      v.pause();
      rec.stop();
      await done;
      const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || mime }));
      download(url, `${name}.${ext(mime)}`);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      say('Clip saved.');
    } catch {
      say("Couldn't cut that clip — try saving the whole battle.");
    } finally {
      v.remove();
      this.exporting = false;
    }
  }
}

function ext(mime: string) {
  return mime.includes('mp4') ? 'mp4' : 'webm';
}

function fileName(b: Battle) {
  return `dungeonstyles-round-${b.round}-${b.opponent.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
