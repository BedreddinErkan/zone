import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  onCrash: (error: Error) => void;
}

interface State {
  crashed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.setState({ crashed: true });
    this.props.onCrash(error);
  }

  render(): ReactNode {
    if (this.state.crashed) return null;
    return this.props.children;
  }
}
