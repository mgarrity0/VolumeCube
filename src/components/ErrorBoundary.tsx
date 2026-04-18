import { Component, ErrorInfo, ReactNode } from 'react';

// React error boundary. Catches errors thrown during render/commit of its
// children and shows a fallback, instead of propagating up and unmounting
// the whole app. Pattern code that throws inside useFrame is already
// caught in Cube.tsx (async, not React render), so this boundary mostly
// exists as a safety net for bad geometry/material state or for bugs in
// our own R3F components.
//
// Note: error boundaries do NOT catch async errors, event handlers, or
// errors thrown on the server — only render-phase errors from children.

type Props = {
  children: ReactNode;
  fallback?: (err: Error, reset: () => void) => ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-title">Something broke.</div>
          <pre className="error-boundary-msg">{this.state.error.message}</pre>
          <button onClick={this.reset}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
