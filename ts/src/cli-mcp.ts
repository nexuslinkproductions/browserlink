#!/usr/bin/env node
import { runMcpServer } from "./mcp.js";

runMcpServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
