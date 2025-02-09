import fs from "fs";
import { compiler as ClosureCompiler } from "google-closure-compiler";
import { dirname } from "path";
import * as tempy from "tempy";
import { WarningsWhitelistItem } from "./entryconfig";
import { logger } from "./logger";

export interface CompilerOptions {
  [idx: string]: any;
  /**
   * `LOOSE` and `STRICT` are deprecated. Use `PRUNE_LEGACY` and `PRUNE` respectedly.
   * See https://github.com/google/closure-compiler/commit/bab8ee8274abc162f72aa64ebe573c83ed38bb20
   */
  dependency_mode?: "NONE" | "SORT_ONLY" | "PRUNE_LEGACY" | "PRUNE" | "LOOSE" | "STRICT";
  entry_point?: readonly string[];
  compilation_level?: CompilationLevel;
  js?: readonly string[];
  js_output_file?: string;
  // NOTE: To support older compiler, use old `module` term instead of `chunk`
  // chunk (module): `name:num-js-files[:[dep,...][:]]`, ex) "chunk1:3:app"
  module?: readonly string[];
  // chunkname:wrappercode
  module_wrapper?: readonly string[];
  module_output_path_prefix?: string;
  language_in?: string;
  language_out?: string;
  json_streams?: "IN" | "OUT" | "BOTH";
  error_format?: "STANDARD" | "JSON";
  warning_level?: "QUIET" | "DEFAULT" | "VERBOSE";
  warnings_whitelist_file?: string;
  debug?: boolean;
  formatting?: readonly CompilerOptionsFormattingType[];
  define?: readonly string[];
  externs?: readonly string[];
  isolation_mode?: "NONE" | "IIFE";
  output_wrapper?: string;
  rename_prefix_namespace?: string;
  jscomp_error?: readonly string[];
  jscomp_warning?: readonly string[];
  jscomp_off?: readonly string[];
  flagfile?: string;
}

export type CompilationLevel = "BUNDLE" | "WHITESPACE" | "SIMPLE" | "ADVANCED";
export type CompilerOptionsFormattingType =
  | "PRETTY_PRINT"
  | "PRINT_INPUT_DELIMITER"
  | "SINGLE_QUOTES";

export interface ExtendedCompilerOptions {
  compilerOptions: CompilerOptions;
  batch?: "aws" | "local";
  warningsWhitelist?: WarningsWhitelistItem[];
}

export interface CompilerOutput {
  path: string;
  src: string;
  source_map: string;
}

/**
 * @throws If compiler throws errors
 */
export async function compileToJson(
  extendedOpts: ExtendedCompilerOptions
): Promise<CompilerOutput[]> {
  extendedOpts.compilerOptions = {
    ...extendedOpts.compilerOptions,
    json_streams: "OUT",
    error_format: "JSON",
  };
  const outputs: CompilerOutput[] = JSON.parse(await compile(extendedOpts));
  if (extendedOpts.batch) {
    // Reduce transfer size in batch mode.
    // The maximum request/response size of AWS Lambda is 6MB each.
    // See https://faastjs.org/docs/aws#queue-vs-https-mode
    return outputs.map(({ path, src }) => ({ path, src, source_map: "" }));
  } else {
    return outputs;
  }
}

async function compile(extendedOpts: ExtendedCompilerOptions): Promise<string> {
  let opts = extendedOpts.compilerOptions;
  if (isInAwsLambda()) {
    rewriteNodePathForAwsLambda(opts);
  }
  // Avoid `spawn E2BIG` error for too large arguments
  if (opts.js && opts.js.length > 100) {
    opts = convertToFlagfile(opts);
  }
  if (extendedOpts.warningsWhitelist) {
    opts.warnings_whitelist_file = createWarningsWhitelistFile(extendedOpts.warningsWhitelist);
  }
  const compiler = new ClosureCompiler(opts as any);
  if (extendedOpts.batch) {
    compiler.JAR_PATH = null;
    try {
      const { getNativeImagePath } = await import("google-closure-compiler/lib/utils");
      compiler.javaPath = getNativeImagePath();
    } catch {
      throw new Error("Installed google-closure-compiler is too old for batch mode.");
    }
  }
  return new Promise((resolve, reject) => {
    compiler.run((exitCode: number, stdout: string, stderr?: string) => {
      if (exitCode !== 0) {
        return reject(new CompilerError(stderr || "No stderr", exitCode));
      }
      resolve(stdout);
    });
  });
}

function isInAwsLambda(): boolean {
  return !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

function rewriteNodePathForAwsLambda(options: CompilerOptions): void {
  if (options.js) {
    // google-closure-library is installed as a Lambda Layer.
    // It's extracted in /opt/nodejs/node_modules/google-closure-library.
    // But working directory is /var/task in Lambda.
    // The relative path is different from local environment.
    // So convert options.js paths.
    const closureLibraryDir = dirname(
      // use `eval` to avoid webpack replacement
      // eslint-disable-next-line no-eval
      eval("require.resolve")("google-closure-library/package.json")
    );
    options.js = options.js.map(js =>
      js.replace(/^node_modules\/google-closure-library/, closureLibraryDir)
    );
  }
}

export class CompilerError extends Error {
  exitCode: number;
  constructor(msg: string, exitCode: number) {
    super(msg);
    this.name = "CompilerError";
    this.exitCode = exitCode;
  }
}

/**
 * To avoid "spawn E2BIG" errors on a large scale project,
 * transfer compiler options via a flagfile instead of CLI arguments.
 */
export function convertToFlagfile(opts: CompilerOptions): { flagfile: string } {
  const flagfile = tempy.file({
    name: `${new Date().toISOString().replace(/[^\w]/g, "")}.closure.conf`,
  });
  const lines: string[] = [];
  Object.entries(opts).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      lines.push(...value.map(v => createKeyValue(key, v)));
    } else {
      lines.push(createKeyValue(key, value));
    }
  });
  fs.writeFileSync(flagfile, lines.join("\n"), "utf8");
  // logger is not initialized with pino in batch mode.
  const log = logger ? logger.info.bind(logger) : console.info.bind(console);
  log(`flagfile: ${flagfile}`);
  return { flagfile };

  function createKeyValue(key: string, value: any): string {
    return `--${key} "${escape(String(value))}"`;
  }
}

/**
 * Escape for Closure Compiler flag files.
 * It handles only double-qotes, not single.
 * @see https://github.com/google/closure-compiler/blob/v20190301/src/com/google/javascript/jscomp/CommandLineRunner.java#L1500
 */
function escape(str: string): string {
  return str.replace(/"/g, '\\"');
}

/**
 * Create a warnings whitelist file and return the file path
 */
function createWarningsWhitelistFile(whitelist: WarningsWhitelistItem[]): string {
  const content = whitelist
    .map(({ file, line, description }) => `${file}:${line ? line : ""}  ${description}`)
    .join("\n");
  const file = tempy.file({ name: "warnings-whitelist.txt" });
  fs.writeFileSync(file, content);
  return file;
}
