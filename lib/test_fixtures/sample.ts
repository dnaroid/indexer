export interface Runner {
  run(): void
}

export type UserId = string | number

export enum Status {
  Idle = "idle",
  Active = "active"
}

export namespace Core {
  export const Version = "1.0"

  export namespace Sub {
    export const Name = "sub"
  }
}

export const DEFAULT_TIMEOUT = 30

export function build(input: string): string {
  return input
}

export default function createDefault(): string {
  return "default"
}

export class Service {
  id = 1
  #secret = 2

  get status(): string {
    return "ok"
  }

  set status(value: string) {
    void value
  }

  run(): string {
    return "ok"
  }
}
