import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);

const httpServer = createApp().listen(port, () => {
  console.log(`github listening on :${port}`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  httpServer.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
