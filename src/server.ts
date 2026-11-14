import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const context = createApp(config);
const server = createServer(context.app);

server.listen(config.port, () => {
  console.info(JSON.stringify({ level: "info", port: config.port, message: "Meting Node service listening" }));
});

function shutdown(signal: string): void {
  context.stop();
  server.close(() => {
    console.info(JSON.stringify({ level: "info", signal, message: "Meting Node service stopped" }));
    process.exit(0);
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
