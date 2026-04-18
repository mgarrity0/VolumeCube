// Pattern module contract — what a .js file in patterns/ exports.
//
// Two API tiers, both plain ES modules:
//
//   A. Function API  — easiest for Claude to generate, pure per-voxel:
//        export const params = { ... };
//        export default {
//          name: 'Plasma',
//          render(ctx, xyz) { return [r, g, b] }    // 0..255
//        };
//
//   B. Class API     — for stateful effects (particles, trails):
//        export const params = { ... };
//        export default class Rain {
//          static name = 'Rain';
//          setup(ctx) { this.drops = [] }
//          update(ctx) { /* mutate state */ }
//          render(ctx, out) { /* write out[i*3+0..2] for i in 0..N³ */ }
//        };
//
// The runtime distinguishes them: if the instance has an `update` method,
// it's the class API and the engine calls update() then render(ctx, out).
// Otherwise it's the function API and the engine iterates voxels.

export type ParamSpec =
  | { type: 'range'; min: number; max: number; step?: number; default: number; label?: string }
  | { type: 'int';   min: number; max: number; step?: number; default: number; label?: string }
  | { type: 'color'; default: string; label?: string }
  | { type: 'toggle'; default: boolean; label?: string }
  | { type: 'select'; options: string[]; default: string; label?: string };

export type ParamSchema = Record<string, ParamSpec>;

export type AudioState = {
  energy: number;
  low: number;
  mid: number;
  high: number;
  beat: boolean;
};

export type PowerState = {
  amps: number;
  watts: number;
  budgetAmps: number;
  scale: number;
};

export type PatternUtils = {
  clamp: (v: number, lo: number, hi: number) => number;
  smoothstep: (a: number, b: number, v: number) => number;
  mix: (a: string | number[], b: string | number[], t: number) => [number, number, number];
  hsv: (h: number, s: number, v: number) => [number, number, number];
  noise3d: (x: number, y: number, z: number) => number;
};

export type RenderContext = {
  t: number;          // seconds since pattern start
  dt: number;         // seconds since last frame
  frame: number;      // frames since start (0 on activation)
  N: number;          // cube edge
  params: Record<string, any>;
  audio: AudioState;
  power: PowerState;
  utils: PatternUtils;
};

export type SetupContext = Pick<RenderContext, 'N' | 'params'>;

export type VoxelCoord = {
  x: number; y: number; z: number;
  u: number; v: number; w: number;     // [0,1]
  cx: number; cy: number; cz: number;  // [-1,1]
  i: number;                           // logical index
};

export type RGB = [number, number, number];

// ---- Module shape ----

// Function-API default export is an object with `render(ctx, xyz) => [r,g,b]`.
export type FunctionPatternModule = {
  params?: ParamSchema;
  default: {
    name?: string;
    setup?: (ctx: SetupContext) => void;
    render: (ctx: RenderContext, xyz: VoxelCoord) => RGB | Float32Array | Uint8Array | number[];
  };
};

// Class-API default export is a constructor producing an instance with
// `update(ctx)` + `render(ctx, out)` (no per-voxel callback).
export type ClassPatternInstance = {
  setup?: (ctx: SetupContext) => void;
  update?: (ctx: RenderContext) => void;
  render: (ctx: RenderContext, out: Uint8ClampedArray) => void;
};

export type ClassPatternModule = {
  params?: ParamSchema;
  default: (new () => ClassPatternInstance) & { name?: string };
};

export type PatternModule = FunctionPatternModule | ClassPatternModule;

export type LoadedPattern = {
  name: string;               // source filename (e.g. 'classics/plasma.js')
  displayName: string;        // pattern-reported name or prettified filename
  params: ParamSchema;        // empty object if none
  kind: 'function' | 'class';
  // Concrete render entry points (engine-side wiring):
  setup?: (ctx: SetupContext) => void;
  // function-API:
  renderVoxel?: (ctx: RenderContext, xyz: VoxelCoord) => RGB;
  // class-API:
  instance?: ClassPatternInstance;
};

export function isPatternModule(mod: any): mod is PatternModule {
  if (!mod || typeof mod !== 'object') return false;
  const def = mod.default;
  if (!def) return false;
  // Function-API: default is an object with .render
  if (typeof def === 'object' && typeof def.render === 'function') return true;
  // Class-API: default is a constructor (function). We can't fully verify
  // without instantiating, but require it to have a prototype.render method.
  if (typeof def === 'function') {
    const proto = def.prototype;
    return !!proto && typeof proto.render === 'function';
  }
  return false;
}

/**
 * Turn a validated raw module into a LoadedPattern with engine-ready hooks.
 * For class-API modules, instantiates once and wires setup/update/render.
 * Throws if `mod` doesn't pass isPatternModule (caller validates first).
 */
export function adaptModule(name: string, mod: PatternModule): LoadedPattern {
  const params = (mod.params ?? {}) as ParamSchema;
  const def = (mod as any).default;
  const displayBase =
    (typeof def === 'object' && def?.name) ||
    (typeof def === 'function' && def?.name) ||
    prettyName(name);

  if (typeof def === 'function') {
    const inst = new (def as new () => ClassPatternInstance)();
    return {
      name,
      displayName: displayBase,
      params,
      kind: 'class',
      setup: inst.setup ? (ctx) => inst.setup!(ctx) : undefined,
      instance: inst,
    };
  }

  // Function API
  return {
    name,
    displayName: displayBase,
    params,
    kind: 'function',
    setup: def.setup ? (ctx: SetupContext) => def.setup(ctx) : undefined,
    renderVoxel: (ctx, xyz) => {
      const r = def.render(ctx, xyz);
      // Coerce to a concrete RGB triple; patterns may return an array of
      // length 3 or a typed array. We trust the pattern to stay in 0..255.
      return [r[0] as number, r[1] as number, r[2] as number];
    },
  };
}

function prettyName(name: string): string {
  const base = name.split('/').pop() ?? name;
  return base.replace(/\.(mjs|js)$/i, '');
}

// Merge previously-saved param values against a (possibly new) schema.
// Keeps values whose key + type still line up; resets the rest to defaults.
// Called on hot-reload so tweaking a pattern doesn't blow away unrelated sliders.
export function mergeParamValues(
  schema: ParamSchema,
  prior: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(schema)) {
    const spec = schema[key];
    const priorVal = prior?.[key];
    if (priorVal !== undefined && isValueOfType(priorVal, spec)) {
      out[key] = priorVal;
    } else {
      out[key] = (spec as any).default;
    }
  }
  return out;
}

function isValueOfType(v: any, spec: ParamSpec): boolean {
  switch (spec.type) {
    case 'range':
    case 'int':
      return typeof v === 'number' && Number.isFinite(v);
    case 'color':
      return typeof v === 'string';
    case 'toggle':
      return typeof v === 'boolean';
    case 'select':
      return typeof v === 'string' && spec.options.includes(v);
  }
}
