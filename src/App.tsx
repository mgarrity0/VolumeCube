import { Viewer } from './components/Viewer/Viewer';
import { LibraryPanel } from './components/Library/LibraryPanel';
import { StructurePanel } from './components/Structure/StructurePanel';
import { ParamsPanel } from './components/Params/ParamsPanel';
import { PowerPanel } from './components/Power/PowerPanel';
import { AudioPanel } from './components/Audio/AudioPanel';
import { OutputPanel } from './components/Output/OutputPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { usePatternHost } from './core/usePatternHost';
import './App.css';

export default function App() {
  usePatternHost();

  return (
    <main className="app-root">
      <header className="app-header">
        <h1>VolumeCube</h1>
        <span className="app-subtitle">Volumetric LED cube simulator &amp; pattern authoring</span>
        <span className="app-phase">Phase 5 — overlay &amp; polish</span>
      </header>
      <section className="app-body">
        <ErrorBoundary>
          <LibraryPanel />
        </ErrorBoundary>
        <Viewer />
        <aside className="panel right-panel">
          <ErrorBoundary><StructurePanel /></ErrorBoundary>
          <ErrorBoundary><ParamsPanel /></ErrorBoundary>
          <ErrorBoundary><PowerPanel /></ErrorBoundary>
          <ErrorBoundary><AudioPanel /></ErrorBoundary>
          <ErrorBoundary><OutputPanel /></ErrorBoundary>
        </aside>
      </section>
    </main>
  );
}
