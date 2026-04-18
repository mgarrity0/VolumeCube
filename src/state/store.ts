import { create } from 'zustand';
import { CubeSpec, DEFAULT_CUBE } from '../core/cubeGeometry';
import type { LoadedPattern } from '../core/patternApi';
import { ColorConfig, defaultColorConfig } from '../core/colorPipeline';
import { PowerConfig, defaultPowerConfig } from '../core/power';
import { WiringConfig, defaultWiringConfig } from '../core/wiring';
import {
  OutputConfig,
  OutputStats,
  defaultOutputConfig,
  defaultOutputStats,
} from '../core/transports';

// Phase 0–3 state. Panels, structure, patterns, power, audio, and output
// state each grow as phases land.

export type StructureMode = 'clean' | 'ghost' | 'full';
export type CameraPreset = 'orbit' | 'front' | 'side' | 'top' | 'iso';

export type PatternState = {
  available: string[];                  // filenames (e.g. 'classics/plasma.js')
  active: LoadedPattern | null;
  error: string | null;
  loadToken: number;
  paramValues: Record<string, Record<string, any>>;
};

export type PowerLive = {
  amps: number;
  watts: number;
  scale: number;
  overBudget: boolean;
};

export type AudioUIState = {
  requested: boolean;
  error: string | null;
};

export type AppState = {
  // Structure
  cube: CubeSpec;
  setCube: (c: CubeSpec) => void;
  patchCube: (patch: Partial<CubeSpec>) => void;

  // Viewer
  cameraPreset: CameraPreset;
  structureMode: StructureMode;
  showWiringPath: boolean;
  setCameraPreset: (p: CameraPreset) => void;
  setStructureMode: (m: StructureMode) => void;
  setShowWiringPath: (v: boolean) => void;

  // Pattern
  pattern: PatternState;
  setAvailablePatterns: (names: string[]) => void;
  setActivePattern: (p: LoadedPattern | null) => void;
  setPatternError: (err: string | null) => void;
  setParamValues: (name: string, values: Record<string, any>) => void;
  patchParamValue: (name: string, key: string, value: any) => void;

  // Color pipeline
  color: ColorConfig;
  patchColor: (patch: Partial<ColorConfig>) => void;

  // Power
  power: PowerConfig;
  powerLive: PowerLive;
  patchPower: (patch: Partial<PowerConfig>) => void;
  setPowerLive: (live: PowerLive) => void;

  // Audio UI (engine itself is a module singleton)
  audio: AudioUIState;
  setAudioRequested: (v: boolean) => void;
  setAudioError: (e: string | null) => void;

  // Wiring / address map
  wiring: WiringConfig;
  patchWiring: (patch: Partial<WiringConfig>) => void;

  // Output / transports
  output: OutputConfig;
  outputStats: OutputStats;
  patchOutput: (patch: Partial<OutputConfig>) => void;
  setOutputStats: (s: OutputStats) => void;
};

export const useAppStore = create<AppState>((set) => ({
  cube: DEFAULT_CUBE,
  setCube: (c) => set({ cube: c }),
  patchCube: (patch) => set((s) => ({ cube: { ...s.cube, ...patch } })),

  cameraPreset: 'orbit',
  structureMode: 'ghost',
  showWiringPath: false,
  setCameraPreset: (p) => set({ cameraPreset: p }),
  setStructureMode: (m) => set({ structureMode: m }),
  setShowWiringPath: (v) => set({ showWiringPath: v }),

  pattern: {
    available: [],
    active: null,
    error: null,
    loadToken: 0,
    paramValues: {},
  },
  setAvailablePatterns: (names) =>
    set((s) => ({ pattern: { ...s.pattern, available: names } })),
  setActivePattern: (p) =>
    set((s) => ({
      pattern: {
        ...s.pattern,
        active: p,
        error: null,
        loadToken: s.pattern.loadToken + 1,
      },
    })),
  setPatternError: (err) =>
    set((s) => ({ pattern: { ...s.pattern, error: err } })),
  setParamValues: (name, values) =>
    set((s) => ({
      pattern: {
        ...s.pattern,
        paramValues: { ...s.pattern.paramValues, [name]: values },
      },
    })),
  patchParamValue: (name, key, value) =>
    set((s) => ({
      pattern: {
        ...s.pattern,
        paramValues: {
          ...s.pattern.paramValues,
          [name]: { ...(s.pattern.paramValues[name] ?? {}), [key]: value },
        },
      },
    })),

  color: defaultColorConfig,
  patchColor: (patch) => set((s) => ({ color: { ...s.color, ...patch } })),

  power: defaultPowerConfig,
  powerLive: { amps: 0, watts: 0, scale: 1, overBudget: false },
  patchPower: (patch) => set((s) => ({ power: { ...s.power, ...patch } })),
  setPowerLive: (live) => set({ powerLive: live }),

  audio: { requested: false, error: null },
  setAudioRequested: (v) => set((s) => ({ audio: { ...s.audio, requested: v } })),
  setAudioError: (e) => set((s) => ({ audio: { ...s.audio, error: e } })),

  wiring: defaultWiringConfig,
  patchWiring: (patch) => set((s) => ({ wiring: { ...s.wiring, ...patch } })),

  output: defaultOutputConfig,
  outputStats: defaultOutputStats,
  patchOutput: (patch) => set((s) => ({ output: { ...s.output, ...patch } })),
  setOutputStats: (stats) => set({ outputStats: stats }),
}));

// Non-reactive selectors for the hot render path.
export const getCube = () => useAppStore.getState().cube;
export const getActivePattern = () => useAppStore.getState().pattern.active;
export const getActiveParamValues = () => {
  const { active, paramValues } = useAppStore.getState().pattern;
  if (!active) return {};
  return paramValues[active.name] ?? {};
};
export const getColorConfig = () => useAppStore.getState().color;
export const getPowerConfig = () => useAppStore.getState().power;
export const getPowerLive = () => useAppStore.getState().powerLive;
