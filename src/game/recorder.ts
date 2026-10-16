import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

/**
 * The battle log's camera: every battle is filmed off the game canvas as an MP4, with the
 * moments that mattered marked on it — hits, parries, knockdowns, the finish — so it can be
 * rewound, stepped through and clipped.
 *
 * Where the browser has a video encoder (WebCodecs), frames go straight into H.264 and are
 * kept as encoded chunks: the full MP4 is put together when the battle's watched or saved,
 * and a clip is cut from the same chunks instantly. Elsewhere the browser's MediaRecorder
 * films the canvas, as MP4 where it can (WebM only as a last resort).
 */

export type MarkKind = 'hit' | 'hurt' | 'parry' | 'down' | 'gore' | 'ko' | 'death';

export interface BattleMark {
  /** Seconds into the recording. */
  t: number;
  kind: MarkKind;
  label: string;
}

export interface BattleMeta {
  round: number;
  arena: string;
  opponent: string;
  boss: boolean;
}

/** A battle's video. */
export interface Footage {
  readonly mime: string;
  readonly bytes: number;
  /** An object URL for it (made on first ask; let go with release()). */
  url(): string;
  /** A clip of it, as its own file — or null if it can't be cut straight from the footage. */
  cut(from: number, to: number): Blob | null;
  release(): void;
}

export interface Battle extends BattleMeta {
  id: number;
  result: 'won' | 'lost' | 'left';
  /** Seconds of footage. */
  duration: number;
  marks: BattleMark[];
  /** The recording (null while it's being finished, or if there isn't one). */
  video: Footage | null;
  /** Recorded, but later cleared to make room for newer battles. */
  cleared: boolean;
  thumb: string | null;
  when: Date;
}

/** Battles kept for the session (oldest dropped first)… */
const KEEP = 12;
/** …and the most video kept between them. */
const BUDGET = 240 * 1024 * 1024;
const FPS = 30;
/** A keyframe a second: where clips can start. */
const KEY_EVERY = 1;
const BITRATE = 2_500_000;
const MAX_W = 1280;
const MAX_H = 720;

const MP4_RECORDER = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4D401F', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'];
const WEBM_RECORDER = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
const H264 = ['avc1.640028', 'avc1.4D4028', 'avc1.42E028'];
const VP9 = ['vp09.00.31.08'];

function recorderMime(candidates: string[]): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // ignore
    }
  }
  return null;
}

async function encoderCodec(candidates: string[]): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const codec of candidates) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: MAX_W, height: MAX_H, bitrate: BITRATE, framerate: FPS, latencyMode: 'realtime', avc: { format: 'avc' } });
      if (r.supported) return codec;
    } catch {
      // ignore
    }
  }
  return null;
}

/** How this browser films: a WebCodecs encoder (and which codec), or a MediaRecorder (and which type). */
type Method = { kind: 'encoder'; codec: string } | { kind: 'recorder'; mime: string } | null;

/** MP4 made from MediaRecorder output (or WebM, where that's all there is). */
class RecordedFootage implements Footage {
  private href: string | null = null;
  constructor(private readonly blob: Blob) {}
  get mime() {
    return this.blob.type;
  }
  get bytes() {
    return this.blob.size;
  }
  url() {
    return (this.href ??= URL.createObjectURL(this.blob));
  }
  cut() {
    return null;
  }
  release() {
    if (this.href) URL.revokeObjectURL(this.href);
    this.href = null;
  }
}

interface Chunk {
  data: Uint8Array;
  key: boolean;
  /** Microseconds into the battle. */
  ts: number;
}

/** Encoded frames, put into an MP4 whole or in part as wanted. */
class EncodedFootage implements Footage {
  readonly mime: string;
  readonly bytes: number;
  private href: string | null = null;
  constructor(
    private readonly chunks: Chunk[],
    private readonly config: EncodedVideoChunkMetadata,
    private readonly codec: string,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.mime = `video/mp4;codecs=${codec}`;
    this.bytes = chunks.reduce((n, c) => n + c.data.byteLength, 0);
  }

  url() {
    return (this.href ??= URL.createObjectURL(this.mux(0, this.chunks.length)));
  }

  cut(from: number, to: number) {
    const a = from * 1e6;
    const b = to * 1e6;
    // From the last keyframe at or before the start (a clip can only begin on one)…
    let i = 0;
    for (let k = 0; k < this.chunks.length && this.chunks[k].ts <= a; k++) if (this.chunks[k].key) i = k;
    // …to the last frame before the end.
    let j = i;
    while (j < this.chunks.length && this.chunks[j].ts < b) j++;
    return j > i ? this.mux(i, j) : null;
  }

  release() {
    if (this.href) URL.revokeObjectURL(this.href);
    this.href = null;
  }

