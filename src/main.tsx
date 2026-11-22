import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { labels, parseLayout, routes, themes, type ChannelLayout, type Layout, type Modules, type Profile } from './layout';
import './style.css';

type BusState = { eqOn: boolean; eqAb: boolean; returns: number[] };
type Channel = {
  label: string; device: string | null; gain: number; mute: boolean; solo: boolean; mono: number;
  routes: boolean[]; pad: number[] | null; audibility: number[] | null; eq: number[] | null;
  sends: number[]; eqOn: boolean | null; bus: BusState | null;
};
type Snapshot = { status: string; channels: Channel[]; fx: boolean[] };
type Stereo = [number | null, number | null];
type Control = 'gain' | 'mute' | 'solo' | 'mono' | 'route'
  | 'gate' | 'comp' | 'denoiser' | 'eqGain' | 'send' | 'eqOn' | 'eqAb' | 'return';
type EqField = 'on' | 'type' | 'freq' | 'gain' | 'q';
type EqCell = { on: boolean; kind: number; freq: number; gain: number; q: number };

const desktop = isTauri() ? getCurrentWindow() : null;
// Browser-only demo (`?demo&theme=ocean`): fake mixer data, used for README screenshots.
const query = new URLSearchParams(location.search);
const demo = !desktop && query.has('demo');
const demoNames = ['MIC', 'BROWSER', 'DISCORD', 'GAMES', 'LINE IN', 'DESKTOP', 'MUSIC', 'ALERTS', 'SPEAKERS', 'HEADSET', 'MONITOR', 'CAPTURE', 'A5', 'MIC BUS', 'STREAM', 'RECORD'];
const demoSnapshot = (): Snapshot => ({
  status: 'Connected',
  fx: [true, false, false, false],
  channels: demoNames.map((label, id) => ({
    label, device: id < 5 || (id >= 8 && id < 13) ? ['K18 Mic', 'VB-Cable A', 'VB-Cable B', 'Elgato', 'Line In'][id % 5] : null,
    gain: [0, -4, -6, -9, -3, 0, -7.5, -12, 0, -2, -6, 0, 0, 0, 0, 0][id], mute: id === 4 || id === 12, solo: false, mono: 0,
    routes: [id % 3 !== 2, true, false, false, false, id % 2 === 0, true, false],
    pad: id < 5 ? [0.1, 0.5, 0, 0.3, 0, 0.5] : null, audibility: id < 5 ? [2, 3, 1] : null, eq: id >= 5 && id < 8 ? [1, 0, 2] : null,
    sends: [0, 0, 0, 0], eqOn: id < 5 || id >= 8 ? id % 2 === 0 : null,
    bus: id >= 8 ? { eqOn: id % 2 === 0, eqAb: false, returns: [3, 2, 0, 0] } : null,
  })),
});
const demoLevels = (): Record<number, Stereo> => Object.fromEntries(demoNames.map((_, id) => {
  const base = [0.5, 0.3, 0.22, 0.4, 0, 0.35, 0.28, 0.08, 0.45, 0.3, 0.2, 0.38, 0, 0.5, 0.42, 0.25][id];
  return [id, [base, base * 0.9] as Stereo];
}));
const blank: Channel = {
  label: '', device: null, gain: 0, mute: false, solo: false, mono: 0, routes: [],
  pad: null, audibility: null, eq: null, sends: [0, 0, 0, 0], eqOn: null, bus: null,
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const gainText = (gain: number) => `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`;
type PadMode = 'color' | 'fx' | 'pan';
const padModes: PadMode[] = ['color', 'fx', 'pan'];
const padLabels = { color: 'Color', fx: 'FX', pan: 'Pan' } as const;
const FADE_MS = 400;
const FADE_STEPS = 8;
const monoLabels = ['Stereo', 'Mono', 'Reverse'];
const eqTypes = ['Peak', 'Low shelf', 'High shelf', 'Low pass', 'High pass', 'Band pass', 'Notch'];
const sends = ['Reverb', 'Delay', 'Fx1', 'Fx2'];
const bands = ['Bass', 'Mid', 'Treble'];
const moduleToggles: [keyof Modules, string][] = [['intellipan', 'Intellipan'], ['audibility', 'Audibility'], ['eqFx', 'EQ & FX']];
const visibilityToggles = [['intellipan', 'Intellipan'], ['audibility', 'Audibility'], ['fxSends', 'FX Sends'], ['solo', 'Solo'], ['mono', 'Mono'], ['recorder', 'Recorder'], ['reverb', 'Reverb'], ['delay', 'Delay'], ['sing', 'SING']] as const;

function useDraft(value: number) {
  const [draft, setDraft] = useState<{ value: number }>();
  const pinned = useRef(false);
  useEffect(() => {
    if (!draft || pinned.current) return;
    const timer = setTimeout(() => setDraft(undefined), 450);
    return () => clearTimeout(timer);
  }, [draft]);
  const pin = () => { pinned.current = true; };
  const unpin = () => {
    pinned.current = false;
    // restart timeout now that dragging stopped
    setDraft((d) => d ? { value: d.value } : d);
  };
  return [draft?.value ?? value, (next: number) => setDraft({ value: next }), pin, unpin] as const;
}

// Smooths dB readout (exponential, per level update) so digits don't flicker.
function useSmoothDb(sample: number | null | undefined) {
  const shown = useRef(-60);
  const db = sample == null ? null : sample > 0.001 ? Math.max(-60, 20 * Math.log10(sample)) : -60;
  if (db != null) shown.current += (db - shown.current) * (db > shown.current ? 0.5 : 0.15);
  return db == null ? null : shown.current <= -59 ? -Infinity : Math.round(shown.current / 2) * 2;
}

const dbToPct = (db: number) => db >= 0 ? 75 + (db / 12) * 25 : Math.max(0, 75 + (db / 60) * 75);
const pctToDb = (pct: number) => pct >= 75 ? ((pct - 75) / 25) * 12 : ((pct - 75) / 75) * 60;

// Meter fall: fast attack, slow release (pct per second).
function useFall(pcts: number[]) {
  const state = useRef({ shown: [0, 0], at: performance.now() });
  const now = performance.now(), dt = (now - state.current.at) / 1000;
  state.current.at = now;
  state.current.shown = pcts.map((p, i) => Math.max(p, state.current.shown[i] - 120 * dt));
  return state.current.shown;
}

function MeterBar({ title, stereo }: { title: string; stereo?: Stereo }) {
  const raw = [0, 1].map((i) => {
    const v = stereo?.[i];
    return v == null || v <= 0 ? 0 : Math.min(100, Math.max(0, ((20 * Math.log10(v) + 60) / 60) * 100));
  });
  const fall = useFall(raw);
  return <div className="meter-pair">{(['L', 'R'] as const).map((side, i) => {
    const sample = stereo?.[i];
    const db = sample == null ? null : sample > 0 ? 20 * Math.log10(sample) : -Infinity;
    const pct = fall[i];
    const text = db == null ? 'Unavailable' : db === -Infinity ? 'Silent' : `${db.toFixed(1)} dBFS`;
    return <div key={side} className="meter" role="meter" aria-label={`${title} ${side}`}
      aria-valuemin={-60} aria-valuemax={0} aria-valuenow={db == null || db === -Infinity ? -60 : Math.max(-60, db)}
      aria-valuetext={text} title={`${side}: ${text}`}>
      <span className={`meter-led ${pct > 84 ? 'hot' : pct > 68 ? 'warm' : ''}`} style={{ height: `${pct}%` }} />
      <span className="meter-mask" aria-hidden="true" />
    </div>;
  })}</div>;
}

function Fader({ title, value, disabled, onChange, onPin, onUnpin }: {
  title: string; value: number; disabled: boolean;
  onChange: (value: number) => void; onPin: () => void; onUnpin: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(value);
  latest.current = value;
  const pct = dbToPct(value);
  const step = (delta: number) => {
    const next = Math.min(12, Math.max(-60, Math.round((latest.current + delta) * 10) / 10));
    onChange(next);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (el.getAttribute('aria-disabled') === 'true') return;
      e.preventDefault();
      step(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const place = (clientY: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const raw = Math.min(100, Math.max(0, (1 - (clientY - box.top) / box.height) * 100));
    const db = Math.round(pctToDb(raw) * 10) / 10;
    onChange(Math.abs(db) < 0.25 ? 0 : db);
  };
  return <div ref={ref} className="fader" role="slider" tabIndex={disabled ? -1 : 0}
    aria-label={`Gain ${title}`} aria-valuemin={-60} aria-valuemax={12} aria-valuenow={value}
    aria-valuetext={gainText(value)} aria-disabled={disabled}
    onPointerDown={(e) => {
      if (disabled || e.button !== 0 || !e.isPrimary) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      onPin(); place(e.clientY);
    }}
    onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) place(e.clientY); }}
    onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) onUnpin(); }}
    onLostPointerCapture={onUnpin}
    onDoubleClick={() => { if (!disabled) onChange(0); }}
    onKeyDown={(e) => {
      if (disabled) return;
      const delta = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1
        : e.key === 'PageUp' ? 6 : e.key === 'PageDown' ? -6 : 0;
      if (delta) { e.preventDefault(); step(delta); }
      else if (e.key === 'Home') { e.preventDefault(); onChange(12); }
      else if (e.key === 'End') { e.preventDefault(); onChange(-60); }
    }}>
    <span className="fader-notch" aria-hidden="true" />
    <span className="fader-track" aria-hidden="true"><span className="fader-fill" style={{ height: `${pct}%` }} /></span>
    <span className="fader-thumb" style={{ bottom: `${pct}%` }} aria-hidden="true" />
  </div>;
}

