import { Component, type ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  readonly onUnavailable: () => void;
}

/** Keep keyboard-accessible stations available when this device has no WebGL context. */
export class RenderBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { this.props.onUnavailable(); }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