  private mux(i: number, j: number): Blob {
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: this.codec.startsWith('avc') ? 'avc' : 'vp9', width: this.width, height: this.height },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    for (let k = i; k < j; k++) {
      const c = this.chunks[k];
      const next = this.chunks[k + 1];
      const dur = next ? next.ts - c.ts : 1e6 / FPS;
      muxer.addVideoChunkRaw(c.data, c.key ? 'key' : 'delta', c.ts, dur, k === i ? this.config : undefined);
    }
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }
}

/** One battle being filmed through a WebCodecs encoder. */
class EncoderTake {
  readonly chunks: Chunk[] = [];
  config: EncodedVideoChunkMetadata | null = null;
  failed = false;
  private readonly encoder: VideoEncoder;
  private readonly frame: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private nextT = 0;
  private keyT = -Infinity;

  constructor(
    readonly codec: string,
    readonly width: number,
    readonly height: number,
  ) {
    this.frame = document.createElement('canvas');
    this.frame.width = width;
    this.frame.height = height;
    this.ctx = this.frame.getContext('2d', { alpha: false })!;
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.chunks.push({ data, key: chunk.type === 'key', ts: chunk.timestamp });
        if (meta?.decoderConfig && !this.config) this.config = meta;
      },
      error: () => {
        this.failed = true;
      },
    });
    this.encoder.configure({ codec, width, height, bitrate: BITRATE, framerate: FPS, latencyMode: 'realtime', avc: { format: 'avc' } });
  }

  /** The frame just drawn, if it's time for one. @param t seconds into the battle. */
  grab(source: HTMLCanvasElement, t: number) {
    if (this.failed || t < this.nextT) return;
    this.nextT = Math.max(this.nextT + 1 / FPS, t);
    // (A slow machine drops frames rather than piling them up.)
    if (this.encoder.encodeQueueSize > 4) return;
    const { width: W, height: H } = this;
    const s = Math.min(W / Math.max(1, source.width), H / Math.max(1, source.height));
    const w = source.width * s;
    const h = source.height * s;
    if (w < W - 1 || h < H - 1) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, W, H);
    }
    this.ctx.drawImage(source, (W - w) / 2, (H - h) / 2, w, h);
    const f = new VideoFrame(this.frame, { timestamp: Math.round(t * 1e6) });
    const key = t - this.keyT >= KEY_EVERY;
    try {
      this.encoder.encode(f, { keyFrame: key });
      if (key) this.keyT = t;
    } finally {
      f.close();
    }
  }

  async finish(): Promise<Footage | null> {
    try {
      if (!this.failed) await this.encoder.flush();
    } catch {
      this.failed = true;
    }
    try {
      this.encoder.close();
    } catch {
      // already closed
    }
    if (this.failed || !this.config || !this.chunks.length || !this.chunks[0].key) return null;
    return new EncodedFootage(this.chunks, this.config, this.codec, this.width, this.height);
  }
}

