import { useAppStore } from '../../state/store';
import type { ParamSpec } from '../../core/patternApi';
import type { ColorOrder } from '../../core/colorPipeline';

// ParamsPanel renders the currently-active pattern's schema as controls.
// Panel kinds (driven by patternApi.ParamSpec):
//   range  → slider + number input (linked)
//   int    → slider + integer number input
//   color  → hex color picker
//   toggle → checkbox
//   select → dropdown
//
// Values live under pattern.paramValues[patternName][key] in Zustand; we
// write through patchParamValue so edits survive hot-reload.
//
// A "Color" subsection at the top of this panel tweaks the global color
// pipeline (gamma, brightness, color order). It's always visible so you
// can adjust output calibration without a pattern loaded.

const COLOR_ORDERS: ColorOrder[] = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'];

// Module-level constant so unloaded-pattern renders don't allocate a new
// object each time (would break selector reference-stability if used
// inside a selector; used as a post-selector fallback here).
const EMPTY_PARAMS: Record<string, any> = {};

function labelFor(key: string, spec: ParamSpec): string {
  if (spec.label) return spec.label;
  // Convert camelCase → Sentence case for a friendlier display.
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase());
}

export function ParamsPanel() {
  const active = useAppStore((s) => s.pattern.active);
  // IMPORTANT: selector must return a reference-stable value. Returning a
  // fresh `{}` each call makes React's useSyncExternalStore think the
  // snapshot changed every render and either warn or bail out. We return
  // the stored values or undefined and fall back in the render body.
  const storedValues = useAppStore((s) =>
    active ? s.pattern.paramValues[active.name] : undefined,
  );
  const values = storedValues ?? EMPTY_PARAMS;
  const patchParamValue = useAppStore((s) => s.patchParamValue);

  const color = useAppStore((s) => s.color);
  const patchColor = useAppStore((s) => s.patchColor);

  const entries: [string, ParamSpec][] = active
    ? Object.entries(active.params)
    : [];

  return (
    <section className="panel-section">
      <h2>Color</h2>
      <div className="field-stacked">
        <span>Brightness</span>
        <div className="field-row">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={color.brightness}
            onChange={(e) => patchColor({ brightness: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={color.brightness}
            onChange={(e) => patchColor({ brightness: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="field-stacked">
        <span>Gamma</span>
        <div className="field-row">
          <input
            type="range"
            min={1}
            max={3.2}
            step={0.01}
            value={color.gamma}
            onChange={(e) => patchColor({ gamma: Number(e.target.value) })}
          />
          <input
            type="number"
            min={1}
            max={3.2}
            step={0.01}
            value={color.gamma}
            onChange={(e) => patchColor({ gamma: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="field">
        <span>Color order</span>
        <select
          value={color.colorOrder}
          onChange={(e) => patchColor({ colorOrder: e.target.value as ColorOrder })}
        >
          {COLOR_ORDERS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>

      <h3>Pattern params</h3>
      {!active ? (
        <p className="library-empty">No pattern loaded.</p>
      ) : entries.length === 0 ? (
        <p className="library-empty">
          <strong>{active.displayName}</strong> exposes no params.
        </p>
      ) : (
        entries.map(([key, spec]) => (
          <ParamControl
            key={key}
            name={key}
            label={labelFor(key, spec)}
            spec={spec}
            value={values[key] ?? (spec as any).default}
            onChange={(v) => patchParamValue(active.name, key, v)}
          />
        ))
      )}
    </section>
  );
}

type ControlProps = {
  name: string;
  label: string;
  spec: ParamSpec;
  value: any;
  onChange: (v: any) => void;
};

function ParamControl({ label, spec, value, onChange }: ControlProps) {
  switch (spec.type) {
    case 'range':
      return (
        <div className="field-stacked">
          <span>{label}</span>
          <div className="field-row">
            <input
              type="range"
              min={spec.min}
              max={spec.max}
              step={spec.step ?? 0.01}
              value={Number(value)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <input
              type="number"
              min={spec.min}
              max={spec.max}
              step={spec.step ?? 0.01}
              value={Number(value)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
          </div>
        </div>
      );

    case 'int':
      return (
        <div className="field-stacked">
          <span>{label}</span>
          <div className="field-row">
            <input
              type="range"
              min={spec.min}
              max={spec.max}
              step={spec.step ?? 1}
              value={Number(value)}
              onChange={(e) => onChange(Math.round(Number(e.target.value)))}
            />
            <input
              type="number"
              min={spec.min}
              max={spec.max}
              step={spec.step ?? 1}
              value={Number(value)}
              onChange={(e) => onChange(Math.round(Number(e.target.value)))}
            />
          </div>
        </div>
      );

    case 'color':
      return (
        <div className="field">
          <span>{label}</span>
          <input
            type="color"
            value={typeof value === 'string' ? value : spec.default}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    case 'toggle':
      return (
        <div className="field">
          <span>{label}</span>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
        </div>
      );

    case 'select':
      return (
        <div className="field">
          <span>{label}</span>
          <select
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          >
            {spec.options.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
      );
  }
}
