// The package's types aren't reachable through its "exports" map.
declare module '@serialport/binding-mock' {
  export const MockBinding: {
    createPort(path: string, opts?: { echo?: boolean; record?: boolean }): void;
    reset(): void;
  } & Record<string, unknown>;
}
