declare module "turndown" {
  interface Options {
    headingStyle?: "setext" | "atx";
    bulletListMarker?: "-" | "+" | "*";
    codeBlockStyle?: "indented" | "fenced";
  }

  export default class TurndownService {
    constructor(options?: Options);
    remove(filter: string | string[]): this;
    turndown(input: string): string;
  }
}
