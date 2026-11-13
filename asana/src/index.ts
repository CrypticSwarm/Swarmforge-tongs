import type { Server } from "node:http";
import { createApp } from "./app.js";
import { Asana, openWorkspace } from "./asana.js";
import { configFromEnv, type Config } from "./config.js";

const port = Number(process.env.PORT ?? 8080);

const env = { ASANA_TOKEN: process.env.ASANA_TOKEN, ASANA_WORKSPACE_ID: process.env.ASANA_WORKSPACE_ID };

delete process.env.ASANA_TOKEN;

function die(message: string): never {
  console.error(`asana: ${message}`);
  process.exit(1);
}

let config: Config;
try {
  config = configFromEnv(env);
} catch (err) {
  die((err as Error).message);
}

let httpServer: Server | undefined;
function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  if (!httpServer) process.exit(0);
  httpServer.close(() => process.exit(0));
}
// Before the startup check, which can wait on Asana for minutes; node as PID 1 ignores an unhandled SIGTERM.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const asana = new Asana(config.token);

const { user, workspace } = await openWorkspace(asana, config.workspaceGid).catch((err: Error) =>
  // Network errors too: a tong that looks healthy and fails every verb is worse than none.
  die(err.message),
);
console.log(`asana: acting as ${user.name} (gid ${user.gid}) in workspace ${workspace.name} (gid ${workspace.gid})`);

httpServer = createApp({ asana, workspace }).listen(port, (err?: Error) => {
  if (err) die(`cannot listen on :${port}: ${err.message}`);
  console.log(`asana listening on :${port}`);
});
