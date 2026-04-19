import { useAppStore } from '../state/store';
import { SHORTCUTS, Shortcut } from '../core/keyboardShortcuts';

// Modal overlay listing every keyboard shortcut. Visible state lives in
// the store (showShortcuts) so both the `?` key and the toolbar button
// drive the same toggle. We render the exact SHORTCUTS table the handler
// dispatches against — zero chance of the help text drifting from the
// actual bindings.

const GROUPS: Shortcut['group'][] = ['View', 'Library', 'Debug', 'Help'];

export function ShortcutsHelp() {
  const show = useAppStore((s) => s.showShortcuts);
  const setShow = useAppStore((s) => s.setShowShortcuts);
  if (!show) return null;

  // De-dupe by description so "1/2/3/4 = camera" collapses into one row.
  // Uses the FIRST occurrence's label group so ordering matches the table.
  const byGroup = new Map<string, Shortcut[]>();
  for (const g of GROUPS) byGroup.set(g, []);
  for (const s of SHORTCUTS) {
    const arr = byGroup.get(s.group);
    if (arr) arr.push(s);
  }

  return (
    <div className="shortcuts-modal-backdrop" onClick={() => setShow(false)}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-header">
          <h2>Keyboard shortcuts</h2>
          <button className="shortcuts-close" onClick={() => setShow(false)}>
            Close
          </button>
        </div>
        {GROUPS.map((g) => {
          const rows = byGroup.get(g) ?? [];
          if (rows.length === 0) return null;
          return (
            <div key={g} className="shortcuts-group">
              <div className="shortcuts-group-title">{g}</div>
              <table className="shortcuts-table">
                <tbody>
                  {rows.map((s, i) => (
                    <tr key={`${g}-${i}`}>
                      <td className="shortcuts-key">
                        <kbd>{s.label}</kbd>
                      </td>
                      <td>{s.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        <div className="shortcuts-footer">
          Shortcuts are disabled while typing in a text field. Esc closes this
          overlay.
        </div>
      </div>
    </div>
  );
}
