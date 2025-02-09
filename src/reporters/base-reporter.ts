import fs from "fs";
import path from "path";
import { promisify } from "util";
import { ErrorReason } from "../report";

const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);

export abstract class BaseReporter {
  private stderr: boolean;
  private outputDir: string | null;
  private resultFilename: string;
  constructor({
    stderr,
    outputDir,
    resultFilename,
  }: {
    stderr: boolean;
    outputDir: string | null;
    resultFilename: string;
  }) {
    this.stderr = stderr;
    this.outputDir = outputDir;
    this.resultFilename = resultFilename;
  }

  /**
   * Output test results to stderr or files
   * @param reasons
   */
  async output(reasons: readonly ErrorReason[]): Promise<void> {
    const promises = reasons.map(async reason => {
      const content = this.format(reason);
      if (this.stderr) {
        console.error(content);
      }
      if (this.outputDir) {
        const subDir = path.join(this.outputDir, path.basename(reason.entryConfigPath, ".json"));
        await mkdir(subDir, { recursive: true });
        await writeFile(path.join(subDir, this.resultFilename), content);
      }
    });
    await Promise.all(promises);
  }

  abstract format(reason: ErrorReason): string;
}
