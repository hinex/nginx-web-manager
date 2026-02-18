import { renderToReadableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import type { EntryContext } from "react-router";
import { startWatchdog } from "~/lib/watchdog/worker";
import { startTerminalServer } from "~/lib/terminal/server";
import { generateAllConfigs } from "~/lib/nginx/generator";
import { reloadNginx } from "~/lib/nginx/reload";

// Generate nginx configs and reload on server boot (only once)
let configsGenerated = false;
if (!configsGenerated) {
  configsGenerated = true;
  try {
    generateAllConfigs();
    reloadNginx();
    console.log("[init] Nginx configs generated and reloaded");
  } catch (e) {
    console.error("[init] Failed to generate nginx configs:", e);
  }
}

// Start watchdog on server boot (only once)
let watchdogStarted = false;
if (!watchdogStarted) {
  watchdogStarted = true;
  startWatchdog();
}

// Start terminal WebSocket server (only once)
let terminalStarted = false;
if (!terminalStarted) {
  terminalStarted = true;
  const terminalPort = Number(process.env.TERMINAL_WS_PORT) || 3001;
  startTerminalServer(terminalPort);
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        console.error(error);
        responseStatusCode = 500;
      },
    }
  );

  await stream.allReady;

  responseHeaders.set("Content-Type", "text/html");

  return new Response(stream, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