function Knob({ label, value, min, max, disabled, onChange }: {
  label: string; value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void;
}) {
  const [current, setDraft, pin, unpin] = useDraft(value);
  const text = current.toFixed(1);
  return <label className="knob">
    <span>{label}</span>
    <input type="range" min={min} max={max} step="0.1" value={current} disabled={disabled}
      aria-label={label} aria-valuetext={text}
      onPointerDown={pin} onPointerUp={unpin} onPointerCancel={unpin}
      onChange={(e) => { const next = e.currentTarget.valueAsNumber; setDraft(next); onChange(next); }} />
    <output>{disabled ? '—' : text}</output>
  </label>;
}

function NumField({ label, value, min, max, disabled, onChange }: {
  label: string; value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void;
}) {
  const [current, setDraft, pin, unpin] = useDraft(value);
  return <label className="knob field">
    <span>{label}</span>
    <input type="number" min={min} max={max} step="0.1" value={disabled ? '' : current} disabled={disabled}
      onFocus={pin} onBlur={unpin}
      onChange={(e) => {
        const n = e.currentTarget.valueAsNumber;
        if (Number.isNaN(n)) return;
        const next = Math.min(max, Math.max(min, n));
        setDraft(next); onChange(next);
      }} />
  </label>;
}

function Pad({ title, x, y, mode, disabled, onChange }: {
  title: string; x: number; y: number; mode: 'Color' | 'FX' | 'Pan'; disabled: boolean;
  onChange: (x: number, y: number) => void;
}) {
  const [draftX, setX] = useDraft(x);
  const [draftY, setY] = useDraft(y);
  const [dragging, setDragging] = useState(false);
  const change = (nextX: number, nextY: number) => {
    setX(nextX); setY(nextY);
    onChange(nextX, nextY);
  };
  const place = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const box = event.currentTarget.getBoundingClientRect();
    const nextX = Math.min(0.5, Math.max(-0.5, (event.clientX - box.left) / box.width - 0.5));
    const nextY = Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height));
    if (commit) change(nextX, nextY);
    else { setX(nextX); setY(nextY); }
  };
  const reset = () => { if (!disabled) change(0, 0); };
  return <>
    <div className={`pad ${mode.toLowerCase()}`} aria-label={`${title} ${mode} pad`} aria-disabled={disabled}
      title="Klik dua kali untuk reset" onDoubleClick={reset}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0 || !e.isPrimary) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true); place(e, false);
      }} onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) place(e, false); }}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        setDragging(false); if (!disabled) place(e, true);
      }} onLostPointerCapture={() => setDragging(false)}>
      <span className="crosshair" aria-hidden="true" />
      <span className="puck" style={{ left: `${(draftX + 0.5) * 100}%`, top: `${(1 - draftY) * 100}%` }} aria-hidden="true" />
    </div>
    <div className="pad-controls">
      <input type="range" min="-0.5" max="0.5" step="0.01" aria-label={`${mode} X`} value={draftX} disabled={disabled || dragging}
        onChange={(e) => change(e.currentTarget.valueAsNumber, draftY)} />
      <input type="range" min="0" max="1" step="0.01" aria-label={`${mode} Y`} value={draftY} disabled={disabled || dragging}
        onChange={(e) => change(draftX, e.currentTarget.valueAsNumber)} />
      <button type="button" disabled={disabled || dragging} onClick={reset}>Reset</button>
    </div>
  </>;
}

function EqDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [cells, setCells] = useState<EqCell[]>([]);
  const [error, setError] = useState('');
  const [bars, setBars] = useState(true);
  useEffect(() => {
    ref.current?.showModal();
    void invoke<EqCell[]>('read_bus_eq', { id }).then(setCells, (e) => setError(message(e)));
  }, [id]);
  const patch = (cell: number, field: EqField, value: number) => {
    const key = field === 'type' ? 'kind' : field === 'freq' ? 'freq' : field;
    setCells((prev) => prev.map((c, i) => i === cell ? { ...c, [key]: value } : c));
    void invoke('set_bus_eq', { id, cell, field, value }).catch((e) => setError(message(e)));
  };
  return <dialog ref={ref} onClose={onClose} aria-label={`Parametric EQ ${labels[id]}`}>
    <header><h2>6-Band EQ · {labels[id]} · CH 1</h2>
      <div className="eq-view">
        <button aria-pressed={bars} onClick={() => setBars(true)}>Bar</button>
        <button aria-pressed={!bars} onClick={() => setBars(false)}>Field</button>
      </div></header>
    {error && <p className="alert" role="alert">{error}</p>}
    {cells.length && bars ? <div className="eq-bars">{cells.map((cell, i) => <div key={i} className={`eq-band ${cell.on ? '' : 'off'}`}>
      <input type="number" min={-36} max={18} step={0.1} value={cell.gain} aria-label={`Band ${i + 1} gain`}
        onChange={(e) => { if (!Number.isNaN(e.currentTarget.valueAsNumber)) patch(i, 'gain', Math.min(18, Math.max(-36, e.currentTarget.valueAsNumber))); }} />
      <input type="range" className="eq-slider" min={-36} max={18} step={0.5} value={cell.gain} aria-label={`Band ${i + 1} gain bar`}
        onDoubleClick={() => patch(i, 'gain', 0)} onChange={(e) => patch(i, 'gain', e.currentTarget.valueAsNumber)} />
      <span className="eq-freq">{cell.freq >= 1000 ? `${(cell.freq / 1000).toFixed(1)}k` : Math.round(cell.freq)}</span>
      <label><input type="checkbox" checked={cell.on} aria-label={`Band ${i + 1} on`} onChange={(e) => patch(i, 'on', Number(e.currentTarget.checked))} />{i + 1}</label>
    </div>)}</div> : cells.length ? <table><thead><tr><th>On</th><th>Tipe</th><th>Frekuensi</th><th>Gain</th><th>Q</th></tr></thead>
      <tbody>{cells.map((cell, i) => <tr key={i}>
        <td><input type="checkbox" checked={cell.on} aria-label={`Band ${i + 1} on`}
          onChange={(e) => patch(i, 'on', Number(e.currentTarget.checked))} /></td>
        <td><select value={cell.kind} aria-label={`Band ${i + 1} type`}
          onChange={(e) => patch(i, 'type', Number(e.currentTarget.value))}>
          {eqTypes.map((type, value) => <option key={type} value={value}>{type}</option>)}
        </select></td>
        <td><input type="number" min={20} max={20000} value={Math.round(cell.freq)} aria-label={`Band ${i + 1} frequency`}
          onChange={(e) => patch(i, 'freq', e.currentTarget.valueAsNumber)} /></td>
        <td><input type="number" min={-36} max={18} step={0.1} value={cell.gain} aria-label={`Band ${i + 1} gain`}
          onChange={(e) => patch(i, 'gain', e.currentTarget.valueAsNumber)} /></td>
        <td><input type="number" min={1} max={100} value={cell.q} aria-label={`Band ${i + 1} Q`}
          onChange={(e) => patch(i, 'q', e.currentTarget.valueAsNumber)} /></td>
      </tr>)}</tbody></table> : <p className="empty">Reading EQ…</p>}
  </dialog>;
}

