export const themes = [
  { id: 'midnight', name: 'Midnight', swatch: ['#0f1216', '#171c23', '#10b981'] },
  { id: 'graphite', name: 'Graphite', swatch: ['#1b1b1d', '#27272a', '#38bdf8'] },
  { id: 'ocean', name: 'Ocean', swatch: ['#0a1622', '#102236', '#22d3ee'] },
  { id: 'sunset', name: 'Sunset', swatch: ['#1a1114', '#271a1f', '#fb923c'] },
  { id: 'violet', name: 'Violet', swatch: ['#13101c', '#1c1829', '#a78bfa'] },
  { id: 'blossom', name: 'Blossom', swatch: ['#fff1f6', '#ffffff', '#ec4899'] },
  { id: 'light', name: 'Light', swatch: ['#eef1f5', '#ffffff', '#059669'] },
] as const;
export const routes = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'] as const;
export const labels = ['IN 1', 'IN 2', 'IN 3', 'IN 4', 'IN 5', 'VAIO', 'AUX', 'VAIO 3', ...routes];
export type Visibility = 'visible' | 'hidden';
export type Modules = { intellipan: boolean; audibility: boolean; eqFx: boolean };
export type ChannelLayout = { visibility: Visibility; customName: string; routeMask: number; modules: Modules };
export type Profile = {
  name: string; channels: ChannelLayout[]; showInputs: boolean; showMasterSection: boolean;
  modules: { intellipan: boolean; audibility: boolean; fxSends: boolean; solo: boolean; mono: boolean; recorder: boolean; reverb: boolean; delay: boolean; sing: boolean };
};
export type Layout = {
  activePreset: string;
  window: { width: number; height: number; alwaysOnTop: boolean };
  hideInactive: boolean;
  theme: string;
  /** SING auto-duck: mic = bitmask of IN 1-5, music = bitmask of strips 0-7, duck = max ± dB the mic gain may move. */
  sing: { mic: number; music: number; duck: number };
  presets: Profile[];
};

const defaults = (): Profile => ({
  name: 'Full Potato',
  showInputs: true,
  showMasterSection: true,
  modules: { intellipan: true, audibility: true, fxSends: true, solo: true, mono: true, recorder: true, reverb: true, delay: true, sing: true },
  channels: labels.map(() => ({
    visibility: 'visible', customName: '', routeMask: 255,
    modules: { intellipan: true, audibility: true, eqFx: true },
  })),
});

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const name = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 48) : '';
const size = (value: unknown, fallback: number, min: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(4096, Math.round(value))) : fallback;

export function parseLayout(value: unknown): Layout {
  const raw = object(value);
  const window = object(raw.window);
  const sing = object(raw.sing);
  const mask = (v: unknown, max: number, fallback: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : fallback;
  const presets: Profile[] = [];
  const legacy = Array.isArray(raw.strips) || Array.isArray(raw.buses) || !!raw.globalModules;
  for (const entry of (legacy ? [{ ...raw, name: raw.activePreset }] : items(raw.presets)).slice(0, 32)) {
    const src = object(entry);
    const preset = defaults();
    preset.name = name(src.name) || preset.name;
    if (presets.some((p) => p.name === preset.name)) continue;
    preset.showInputs = src.showInputs !== false;
    preset.showMasterSection = (src.showMasterSection ?? object(src.globalModules).showMasterSection) !== false;
    const modules = object(src.modules);
    preset.modules = { intellipan: modules.intellipan !== false, audibility: modules.audibility !== false, fxSends: modules.fxSends !== false, solo: modules.solo !== false, mono: modules.mono !== false, recorder: modules.recorder !== false, reverb: modules.reverb !== false, delay: modules.delay !== false, sing: modules.sing !== false };
    const channels: (readonly [number, Record<string, unknown>] | null)[] = legacy
      ? [raw.strips, raw.buses].flatMap((group, g) => items(group).slice(0, 8).map((row) => {
          const config = object(row);
          const index = config.index;
          const buttons = object(config.modules).routingButtons;
          return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 8
            ? [index + g * 8, { ...config, routeMask: Array.isArray(buttons)
              ? routes.reduce((mask, route, i) => mask | (buttons.includes(route) ? 1 << i : 0), 0) : 255 }] as const
            : null;
        }))
      : items(src.channels).slice(0, 16).map((row, id) => [id, object(row)] as const);
    for (const row of channels) {
      if (!row) continue;
      const [id, channel] = row;
      const { visibility, routeMask } = channel;
      const modules = object(channel.modules);
      const flag = (value: unknown) => value !== false;
      preset.channels[id] = {
        visibility: visibility === 'collapsed' || visibility === 'hidden' ? 'hidden' : 'visible',
        customName: name(channel.customName),
        routeMask: typeof routeMask === 'number' && Number.isInteger(routeMask) && routeMask >= 0 && routeMask <= 255 ? routeMask : 255,
        modules: {
          intellipan: flag(modules.intellipan),
          audibility: flag(modules.audibility),
          eqFx: flag(modules.eqFx ?? modules.eqAndFx),
        },
      };
    }
    presets.push(preset);
  }
  if (!presets.length) presets.push(defaults());
  return {
    activePreset: presets.find((p) => p.name === raw.activePreset)?.name ?? presets[0].name,
    window: { width: size(window.width, 980, 340), height: size(window.height, 620, 360), alwaysOnTop: window.alwaysOnTop === true },
    hideInactive: raw.hideInactive === true,
    theme: typeof raw.theme === 'string' && themes.some((t) => t.id === raw.theme) ? raw.theme : 'midnight',
    sing: {
      mic: mask(sing.mic, 31, 1),
      music: mask(sing.music, 255, 64),
      duck: typeof sing.duck === 'number' && Number.isFinite(sing.duck) ? Math.min(30, Math.max(0, sing.duck)) : 10,
    },
    presets,
  };
}
