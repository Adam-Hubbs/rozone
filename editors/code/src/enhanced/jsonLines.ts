import { StringDecoder } from "node:string_decoder";

/** Splits a byte stream into lines; tolerates partial chunks, split UTF-8 sequences and CRLF. */
export class LineFramer {
  #decoder = new StringDecoder("utf8");
  #pending = "";

  push(chunk: Buffer | string): string[] {
    this.#pending += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const parts = this.#pending.split("\n");
    this.#pending = parts.pop() ?? "";
    return parts.map((line) => line.replace(/\r$/, "")).filter((line) => line.trim() !== "");
  }

  /** Whatever is buffered without a terminating newline. */
  get remainder(): string {
    return this.#pending;
  }
}