function ChannelStrip({ id, config, channel, stereo, connected, editing, modules, patch, send, setPad }: {
  id: number; config: ChannelLayout; channel: Channel; stereo?: Stereo; connected: boolean; editing: boolean;
  modules: Profile['modules']; patch: (patch: Partial<ChannelLayout>) => void;
  send: (control: Control, value: number, index?: number) => void;
  setPad: (mode: PadMode, x: number, y: number) => void;
}) {
  const [gain, setGain, pinGain, unpinGain] = useDraft(channel.gain);
  const [typing, setTyping] = useState(false);
  type Fade = { timers: ReturnType<typeof setTimeout>[]; orig: number; muting: boolean; muted: boolean; level: number; done: boolean; until: number };
  const fade = useRef<Fade | null>(null);
  // Mute fades gain to -60 dB over FADE_MS, mutes, then restores the fader; unmute reverses it.
  // Fast clicks trust our own last-sent state (the snapshot lags ~100-200 ms), so the fader always ends at `orig`.
  const toggleMute = () => {
    const prev = fade.current;
    const trust = prev !== null && (!prev.done || Date.now() < prev.until);
    prev?.timers.forEach(clearTimeout);
    const muting = trust ? !prev.muting : !channel.mute;
    const run: Fade = {
      timers: [], muting, done: false, until: 0,
      orig: trust ? prev.orig : channel.gain,
      level: trust ? prev.level : channel.gain,
      muted: trust ? prev.muted : channel.mute,
    };
    fade.current = run;
    const put = (v: number) => { run.level = v; send('gain', v); };
    const end = () => { run.done = true; run.until = Date.now() + 800; };
    const ramp = (from: number, to: number, done: () => void) => {
      for (let i = 1; i <= FADE_STEPS; i++)
        run.timers.push(setTimeout(() => {
          put(Math.round((from + ((to - from) * i) / FADE_STEPS) * 10) / 10);
          if (i === FADE_STEPS) done();
        }, (FADE_MS / FADE_STEPS) * i));
    };
    const finishMute = () => { send('mute', 1); run.muted = true; put(run.orig); end(); };
    if (muting) {
      if (run.level <= -60) finishMute();
      else ramp(run.level, -60, finishMute);
    } else if (run.orig <= -60) {
      send('mute', 0); run.muted = false; end();
    } else if (run.muted) {
      put(-60); send('mute', 0); run.muted = false;
      ramp(-60, run.orig, end);
    } else {
      ramp(run.level, run.orig, end);
    }
  };
  const peak = useSmoothDb(stereo?.[0]);
  const [padMode, setPadMode] = useState<PadMode>('color');
  const detail = useRef<HTMLDialogElement>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [eqOpen, setEqOpen] = useState(false);
  useEffect(() => { if (detailOpen) detail.current?.showModal(); }, [detailOpen]);
  const title = config.customName || channel.label || labels[id];
  const bus = id >= 8;
  const physical = id < 5;
  const showPad = physical && modules.intellipan && config.modules.intellipan;
  const showAudibility = physical && modules.audibility && config.modules.audibility;
  const showEq = id >= 5 && !bus && config.modules.eqFx;
  const showSends = !bus && modules.fxSends && config.modules.eqFx;
  const pad = channel.pad ?? [0, 0, 0, 0, 0, 0];
  const padAt = padModes.indexOf(padMode) * 2;
  const activeRoutes = routes.filter((_, i) => channel.routes[i]);
  const routePill = activeRoutes.length > 3 ? `${activeRoutes.slice(0, 2).join('·')}+${activeRoutes.length - 2}` : activeRoutes.join('·') || 'NONE';
  const fxActive = Boolean(channel.eq?.some((v) => v !== 0)) || Boolean(channel.bus?.returns.some((v) => v !== 0));
  return <div className="strip-col"><article className={`strip ${bus ? 'bus' : physical ? '' : 'virt'} ${channel.mute ? 'muted' : ''}`} aria-label={title}>
    <span className="strip-accent" aria-hidden="true" />
    <header className="strip-head">
      <div className="strip-row">
        <span className="strip-id">{labels[id]}</span>
        {(physical || bus) && <button className="eq-chip" disabled={!connected} aria-pressed={Boolean(channel.eqOn)} aria-label={`EQ ${title}`}
          title="Click: EQ on/off · Right-click: open EQ" onClick={() => send('eqOn', Number(!channel.eqOn))}
          onContextMenu={() => setEqOpen(true)}>EQ</button>}
        {!bus && <button className="route-pill" onClick={() => setDetailOpen(true)} title="Active routing (click to change)">{routePill}</button>}
        <button className="icon-button" onClick={() => setDetailOpen(true)} aria-label={`Detail ${title}`} aria-haspopup="dialog" title="Routing, Intellipan & FX">⋯</button>
      </div>
      <div className="strip-row">
        <h3 title={title}>{title}</h3>
        <span className="dots" title="EQ / FX status" aria-hidden="true">
          <span className={`dot ${channel.eq?.some((v) => v !== 0) ? 'on mint' : ''}`} />
          <span className={`dot ${fxActive ? 'on orange' : ''}`} />
        </span>
      </div>
      <p className="strip-device" title={channel.device ?? ''}>{channel.device || monoLabels[channel.mono] || '—'}</p>
    </header>
    <section className="strip-center">
      <div className="strip-center-top">
        <span className="peak-readout">{connected && peak != null ? (peak === -Infinity ? '-∞' : `${peak}dB`) : '—'}</span>
        <span className={`mode-tag ${channel.mono === 2 ? 'reverse' : channel.mono ? 'mono' : ''}`}>{channel.mono === 2 ? 'REV' : channel.mono ? 'MONO' : 'ST'}</span>
      </div>
      <div className="fader-cluster">
        <Fader title={title} value={gain} disabled={!connected}
          onChange={(next) => { setGain(next); send('gain', next); }} onPin={pinGain} onUnpin={unpinGain} />
        <div className="scale" aria-hidden="true"><span>+12</span><i /><span className="zero">0</span><i /><span>-12</span><i /><span>-30</span><span>-60</span></div>
        <MeterBar title={title} stereo={connected ? stereo : undefined} />
      </div>
    </section>
    <footer className="strip-foot">
      {typing ? <input className="gain-input" type="number" autoFocus min={-60} max={12} step={0.1} defaultValue={gain}
        aria-label={`Gain ${title} (dB)`}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setTyping(false);
          else if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={(e) => {
          const n = e.currentTarget.valueAsNumber;
          setTyping(false);
          if (Number.isNaN(n)) return;
          const next = Math.min(12, Math.max(-60, Math.round(n * 10) / 10));
          setGain(next); send('gain', next);
        }} />
        : <button className="gain" disabled={!connected} onDoubleClick={() => setTyping(true)} title="Double-click to type dB">
          {connected ? gainText(gain) : '— dB'}
        </button>}
      <div className="switches">
        {!bus && modules.solo && <button className="solo" disabled={!connected} aria-pressed={channel.solo} aria-label={`Solo ${title}`} onClick={() => send('solo', Number(!channel.solo))}>S</button>}
        {modules.mono && <button className="mono" disabled={!connected} aria-pressed={channel.mono !== 0} aria-label={`Mode ${title}: ${monoLabels[channel.mono] ?? 'Stereo'}`}
          title={monoLabels[channel.mono]} onClick={() => send('mono', (channel.mono + 1) % (bus ? 3 : 2))}>{channel.mono === 2 ? 'REV' : 'M'}</button>}
        <button className="mute" disabled={!connected} aria-pressed={channel.mute} aria-label={`Mute ${title}`} onClick={toggleMute}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" />
            {channel.mute ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />}
          </svg></button>
      </div>
    </footer>
    <dialog ref={detail} className="channel-detail wide" aria-label={`Detail ${title}`} onClose={() => setDetailOpen(false)}>
      {detailOpen && <>
      <header>
        <div className="modal-title">
          <span className="strip-id">{labels[id]}</span>
          <h2>{title}</h2>
          <span className="gain-pill">{connected ? gainText(gain) : '— dB'}</span>
        </div>
        <span className="head-actions">
          {physical && <button disabled={!connected} onClick={() => setEqOpen(true)} title="6-Band EQ">EQ</button>}
          <button className="icon-button" onClick={() => detail.current?.close()} aria-label="Close">✕</button>
        </span>
      </header>
      {editing && <input className="rename" aria-label={`Name ${labels[id]}`} placeholder="Channel name" maxLength={48}
        value={config.customName} onChange={(e) => patch({ customName: e.target.value })} />}
      {editing && !bus && <div className="module-picks">{moduleToggles.filter(([key]) => physical || key === 'eqFx').map(([key, text]) => <label key={key}>
        <input type="checkbox" checked={config.modules[key]}
          onChange={(e) => patch({ modules: { ...config.modules, [key]: e.currentTarget.checked } })} />{text}
      </label>)}</div>}
      <div className="detail-grid">
      {!bus && <section className="module" aria-label={`Routing ${title}`}>
        <div className="module-head"><span>Output &amp; bus routing</span></div>
        <div className="routing">{routes.map((route, i) => {
          const shown = Boolean(config.routeMask & (1 << i));
          return editing || shown ? <button key={route} disabled={!editing && !connected}
            aria-pressed={editing ? shown : Boolean(channel.routes[i])} aria-label={`${editing ? 'Route visibility' : 'Routing'} ${title} ${route}`}
            onClick={() => editing ? patch({ routeMask: config.routeMask ^ (1 << i) }) : send('route', Number(!channel.routes[i]), i)}>{route}</button> : null;
        })}</div>
      </section>}
      {showPad && <section className="module" aria-label={`Intellipan ${title}`}>
        <div className="module-head"><span>Intellipan</span>
          <span className="pad-modes">{padModes.map((m) => <button key={m} aria-pressed={padMode === m} onClick={() => setPadMode(m)}>{padLabels[m]}</button>)}</span></div>
        <Pad key={padMode} title={title} mode={padLabels[padMode]} x={pad[padAt]} y={pad[padAt + 1]}
          disabled={!connected || !channel.pad} onChange={(x, y) => setPad(padMode, x, y)} />
      </section>}
    {showEq && <section className="module" aria-label={`EQ ${title}`}>
      <div className="module-head"><span>EQ</span></div>
      <div className="knobs">{bands.map((name, i) => <Knob key={name} label={name} value={channel.eq?.[i] ?? 0}
        min={-12} max={12} disabled={!connected || !channel.eq} onChange={(value) => send('eqGain', value, i)} />)}</div>
    </section>}
    {(showAudibility || showSends) && <div className="pair">
    {showAudibility && <section className="module" aria-label={`Audibility ${title}`}>
      <div className="module-head"><span>Audibility</span></div>
      <div className="knobs one">{(['Gate', 'Comp', 'Denoiser'] as const).map((name, i) => <NumField key={name} label={name}
        value={channel.audibility?.[i] ?? 0} min={0} max={10} disabled={!connected}
        onChange={(value) => send(name.toLowerCase() as Control, value)} />)}</div>
    </section>}
    {showSends && <section className="module" aria-label={`FX Sends ${title}`}>
      <div className="module-head"><span>FX Sends</span></div>
      <div className="knobs one">{sends.map((name, i) => <NumField key={name} label={name} value={channel.sends[i] ?? 0}
        min={0} max={10} disabled={!connected} onChange={(value) => send('send', value, i)} />)}</div>
    </section>}
    </div>}
    {bus && <section className="module" aria-label={`Master FX ${title}`}>
      <div className="module-head"><span>Master FX</span>
        <button disabled={!connected} aria-pressed={channel.bus?.eqAb} aria-label={`EQ A/B ${title}`}
          onClick={() => send('eqAb', Number(!channel.bus?.eqAb))}>A/B</button>
        <button disabled={!connected} aria-pressed={channel.bus?.eqOn} aria-label={`EQ ${title}`}
          onClick={() => send('eqOn', Number(!channel.bus?.eqOn))}>EQ</button></div>
      <div className="knobs four">{sends.map((name, i) => <Knob key={name} label={`Ret ${name}`}
        value={channel.bus?.returns[i] ?? 0} min={0} max={10} disabled={!connected}
        onChange={(value) => send('return', value, i)} />)}</div>
      <button className="wide" disabled={!connected} onClick={() => setEqOpen(true)}>6-Band EQ</button>
    </section>}
      </div>
      </>}
    </dialog>
    {eqOpen && <EqDialog id={id} onClose={() => setEqOpen(false)} />}
  </article>
  {!bus && config.routeMask !== 0 && <div className="route-card" aria-label={`Routing ${title}`}>
    {routes.map((route, i) => config.routeMask & (1 << i) ? <button key={route} disabled={!connected} aria-pressed={Boolean(channel.routes[i])}
      aria-label={`Routing ${title} ${route}`} onClick={() => send('route', Number(!channel.routes[i]), i)}>{route}</button> : null)}
  </div>}
  </div>;
}

