export type ScrapingLayer =
  | "navigator"
  | "extractor"
  | "schema"
  | "transformer"
  | "sink";

export class ScrapingError extends Error {
  constructor(
    message: string,
    public readonly layer: ScrapingLayer,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ScrapingError";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
