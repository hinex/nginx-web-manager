import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";
import type { Refusal } from "~/lib/nginx/reverse/classify";

export class ForbiddenError extends Error {
  missingScope: Scope;
  constructor(missingScope: Scope) {
    super(`token lacks scope ${missingScope}`);
    this.name = "ForbiddenError";
    this.missingScope = missingScope;
  }
}

export class InvalidPathError extends Error {
  constructor(filePath: string) {
    super(`Invalid path (outside nginx directory or wrong extension): ${filePath}`);
    this.name = "InvalidPathError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class HostValidationError extends Error {
  kind: "input" | "nginx";
  constructor(message: string, kind: "input" | "nginx" = "input") {
    super(message);
    this.name = "HostValidationError";
    this.kind = kind;
  }
}

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export class ConfigClassificationError extends Error {
  constructor(public refusals: Refusal[]) {
    super("Config changes could not be mapped to the host model");
    this.name = "ConfigClassificationError";
  }
}

export function requireScope(auth: AuthContext, scope: Scope): void {
  if (!auth.scopes.includes(scope)) {
    throw new ForbiddenError(scope);
  }
}
