import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/** Listens on a random port so requests travel over real HTTP (needed for real timeouts). */
export async function listen(app: Express): Promise<RunningServer> {
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections(); // a simulated hang would otherwise keep the server open
        server.close(() => resolve());
      }),
  };
}
