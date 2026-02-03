export type ParsedNotification = { title?: string; body: string };

export class OscParser {
  private buffer = "";
  private readonly onNotify: (n: ParsedNotification) => void;

  constructor(onNotify: (n: ParsedNotification) => void) {
    this.onNotify = onNotify;
  }

  public feed(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 256 * 1024) {
      this.buffer = this.buffer.slice(-128 * 1024);
    }

    this.unwrapTmuxPassthrough();

    const ESC = "\u001B";
    const BEL = "\u0007";
    const OSC_PREFIX = `${ESC}]`;
    const ST = `${ESC}\\`;

    while (true) {
      const start = this.buffer.indexOf(OSC_PREFIX);
      if (start === -1) {
        if (this.buffer.length > 4096) {
          this.buffer = this.buffer.slice(-4096);
        }
        return;
      }

      const afterStart = start + OSC_PREFIX.length;
      const endBel = this.buffer.indexOf(BEL, afterStart);
      const endSt = this.buffer.indexOf(ST, afterStart);

      let end = -1;
      let consume = 0;
      if (endBel !== -1 && (endSt === -1 || endBel < endSt)) {
        end = endBel;
        consume = 1;
      } else if (endSt !== -1) {
        end = endSt;
        consume = 2;
      } else {
        if (start > 0) {
          this.buffer = this.buffer.slice(start);
        }
        return;
      }

      const content = this.buffer.slice(afterStart, end);
      this.buffer = this.buffer.slice(end + consume);

      this.tryParseOsc(content);
    }
  }

  private tryParseOsc(content: string) {
    const s = content.trim();
    if (!s.startsWith("777;")) {
      return;
    }

    const parts = s.split(";");
    const command = parts[1];
    if (command?.toLowerCase() !== "notify") {
      return;
    }

    const title = parts[2] ?? "Terminal";
    const body = parts.length >= 4 ? parts.slice(3).join(";") : "";
    if (body.length > 0 || title.length > 0) {
      this.onNotify({ title, body });
    }
  }

  private unwrapTmuxPassthrough() {
    const ESC = "\u001B";
    const DCS_TMUX = `${ESC}Ptmux;`;
    const ST = `${ESC}\\`;

    while (true) {
      const i = this.buffer.indexOf(DCS_TMUX);
      if (i === -1) {
        return;
      }

      const after = i + DCS_TMUX.length;
      const end = this.buffer.indexOf(ST, after);
      if (end === -1) {
        if (i > 0) {
          this.buffer = this.buffer.slice(i);
        }
        return;
      }

      const inner = this.buffer
        .slice(after, end)
        .split("\u001B\u001B")
        .join("\u001B");
      this.buffer = this.buffer.slice(0, i) + inner + this.buffer.slice(end + ST.length);
    }
  }
}
