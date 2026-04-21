import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

interface RootErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends React.Component<React.PropsWithChildren, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Root app render failed', error, errorInfo);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen bg-stone-100 px-6 py-10 text-stone-900">
        <div className="mx-auto max-w-[68ch] rounded-[24px] border border-red-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-700">
            App Error
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900">
            The planner hit a runtime error while loading.
          </h1>
          <p className="mt-3 text-sm leading-6 text-stone-700">
            Refresh the page first. If the error persists, this panel should make the failure visible
            instead of leaving a blank screen.
          </p>
          <pre className="mt-4 overflow-auto rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-100">
            <code>{this.state.error.stack ?? this.state.error.message}</code>
          </pre>
        </div>
      </div>
    );
  }
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

const root = ReactDOM.createRoot(rootElement);

function renderBootError(error: unknown) {
  const resolved =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown startup error');

  console.error('App bootstrap failed', resolved);

  root.render(
    <div className="min-h-screen bg-stone-100 px-6 py-10 text-stone-900">
      <div className="mx-auto max-w-[68ch] rounded-[24px] border border-red-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-700">
          Startup Error
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900">
          The planner failed before the app could finish loading.
        </h1>
        <p className="mt-3 text-sm leading-6 text-stone-700">
          This usually means a module-load error or an unhandled startup exception. The message below
          should help us fix the exact failure instead of leaving a blank page.
        </p>
        <pre className="mt-4 overflow-auto rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-100">
          <code>{resolved.stack ?? resolved.message}</code>
        </pre>
      </div>
    </div>,
  );
}

window.addEventListener('error', (event) => {
  renderBootError(event.error ?? new Error(event.message));
});

window.addEventListener('unhandledrejection', (event) => {
  renderBootError(event.reason);
});

async function bootstrap() {
  try {
    const { App } = await import('./App');
    root.render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </React.StrictMode>,
    );
  } catch (error) {
    renderBootError(error);
  }
}

void bootstrap();
