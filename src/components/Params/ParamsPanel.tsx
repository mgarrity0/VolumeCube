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

const COLOR_ORDERS: ColorOrder[] = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'];

// Module-level constant so unloaded-pattern renders don't allocate a new
// object each call (a fresh {} would confuse useSyncExternalStore).
const EMPTY_PARAMS: Record<string, any> = {};

function labelFor(key: string, spec: ParamSpec): string {
  if (spec.label) return spec.label;
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase());
}

type StackedProps = {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  integer?: boolean;
};

function StackedSliderNumber({ label, min, max, step, value, onChange, integer }: StackedProps) {
  const coerce = (v: number) => (integer ? Math.round(v) : v);
  return (
    <div className="field-stacked">
      <span>{label}</span>
      <div className="field-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(coerce(Number(e.target.value)))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(coerce(Number(e.target.value)))}
        />
      </div>
    </div>
  );
}

export function ParamsPanel() {
  const active = useAppStore((s) => s.pattern.active);
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
      <StackedSliderNumber
        label="Brightness"
        min={0}
        max={1}
        step={0.01}
        value={color.brightness}
        onChange={(v) => patchColor({ brightness: v })}
      />
      <StackedSliderNumber
        label="Gamma"
        min={1}
        max={3.2}
        step={0.01}
        value={color.gamma}
        onChange={(v) => patchColor({ gamma: v })}
      />
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
        <>
          <PresetRow patternName={active.name} />
          {entries.map(([key, spec]) => (
            <ParamControl
              key={key}
              label={labelFor(key, spec)}
              spec={spec}
              value={values[key] ?? (spec as any).default}
              onChange={(v) => patchParamValue(active.name, key, v)}
            />
          ))}
        </>
      )}
    </section>
  );
}

// Presets dropdown + Save/Delete buttons for the active pattern. Session-
// only storage — we trade persistence for the simplicity of no Tauri-fs
// round trip and no schema-migration worry when a pattern's params change.
function PresetRow({ patternName }: { patternName: string }) {
  const forPattern = useAppStore((s) => s.presets[patternName]);
  const savePreset = useAppStore((s) => s.savePreset);
  const deletePreset = useAppStore((s) => s.deletePreset);
  const applyPreset = useAppStore((s) => s.applyPreset);

  const names = forPattern ? Object.keys(forPattern).sort() : [];

  const onSave = () => {
    const name = window.prompt('Preset name:');
    if (!name) return;
    savePreset(patternName, name.trim());
  };

  const onSelect = (name: string) => {
    if (!name) return;
    applyPreset(patternName, name);
  };

  const onDelete = () => {
    if (names.length === 0) return;
    const name = window.prompt(
      `Delete which preset?\n\n${names.join('\n')}`,
      names[0],
    );
    if (!name) return;
    deletePreset(patternName, name.trim());
  };

  return (
    <div className="preset-row">
      <select
        value=""
        onChange={(e) => onSelect(e.target.value)}
        disabled={names.length === 0}
        title={names.length === 0 ? 'No presets saved' : 'Apply preset'}
      >
        <option value="">
          {names.length === 0 ? '(no presets)' : 'Apply preset…'}
        </option>
        {names.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <button onClick={onSave} title="Save current params as a named preset">
        Save
      </button>
      <button onClick={onDelete} disabled={names.length === 0} title="Delete a saved preset">
        Delete
      </button>
    </div>
  );
}

type ControlProps = {
  label: string;
  spec: ParamSpec;
  value: any;
  onChange: (v: any) => void;
};

function ParamControl({ label, spec, value, onChange }: ControlProps) {
  switch (spec.type) {
    case 'range':
    case 'int':
      return (
        <StackedSliderNumber
          label={label}
          min={spec.min}
          max={spec.max}
          step={spec.step ?? (spec.type === 'int' ? 1 : 0.01)}
          value={Number(value)}
          onChange={onChange}
          integer={spec.type === 'int'}
        />
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
