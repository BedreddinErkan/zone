export class Foo extends React.Component {
  constructor(props: { label: string }) {
    super(props);
  }

  async loadData() {
    return Promise.resolve(this.props.label);
  }

  get value() {
    return this.props.label;
  }

  set value(next: string) {
    this.props.label = next;
  }

  #secret() {
    return "secret";
  }

  static create() {
    return new Foo({ label: "x" });
  }

  render() {
    return <div>{this.props.label}</div>;
  }
}