function OutDialog({ outs, onClose, onToggle }: { outs: number[]; onClose: () => void; onToggle: (bus: number, on: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  // ponytail: selection is local (not read back from Potato); add a Recorder.A1.. read if it must follow Voicemeeter.
  return <dialog ref={ref} className="out-dialog" aria-label="Recorder playback outputs" onClose={onClose}>
    <header><h2>Playback output</h2><button onClick={() => ref.current?.close()}>Close</button></header>
    <div className="check-grid">{routes.map((r, i) => <label key={r}>
      <input type="checkbox" checked={outs.includes(i)} onChange={(e) => onToggle(i, e.currentTarget.checked)} />{r}</label>)}</div>
  </dialog>;
}

function FxButtons({ fx, show, connected, returns, onError, onReturn }: {
  fx: boolean[]; show: boolean[]; connected: boolean; returns: number[]; onError: (e: string) => void; onReturn: (index: number, value: number) => void;
}) {
  const [open, setOpen] = useState<0 | 1 | null>(null);
  const names = ['Reverb', 'Delay'] as const;
  const set = (i: 0 | 1, field: 'On' | 'AB', on: boolean) =>
    void invoke('set_fx', { name: names[i], field, on }).catch((e) => onError(message(e)));
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open !== null) ref.current?.showModal(); }, [open]);
  return <div className="fx-btns" aria-label="Master FX">
    {names.map((name, i) => show[i] && <button key={name} disabled={!connected} aria-pressed={fx[i * 2]}
      title="Click: on/off · Right-click: open panel" onClick={() => set(i as 0 | 1, 'On', !fx[i * 2])}
      onContextMenu={() => setOpen(i as 0 | 1)}>{name}</button>)}
    {open !== null && <dialog ref={ref} className="out-dialog" aria-label={`${names[open]} panel`} onClose={() => setOpen(null)}>
      <header><h2>{names[open]}</h2></header>
      <div className="fx-panel">
        <label><input type="checkbox" checked={fx[open * 2]} onChange={(e) => set(open, 'On', e.currentTarget.checked)} />On</label>
        <label><input type="checkbox" checked={fx[open * 2 + 1]} onChange={(e) => set(open, 'AB', e.currentTarget.checked)} />Preset B</label>
        <NumField label="Return (all buses)" value={returns[open] ?? 0} min={0} max={10} disabled={!connected} onChange={(v) => onReturn(open, v)} />
      </div>
    </dialog>}
  </div>;
}

type SingCfg = Layout['sing'];
const MIC_THRESHOLD = 0.01; // -40 dBFS: mic counts as "speaking" above this.
const MUSIC_THRESHOLD = 0.003;
const SING_MARGIN_DB = 6; // ponytail: fixed; make it a setting if the voice should sit higher/lower over the music.
const dbOf = (v: number) => 20 * Math.log10(v);

// SING: music stays untouched. While the mic speaks, its gain is nudged (within ±cfg.duck dB of its base)
// so the voice sits SING_MARGIN_DB above the music's level. Holds when the mic is silent.
function useSing(on: boolean, cfg: SingCfg, levels: Record<number, Stereo>, snapshot: Snapshot, onError: (e: string) => void) {
  const latest = useRef({ cfg, levels, snapshot });
  latest.current = { cfg, levels, snapshot };
  useEffect(() => {
    if (!on) return;
    const base = new Map<number, number>();
    const sent = new Map<number, { value: number; at: number }>();
    let adj = 0;
    const put = (id: number, value: number) => {
      sent.set(id, { value, at: Date.now() });
      void invoke('set_channel', { id, control: 'gain', value }).catch((e) => onError(message(e)));
    };
    const bits = (mask: number) => [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => mask & (1 << i));
    const peak = (ids: number[]) => Math.max(0, ...ids.map((i) => Math.max(levels_()[i]?.[0] ?? 0, levels_()[i]?.[1] ?? 0)));
    const levels_ = () => latest.current.levels;
    const timer = setInterval(() => {
      const { cfg, snapshot } = latest.current;
      if (snapshot.channels.length !== labels.length) return;
      const mics = bits(cfg.mic);
      const music = bits(cfg.music).filter((i) => !mics.includes(i));
      for (const id of [...base.keys()]) if (!mics.includes(id)) { put(id, base.get(id)!); base.delete(id); sent.delete(id); }
      const mic = peak(mics), song = peak(music);
      if (mic > MIC_THRESHOLD) {
        if (song > MUSIC_THRESHOLD) {
          const err = dbOf(song) + SING_MARGIN_DB - dbOf(mic);
          adj += Math.max(-0.5, Math.min(0.5, err * 0.03));
        } else adj *= 0.98; // no music: ease back to the base gain
      }
      adj = Math.max(-cfg.duck, Math.min(cfg.duck, adj));
      for (const id of mics) {
        const live = snapshot.channels[id].gain;
        const last = sent.get(id);
        // The user moved the fader (snapshot lags ~200 ms, so only judge settled values): adopt it as the new base.
        if (!base.has(id)) base.set(id, live);
        else if (last && Date.now() - last.at > 600 && Math.abs(live - last.value) > 0.6) base.set(id, live - adj);
        const value = Math.round(Math.min(12, Math.max(-60, base.get(id)! + adj)) * 10) / 10;
        if (!last || Math.abs(value - last.value) >= 0.1) put(id, value);
      }
    }, 50);
    return () => {
      clearInterval(timer);
      for (const [id, value] of base) void invoke('set_channel', { id, control: 'gain', value }).catch((e) => onError(message(e)));
    };
  }, [on]);
}

