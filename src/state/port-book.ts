const LOWEST_PORT = 1;
const HIGHEST_PORT = 65_535;

export class PortBook {
  private readonly ports: Readonly<Record<string, number>>;

  constructor(props: { ports: Readonly<Record<string, number>> }) {
    this.ports = props.ports;
  }

  static empty(): PortBook {
    return new PortBook({ ports: {} });
  }

  static from(value: unknown): PortBook {
    return new PortBook({ ports: readPorts(fieldOf(value, "ports")) });
  }

  portFor(path: string): number | null {
    return this.ports[path] ?? null;
  }

  assign(path: string, port: number): PortBook {
    return new PortBook({ ports: { ...this.ports, [path]: port } });
  }

  toJSON(): Readonly<Record<string, number>> {
    return this.ports;
  }
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  return (value as Record<string, unknown>)[key];
}

function readPorts(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const ports: Record<string, number> = {};
  for (const [path, port] of Object.entries(value)) {
    if (isPort(port)) ports[path] = port;
  }

  return ports;
}

function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= LOWEST_PORT &&
    value <= HIGHEST_PORT
  );
}
