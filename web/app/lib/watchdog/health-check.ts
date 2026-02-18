export async function checkUpstream(
  server: string,
  port: number,
  timeoutMs = 3000
): Promise<{
  status: "up" | "down";
  responseMs: number;
  error?: string;
}> {
  const start = performance.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        status: "down",
        responseMs: Math.round(performance.now() - start),
        error: "Connection timed out",
      });
    }, timeoutMs);

    Bun.connect({
      hostname: server,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer);
          const elapsed = Math.round(performance.now() - start);
          socket.end();
          resolve({ status: "up", responseMs: elapsed });
        },
        data() {},
        error(socket, err) {
          clearTimeout(timer);
          const elapsed = Math.round(performance.now() - start);
          resolve({
            status: "down",
            responseMs: elapsed,
            error: err.message,
          });
        },
        close() {},
        connectError(socket, err) {
          clearTimeout(timer);
          const elapsed = Math.round(performance.now() - start);
          resolve({
            status: "down",
            responseMs: elapsed,
            error: err.message,
          });
        },
      },
    }).catch((err) => {
      clearTimeout(timer);
      const elapsed = Math.round(performance.now() - start);
      resolve({
        status: "down",
        responseMs: elapsed,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