function Sing({ on, cfg, connected, onToggle, onCfg }: {
  on: boolean; cfg: SingCfg; connected: boolean; onToggle: () => void; onCfg: (cfg: SingCfg) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) ref.current?.showModal(); }, [open]);
  const flip = (key: 'mic' | 'music', bit: number) => onCfg({ ...cfg, [key]: cfg[key] ^ (1 << bit) });
  return <>
    <button className="sing-btn" disabled={!connected} aria-pressed={on} title="Click: auto-balance the mic against the music · Right-click: settings"
      onClick={onToggle} onContextMenu={() => setOpen(true)}>SING</button>
    {open && <dialog ref={ref} className="out-dialog sing-dialog" aria-label="SING settings" onClose={() => setOpen(false)}>
      <header><h2>SING</h2></header>
      <section className="sh-group"><h3>Mic</h3><div className="sh-grid">
        {labels.slice(0, 5).map((l, i) => <label key={l}><input type="checkbox" checked={Boolean(cfg.mic & (1 << i))} onChange={() => flip('mic', i)} />{l}</label>)}
      </div></section>
      <section className="sh-group"><h3>Music</h3><div className="sh-grid">
        {labels.slice(0, 8).map((l, i) => i < 5 && cfg.mic & (1 << i) ? null :
          <label key={l}><input type="checkbox" checked={Boolean(cfg.music & (1 << i))} onChange={() => flip('music', i)} />{l}</label>)}
      </div></section>
      <NumField label="Range ± (dB)" value={cfg.duck} min={0} max={30} disabled={false} onChange={(duck) => onCfg({ ...cfg, duck })} />
    </dialog>}
  </>;
}

