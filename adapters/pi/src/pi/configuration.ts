import { PreparedConfiguration as SharedConfiguration } from "@xper/adapter-shared/configuration";

/** Pi presents the preparation state; the shared cache never calls the recorder. */
export class PreparedConfiguration extends SharedConfiguration {
  constructor(cwd: string) {
    super(cwd, "pi");
  }
  summary(): string {
    const profile = this.snapshot?.routing?.profile;
    const source =
      this.source === "defaults"
        ? "Pi defaults; configuration is not prepared"
        : `${this.source} configuration${profile ? ` (profile ${profile})` : " (Pi model)"}`;
    const problem = this.problem?.replace("adapter defaults", "Pi defaults");
    return `${source}${problem ? `; ${problem}` : ""}`;
  }
}
