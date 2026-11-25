import { Component, type ErrorInfo, type ReactNode } from "react";
import { KageLogo } from "./Icons";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[kage] UI boundary caught error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || "Unexpected rendering failure";
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0A0908] p-6 text-[#F3ECE4]">
        <div className="bezel-outer max-w-md w-full">
          <div className="bezel-inner p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <KageLogo className="w-8 h-8 shrink-0" />
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-[#FF6B6F] font-semibold">
                  Render Recovery
                </div>
                <h1 className="font-display text-2xl leading-tight text-[#F3ECE4]">
                  KAGE Interface Interrupted
                </h1>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-[#B5AA9F]">
              Your capture engine and saved MP4 files remain untouched. Reload the deck to recover cleanly.
            </p>
            <pre className="max-h-32 overflow-auto rounded-[8px] border border-[#282320] bg-[#0A0908] p-3 text-[11px] font-mono text-[#F5B971] whitespace-pre-wrap break-words">
              {message}
            </pre>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] transition-colors"
              >
                Reload Deck
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