function Recorder({ connected, onError }: { connected: boolean; onError: (e: string) => void }) {
  const [mode, setMode] = useState<'stop' | 'play' | 'rec'>('stop');
  const [sec, setSec] = useState(0);
  const [file, setFile] = useState('');
  const [length, setLength] = useState(0);
  const [outs, setOuts] = useState<number[]>([]);
  const [picking, setPicking] = useState(false);
  // Smooth clock: advance by real elapsed time every animation frame (not once per second).
  const clockRef = useRef({ t0: 0, s0: 0 });
  const secRef = useRef(0);
  const dragging = useRef(false);
  secRef.current = sec;
  const resync = (to: number) => { clockRef.current = { t0: performance.now(), s0: to }; };
  useEffect(() => {
    if (mode !== 'play' && mode !== 'rec') return;
    resync(secRef.current);
    let frame = requestAnimationFrame(function tick() {
      if (!dragging.current) setSec(clockRef.current.s0 + (performance.now() - clockRef.current.t0) / 1000);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);
  // Reached the end of the file: behave like stop.
  useEffect(() => {
    if (mode === 'play' && length > 0 && sec >= length) { setMode('stop'); setSec(0); }
  }, [sec, mode, length]);
  // After a take, show the new file (name + length) from Potato's recording folder; it may still be flushing, so retry briefly.
  const loadLatest = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((done) => setTimeout(done, 700));
      try {
        const f = await invoke<{ path: string; duration: number | null } | null>('recorder_latest');
        if (f) { setFile(f.path.split(/[\/]/).pop() ?? f.path); setLength(f.duration ?? 0); setSec(0); return; }
      } catch (e) { onError(message(e)); return; }
    }
  };
  // Stop keeps the position (playback).
  const act = (action: string, next?: typeof mode) =>
    void (action === 'play' && sec > 0 && length > 0 ? invoke('recorder_goto', { sec: Math.floor(sec) }) : Promise.resolve())
      .then(() => invoke('recorder', { action }))
      .then(() => {
        if (next) setMode(next);
        if (next === 'stop' && mode === 'rec') { setSec(0); setFile(''); setLength(0); void loadLatest(); }
      }, (e) => onError(message(e)));
  const clock = (n: number) => [n / 3600, (n % 3600) / 60, n % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
  const seek = (to: number) => {
    dragging.current = false;
    resync(to);
    void invoke('recorder_goto', { sec: Math.floor(to) }).then(() => setSec(to), (e) => onError(message(e)));
  };
  // ponytail: position is local (Potato exposes no readable tape position); it mirrors the transport and the seek bar only.
  return <div className="tape" aria-label="Cassette recorder">
    <div className="tape-row">
      <output className="tape-time">{clock(sec)}{length > 0 && ` / ${clock(length)}`}</output>
      <button aria-label="Open music file" disabled={!connected} title={file || 'Open music file'}
        onClick={() => void invoke<{ path: string; duration: number | null } | null>('recorder_load').then((f) => {
          if (f) { setFile(f.path.split(/[\/]/).pop() ?? f.path); setLength(f.duration ?? 0); setMode('stop'); setSec(0); }
        }, (e) => onError(message(e)))}>⏏</button>
      {file && <span className="tape-file" title={file}>{file}</span>}
      <button aria-label="Play" disabled={!connected} aria-pressed={mode === 'play'} onClick={() => act('play', 'play')}>▶</button>
      <button aria-label="Stop" disabled={!connected} onClick={() => act('stop', 'stop')}>■</button>
      <button className="rec" aria-label="Record" disabled={!connected} aria-pressed={mode === 'rec'} onClick={() => act('record', 'rec')}>●</button>
      <button className="tape-out" aria-label="Playback outputs" aria-haspopup="dialog" disabled={!connected} onClick={() => setPicking(true)}
        title="Playback output buses">→ {outs.length ? outs.map((i) => routes[i]).join('·') : '—'}</button>
    </div>
    {length > 0 && <input type="range" className="tape-seek" min={0} max={length} step="any" value={Math.min(sec, length)}
      disabled={!connected} aria-label="Music position" title="Seek"
      onPointerDown={() => { dragging.current = true; }} onChange={(e) => setSec(e.currentTarget.valueAsNumber)} onPointerUp={(e) => seek(e.currentTarget.valueAsNumber)}
      onKeyUp={(e) => seek(e.currentTarget.valueAsNumber)} />}
    {picking && <OutDialog outs={outs} onClose={() => setPicking(false)} onToggle={(i, on) =>
      void invoke('recorder_out', { bus: i, on }).then(
        () => setOuts((prev) => on ? [...prev, i].sort() : prev.filter((x) => x !== i)), (err) => onError(message(err)))} />}
  </div>;
}

function App() {
  const [layout, setLayout] = useState(() => parseLayout(demo ? {
    theme: query.get('theme'),
    // Screenshots show one strip per kind: IN 1, VAIO, A1, B1 (override with ?keep=0,5,8,13).
    presets: [{ name: 'Full Potato', channels: labels.map((_, id) => ({
      visibility: (query.get('keep') ?? '0,5,8,13').split(',').map(Number).includes(id) ? 'visible' : 'hidden' })) }],
  } : null));
  const current = useRef(layout);
  const [editing, setEditing] = useState(false);
  const visibility = useRef<HTMLDivElement>(null);
  const [showHide, setShowHide] = useState(false);
  const [pickTheme, setPickTheme] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const themeDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (pickTheme) themeDialog.current?.showModal(); }, [pickTheme]);
  useEffect(() => { document.documentElement.dataset.theme = layout.theme; }, [layout.theme]);
  const groupsEl = useRef<HTMLDivElement>(null);
  // Count wrapped group rows so strip height can shrink to fit all rows in the window.
  const measureRows = () => {
    const el = groupsEl.current;
    if (!el) return;
    const rows = new Set([...el.children].map((c) => (c as HTMLElement).offsetTop)).size;
    el.style.setProperty('--rows', String(Math.max(1, rows)));
    // Show the A1-B3 card only if it still fits under the cards: measure real free space below the groups
    // (minus the card's own height when it is already shown, so the decision does not flip-flop).
    const extra = 65 * rows;
    const base = el.getBoundingClientRect().bottom - (el.dataset.roomy === 'true' ? extra : 0);
    el.dataset.roomy = String(window.innerHeight - base - 16 >= extra);
  };
  useEffect(() => {
    const el = groupsEl.current;
    if (!el) return;
    const observer = new ResizeObserver(measureRows);
    observer.observe(el);
    window.addEventListener('resize', measureRows);
    return () => { observer.disconnect(); window.removeEventListener('resize', measureRows); };
  }, []);
  useEffect(measureRows);
  const showHideDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (showHide) showHideDialog.current?.showModal(); }, [showHide]);
  const [ready, setReady] = useState(!desktop);
  const [storageError, setStorageError] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>(demo ? demoSnapshot() : { status: desktop ? 'Connecting to Potato…' : 'Browser preview · audio controls only on desktop', channels: [], fx: [false, false, false, false] });
  const [levels, setLevels] = useState<Record<number, Stereo>>(demo ? demoLevels() : {});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef(Promise.resolve());
  const changed = useRef(false);
  const save = () => {
    clearTimeout(saveTimer.current);
    if (!desktop || !changed.current) return Promise.resolve();
    const next = current.current;
    const write = queue.current.then(() => invoke<void>('save_layout', { config: next }));
    queue.current = write.then(() => {
      if (next === current.current) changed.current = false;
      setError('');
    }, (e) => setError(`Failed to save layout: ${message(e)}`));
    return write;
  };
  const update = (next: Layout) => {
    current.current = next;
    setLayout(next);
    if (desktop && ready && !storageError) {
      changed.current = true;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save().catch(() => {}), 300);
    }
  };
  useEffect(() => {
    if (!desktop) return;
    const win = desktop;
    const subscriptions = [
      listen<[number, Stereo][]>('mixer-levels', ({ payload }) => setLevels(Object.fromEntries(payload))),
    ];
    const report = (e: unknown) => setError(message(e));
    subscriptions.forEach((sub) => void sub.catch(report));
    let live = true;
    let polling = false;
    const poll = () => {
      if (polling) return;
      polling = true;
      void invoke<Snapshot>('mixer_snapshot').then((data) => { if (live) setSnapshot(data); }, report)
        .finally(() => { polling = false; });
    };
    poll();
    const timer = setInterval(poll, 200);
    void (async () => {
      try {
        const raw = await invoke<unknown>('load_layout');
        if (!live) return;
        const config = parseLayout(raw);
        current.current = config;
        setLayout(config);
        if (raw !== null) {
          await win.setSize(new LogicalSize(config.window.width, config.window.height)).catch(report);
          await win.setAlwaysOnTop(config.window.alwaysOnTop).catch(report);
        }
      } catch (e) {
        if (live) setStorageError(`Layout unreadable; file left untouched. ${message(e)}`);
      } finally {
        if (live) setReady(true);
      }
    })();
    return () => {
      live = false;
      clearInterval(timer);
      subscriptions.forEach((sub) => void sub.then((unlisten) => unlisten(), () => {}));
    };
  }, []);
  useEffect(() => {
    if (!desktop || !ready || storageError) return;
    const win = desktop;
    let live = true;
    let closing = false;
    let resize = 0;
    const subs = [win.onResized(({ payload }) => {
      const revision = ++resize;
      void win.scaleFactor().then((scale) => {
        if (!live || revision !== resize) return;
        const width = Math.round(payload.width / scale), height = Math.round(payload.height / scale);
        const prev = current.current;
        if (width < 340 || height < 360 || (prev.window.width === width && prev.window.height === height)) return;
        update({ ...prev, window: { ...prev.window, width, height } });
      }).catch((e) => setError(message(e)));
    }), win.onCloseRequested(async (event) => {
      if (!changed.current && !closing) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        await save();
        await win.destroy();
      } catch (e) {
        setError(`Failed to save layout. Window stays open. ${message(e)}`);
        closing = false;
      }
    })];
    subs.forEach((sub) => void sub.catch((e) => setError(message(e))));
    return () => {
      live = false;
      clearTimeout(saveTimer.current);
      subs.forEach((sub) => void sub.then((unlisten) => unlisten(), () => {}));
    };
  }, [ready, storageError]);

  const connected = snapshot.channels.length === labels.length;
  const [singOn, setSingOn] = useState(false);
  useSing(singOn, layout.sing, levels, snapshot, setError);
  const profile = layout.presets.find((p) => p.name === layout.activePreset)!;
  const patchProfile = (fn: (profile: Profile) => Profile) => {
    const prev = current.current;
    update({ ...prev, presets: prev.presets.map((p) => p.name === prev.activePreset ? fn(p) : p) });
  };
  const patchChannel = (id: number, patch: Partial<ChannelLayout>) => patchProfile((p) => ({
    ...p, channels: p.channels.map((c, i) => i === id ? { ...c, ...patch } : c),
  }));
  const showing = profile.channels.map((c, id) => {
    const data = snapshot.channels[id];
    return c.visibility !== 'hidden' && (id < 8 ? profile.showInputs : profile.showMasterSection) &&
      (!layout.hideInactive || editing || !data || (!data.mute && data.device !== ''));
  });
  const mask = showing.reduce((bits, shown, i) => shown ? bits | (1 << i) : bits, 0) | (singOn ? layout.sing.mic | layout.sing.music : 0);
  useEffect(() => {
    if (desktop) void invoke('meter_channels', { mask }).catch((e) => setError(message(e)));
  }, [mask]);
  const toggleTop = async () => {
    const on = !current.current.window.alwaysOnTop;
    try {
      await desktop?.setAlwaysOnTop(on);
      const prev = current.current;
      update({ ...prev, window: { ...prev.window, alwaysOnTop: on } });
    } catch (e) { setError(message(e)); }
  };
  const group = (from: number, to: number) => profile.channels.slice(from, to).map((config, offset) => {
    const id = from + offset;
    return showing[id] && <ChannelStrip key={id} id={id} config={config} channel={snapshot.channels[id] ?? blank}
      stereo={levels[id]} connected={connected} editing={editing} modules={profile.modules} patch={(patch) => patchChannel(id, patch)}
      send={(control, value, index) => void invoke('set_channel', { id, control, value, index }).catch((e) => setError(message(e)))}
      setPad={(mode, x, y) => void invoke('set_pad', { id, mode, x, y }).catch((e) => setError(message(e)))} />;
  });

  return <main>
    <header className="topbar">
      <div className="brand">
        <span className="brand-logo" aria-hidden="true">NV</span>
        <div>
          <h1>NoVeeter <span className="badge">POTATO</span></h1>
          <div className="kicker">created by NoveM</div>
        </div>
        {profile.modules.recorder && <Recorder connected={connected} onError={setError} />}
        {(profile.modules.reverb || profile.modules.delay) && <FxButtons fx={snapshot.fx} show={[profile.modules.reverb, profile.modules.delay]} connected={connected} returns={snapshot.channels[8]?.bus?.returns ?? []} onError={setError}
          onReturn={(index, value) => { for (let id = 8; id < 16; id++) void invoke('set_channel', { id, control: 'return', value, index }).catch((e) => setError(message(e))); }} />}
        {profile.modules.sing && <Sing on={singOn} cfg={layout.sing} connected={connected} onToggle={() => setSingOn(!singOn)}
          onCfg={(sing) => update({ ...current.current, sing })} />}
      </div>
      <div className={`status ${connected ? 'live' : ''}`} role="status" title={snapshot.status}><span aria-hidden="true" />{connected ? 'Connected' : snapshot.status}</div>
      <button className={`restart ${restarting ? "busy" : ""}`} disabled={!connected || restarting} title="Restart audio engine" aria-label="Restart audio engine"
        onClick={() => {
          setRestarting(true);
          void invoke('restart_engine').catch((e) => setError(message(e)));
          setTimeout(() => setRestarting(false), 2000);
        }}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>
      </button>
      <div className="topbar-center">
        <div className="toolbar" aria-label="Layout">
          <button disabled={!ready} popoverTarget="channel-manager">Menu ▾</button>
          <div ref={visibility} id="channel-manager" className="manager" popover="auto">
            
            <div className="menu-actions">
              {layout.presets.length > 1 && <select aria-label="Layout preset" value={layout.activePreset} disabled={!ready} onChange={(e) => update({ ...current.current, activePreset: e.target.value })}>
                {layout.presets.map((p) => <option key={p.name}>{p.name}</option>)}
              </select>}
              <button disabled={!ready} aria-pressed={editing} onClick={() => setEditing(!editing)}>Edit layout</button>
              <button disabled={!desktop || !ready} aria-pressed={layout.window.alwaysOnTop} onClick={() => void toggleTop()}>Always on top</button>
              <button disabled={!ready} onClick={() => { visibility.current?.hidePopover(); setShowHide(true); }}>Show / Hide</button>
              <button disabled={!ready} onClick={() => { visibility.current?.hidePopover(); setPickTheme(true); }}>Theme</button>
            </div>
          </div>
        </div>
      </div>
    </header>
    {showHide && <dialog ref={showHideDialog} className="showhide" aria-label="Show / Hide" onClose={() => setShowHide(false)}>
      <header><h2>Show / Hide</h2></header>
      <section className="sh-group"><h3>Section</h3><div className="sh-grid">
        <label><input type="checkbox" checked={profile.showInputs} onChange={(e) => {
          const checked = e.currentTarget.checked;
          patchProfile((p) => ({ ...p, showInputs: checked }));
        }} />Input</label>
        <label><input type="checkbox" checked={profile.showMasterSection} onChange={(e) => {
          const checked = e.currentTarget.checked;
          patchProfile((p) => ({ ...p, showMasterSection: checked }));
        }} />Output</label>
        <label><input type="checkbox" disabled={!connected} checked={layout.hideInactive}
          onChange={(e) => update({ ...current.current, hideInactive: e.currentTarget.checked })} />Hide inactive</label>
      </div></section>
      <section className="sh-group"><h3>Module</h3><div className="sh-grid">
        {visibilityToggles.map(([key, label]) => <label key={key}><input type="checkbox" checked={profile.modules[key]}
          onChange={(e) => {
            const checked = e.currentTarget.checked;
            patchProfile((p) => ({ ...p, modules: { ...p.modules, [key]: checked } }));
          }} />{label}</label>)}
      </div></section>
      {(['Input', 'Output'] as const).map((label, g) => <section key={label} className="sh-group"><h3>{label} channel</h3><div className="sh-grid">
        {profile.channels.slice(g * 8, g * 8 + 8).map((config, offset) => {
          const id = g * 8 + offset;
          const title = config.customName || snapshot.channels[id]?.label || labels[id];
          return <label key={id} title={`${labels[id]} · ${title}`}><input type="checkbox" checked={config.visibility !== 'hidden'}
            onChange={(e) => patchChannel(id, { visibility: e.currentTarget.checked ? 'visible' : 'hidden' })} />
            <b>{labels[id]}</b><span>{title !== labels[id] ? title : ''}</span></label>;
        })}
      </div></section>)}
    </dialog>}
    {pickTheme && <dialog ref={themeDialog} className="showhide" aria-label="Theme" onClose={() => setPickTheme(false)}>
      <header><h2>Theme</h2></header>
      <div className="theme-list">{themes.map((t) => <button key={t.id} aria-pressed={layout.theme === t.id}
        onClick={() => update({ ...current.current, theme: t.id })}>
        <span className="swatch" aria-hidden="true">{t.swatch.map((c) => <i key={c} style={{ background: c }} />)}</span>{t.name}</button>)}</div>
    </dialog>}
    {(storageError || error) && <div className="alert" role="alert">{storageError || error}{error && !storageError && <button onClick={() => setError('')}>Close</button>}</div>}
    {editing && <form className="toolbar editor" onSubmit={(e) => {
      e.preventDefault();
      const title = name.trim();
      const prev = current.current;
      if (!title || prev.presets.some((p) => p.name === title) || prev.presets.length >= 32) return;
      update({ ...prev, activePreset: title, presets: [...prev.presets, { ...profile, name: title }] });
      setName('');
    }}>
      <input aria-label="New preset name" placeholder="New preset name" maxLength={48} value={name} onChange={(e) => setName(e.target.value)} />
      <button disabled={!name.trim() || layout.presets.some((p) => p.name === name.trim()) || layout.presets.length >= 32}>Save as</button>
    </form>}
    <div className="groups" ref={groupsEl}>
      {([
        ['hw', 'Hardware Inputs', 0, 5, 'hw', profile.showInputs],
        ['virt', 'Virtual Inputs', 5, 8, 'virt', profile.showInputs],
        ['out', 'Master Out A1–A5 & Bus B1–B3', 8, 16, 'out', profile.showMasterSection],
      ] as const).map(([key, title, from, to, cls, on]) => on && showing.slice(from, to).some(Boolean) &&
        <section key={key} className={`group ${cls}`} aria-label={title}>
          <h2>{title} <span>{showing.slice(from, to).filter(Boolean).length} / {to - from}</span></h2>
          <div className="channels">{group(from, to)}</div>
        </section>)}
    </div>
    {profile.showInputs !== false && !showing.some(Boolean) && <p className="empty">No channels shown. Open Menu or turn off Hide inactive.</p>}
    {!profile.showInputs && !profile.showMasterSection && <p className="empty">Input and Output are hidden. Open Menu to show them again.</p>}
  </main>;
}

document.addEventListener('contextmenu', (e) => e.preventDefault());

// Click outside any open modal (on the backdrop) closes it.
document.addEventListener('click', (e) => {
  const dialog = e.target;
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return;
  const box = dialog.getBoundingClientRect();
  const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
  if (!inside) dialog.close();
});

createRoot(document.getElementById('root')!).render(<App />);
