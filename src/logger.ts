import pino from "pino";

export function createLogger(level: string = "info") {
  const isDev = process.env["NODE_ENV"] !== "production";
  return pino({
    level,
    transport: isDev
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  });
}

export const logger = createLogger(process.env["LOG_LEVEL"] ?? "info");

export type Logger = ReturnType<typeof createLogger>;
