#!/usr/bin/env node
import { createHubServer, DEFAULT_PORT } from "./hub.ts";

function parsePort(argv: string[]): number {
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) {
    const value = Number(argv[idx + 1]);
    if (Number.isInteger(value) && value > 0 && value < 65536) {
      return value;
    }
    throw new Error(`invalid --port value: ${argv[idx + 1]}`);
  }
  return DEFAULT_PORT;
}

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2));
  const server = createHubServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  console.log(`browserlink hub listening on 127.0.0.1:${port}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