export class BattleRecorder {
  readonly battles: Battle[] = [];
  /** Recording on (a setting): off, battles are still logged, just without video. */
  enabled = true;
  onChange: (() => void) | null = null;
  /** MediaRecorder to start with; a WebCodecs encoder replaces it once one's found to work. */
  private method: Method;
  private rec: MediaRecorder | null = null;
  private take: EncoderTake | null = null;
  private chunks: Blob[] = [];
  private current: (BattleMeta & { marks: BattleMark[]; t: number; thumb: string | null }) | null = null;
  private paused = false;
  private wantThumb = false;
  private lastTick = 0;
  private nextId = 1;
  private readonly thumbCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const h264 = recorderMime(MP4_RECORDER.slice(0, 4));
    const mime = h264 ?? recorderMime([...MP4_RECORDER, ...WEBM_RECORDER]);
    this.method = mime && typeof canvas.captureStream === 'function' ? { kind: 'recorder', mime } : null;
    // H.264 from the encoder beats anything MediaRecorder makes (clips cut instantly, and
    // they play everywhere); its VP9-in-MP4 beats a MediaRecorder that can't do H.264 either.
    void (async () => {
      const codec = (await encoderCodec(H264)) ?? (h264 ? null : await encoderCodec(VP9));
      if (codec) this.method = { kind: 'encoder', codec };
    })();
  }

  /** Whether this browser can record clips at all. */
  get canRecord(): boolean {
    return !!this.method;
  }

  get recording(): boolean {
    return !!this.current;
  }

  /** A battle starts. (An unfinished one before it is kept as 'left'.) */
  start(meta: BattleMeta) {
    if (this.current) this.stop('left');
    this.current = { ...meta, marks: [], t: 0, thumb: null };
    this.paused = false;
    this.lastTick = performance.now();
    this.chunks = [];
    this.rec = null;
    this.take = null;
    const m = this.method;
    if (!this.enabled || !m) return;
    if (m.kind === 'encoder') {
      try {
        const s = Math.min(1, MAX_W / Math.max(1, this.canvas.width), MAX_H / Math.max(1, this.canvas.height));
        const even = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2);
        this.take = new EncoderTake(m.codec, even(this.canvas.width), even(this.canvas.height));
        return;
      } catch {
        this.take = null;
        return;
      }
    }
    try {
      const rec = new MediaRecorder(this.canvas.captureStream(FPS), { mimeType: m.mime, videoBitsPerSecond: 3_000_000 });
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      rec.start(1000);
      this.rec = rec;
    } catch {
      this.rec = null;
    }
  }

  /**
   * Time passing in the battle, as filmed: wall-clock time (the game clamps a slow frame's
   * step; the recording doesn't), less any time paused.
   */
  tick(paused: boolean) {
    const now = performance.now();
    const dt = this.lastTick ? (now - this.lastTick) / 1000 : 0;
    this.lastTick = now;
    if (!this.current) return;
    if (paused !== this.paused) {
      this.paused = paused;
      try {
        if (paused && this.rec?.state === 'recording') this.rec.pause();
        else if (!paused && this.rec?.state === 'paused') this.rec.resume();
      } catch {
        // ignore
      }
    }
    if (!paused) this.current.t += Math.min(dt, 1);
  }

  /** Something worth finding again. */
  mark(kind: MarkKind, label: string) {
    if (!this.current) return;
    const last = this.current.marks[this.current.marks.length - 1];
    // (One marker per moment: a burst of hits is one entry.)
    if (last && last.kind === kind && last.label === label && this.current.t - last.t < 0.4) return;
    this.current.marks.push({ t: this.current.t, kind, label });
    if (kind === 'ko' || kind === 'gore' || kind === 'death' || !this.current.thumb) this.wantThumb = true;
  }

  /** Call straight after the frame is drawn (while it's still there to copy): films it, and grabs a thumbnail when one's wanted. */
  afterRender() {
    if (!this.current) return;
    if (this.take && !this.paused) {
      try {
        this.take.grab(this.canvas, this.current.t);
      } catch {
        this.take.failed = true;
      }
    }
    if (!this.wantThumb || !this.thumbCanvas) return;
    this.wantThumb = false;
    try {
      const w = 240;
      const h = Math.round((w * this.canvas.height) / Math.max(1, this.canvas.width));
      this.thumbCanvas.width = w;
      this.thumbCanvas.height = h;
      this.thumbCanvas.getContext('2d')!.drawImage(this.canvas, 0, 0, w, h);
      this.current.thumb = this.thumbCanvas.toDataURL('image/jpeg', 0.7);
    } catch {
      // ignore
    }
  }

  /** The battle's over: the footage is finished and filed in the log. */
  stop(result: Battle['result']) {
    const c = this.current;
    if (!c) return;
    this.current = null;
    const battle: Battle = {
      id: this.nextId++,
      round: c.round,
      arena: c.arena,
      opponent: c.opponent,
      boss: c.boss,
      result,
      duration: c.t,
      marks: c.marks,
      video: null,
      cleared: false,
      thumb: c.thumb,
      when: new Date(),
    };
    this.battles.unshift(battle);
    while (this.battles.length > KEEP) this.battles.pop()!.video?.release();
    const filed = (video: Footage | null) => {
      battle.video = video;
      this.trim();
      this.onChange?.();
    };

    const take = this.take;
    this.take = null;
    if (take) {
      void take.finish().then((video) => {
        // An encoder that fails hands filming back to MediaRecorder from the next battle on.
        if (!video && take.failed) this.fallBack();
        filed(video);
      });
      return;
    }
    const rec = this.rec;
    this.rec = null;
    if (!rec || rec.state === 'inactive') {
      this.onChange?.();
      return;
    }
    const chunks = this.chunks;
    rec.onstop = () => filed(chunks.length ? new RecordedFootage(new Blob(chunks, { type: rec.mimeType || chunks[0].type })) : null);
    try {
      rec.stop();
    } catch {
      this.onChange?.();
    }
  }

  /** Oldest battles' video goes first when the log holds too much. */
  private trim() {
    let total = 0;
    for (const b of this.battles) {
      if (!b.video) continue;
      total += b.video.bytes;
      if (total > BUDGET) {
        b.video.release();
        b.video = null;
        b.cleared = true;
      }
    }
  }

  private fallBack() {
    const mime = recorderMime([...MP4_RECORDER, ...WEBM_RECORDER]);
    this.method = mime && typeof this.canvas.captureStream === 'function' ? { kind: 'recorder', mime } : null;
  }
}
