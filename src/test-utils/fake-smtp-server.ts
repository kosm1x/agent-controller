/**
 * Scripted SMTP server for email-verify integration tests. Listens on
 * 127.0.0.1 at a random port; replies are chosen per RCPT TO address so a
 * test can express "this mailbox is full, that one is unknown".
 */

import * as net from "node:net";

export interface FakeSmtpScript {
  /** Banner line; default "220 fake ESMTP". */
  banner?: string;
  /** Reply to EHLO; default multi-line 250. */
  ehlo?: string;
  /** Reply to MAIL FROM; default "250 2.1.0 Ok". */
  mailFrom?: string;
  /** Reply per lowercased RCPT TO address; `default` is the fallback. */
  rcpt: Record<string, string> & { default?: string };
  /** Milliseconds to delay every reply (for timeout tests). */
  delayMs?: number;
  /** Drop the connection instead of sending a banner. */
  dropOnConnect?: boolean;
  /** Close the socket (no reply) right after receiving a command starting with this verb, e.g. "MAIL FROM". */
  closeAfter?: string;
  /** Write every reply one byte at a time to exercise partial-buffer framing. */
  fragment?: boolean;
}

export interface FakeSmtpServer {
  port: number;
  /** Every command line received, across all connections. */
  commands: string[];
  connections: number;
  close(): Promise<void>;
}

export async function startFakeSmtp(script: FakeSmtpScript): Promise<FakeSmtpServer> {
  const commands: string[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const state = { connections: 0 };
  const delay = script.delayMs ?? 0;

  const server = net.createServer((socket) => {
    state.connections += 1;
    if (script.dropOnConnect) {
      socket.destroy();
      return;
    }
    const write = (text: string): void => {
      if (socket.destroyed) return;
      if (script.fragment) for (const ch of text) socket.write(ch);
      else socket.write(text);
    };
    const reply = (line: string): void => {
      const text = line.endsWith("\r\n") ? line : `${line}\r\n`;
      if (delay > 0) {
        const t = setTimeout(() => write(text), delay);
        timers.push(t);
      } else write(text);
    };
    reply(script.banner ?? "220 fake ESMTP");
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        commands.push(line);
        const upper = line.toUpperCase();
        if (script.closeAfter && upper.startsWith(script.closeAfter.toUpperCase())) {
          socket.destroy();
          return;
        }
        if (upper.startsWith("EHLO")) reply(script.ehlo ?? "250-fake\r\n250-PIPELINING\r\n250 8BITMIME");
        else if (upper.startsWith("HELO")) reply("250 fake");
        else if (upper.startsWith("MAIL FROM")) reply(script.mailFrom ?? "250 2.1.0 Ok");
        else if (upper.startsWith("RCPT TO")) {
          const addr = /<([^>]*)>/.exec(line)?.[1]?.toLowerCase() ?? "";
          reply(script.rcpt[addr] ?? script.rcpt.default ?? "550 5.1.1 User unknown");
        } else if (upper.startsWith("QUIT")) {
          reply("221 2.0.0 Bye");
          socket.end();
        } else reply("500 5.5.1 Command unrecognized");
      }
    });
    socket.on("error", () => {
      /* client went away */
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    commands,
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.close(() => resolve());
      }),
  };
}
