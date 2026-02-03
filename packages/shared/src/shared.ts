export function assertDarwin() {
  if (process.platform !== "darwin") {
    throw new Error("Pi VS Code terminal notifications are only supported on MacOS");
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

export function sanitizeOscValue(value: string): string {
  return value.split("\u001B").join("").split("\u0007").join("");
}
