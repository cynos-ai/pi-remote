import { access, constants, realpath, stat } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";

const execFile = promisify(execFileCallback);

export class InvalidProjectPathError extends Error {
  constructor() {
    super("project path is not an accessible directory under an allowed root");
    this.name = "InvalidProjectPathError";
  }
}

export interface ValidatedProjectPath {
  rootPath: string;
  rootIdentity: string;
  workspaceKey: string;
  gitCommonDir: string | null;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (
    remainder !== ".." &&
    !remainder.startsWith(".." + sep) &&
    !isAbsolute(remainder)
  );
}

async function gitCommonDirectory(rootPath: string): Promise<string | null> {
  try {
    const result = await execFile(
      "git",
      ["-C", rootPath, "rev-parse", "--git-common-dir"],
      { timeout: 2000, maxBuffer: 4096 }
    );
    const output = result.stdout.trim();
    if (!output) return null;
    const candidate = isAbsolute(output) ? output : resolve(rootPath, output);
    try {
      return await realpath(candidate);
    } catch {
      return candidate;
    }
  } catch {
    return null;
  }
}

export class ProjectPathService {
  constructor(private readonly allowedRootPaths: readonly string[]) {}

  async validate(inputPath: string): Promise<ValidatedProjectPath> {
    try {
      const roots = await Promise.all(this.allowedRootPaths.map((root) => realpath(root)));
      const rootPath = await realpath(inputPath);
      const info = await stat(rootPath);
      if (!info.isDirectory()) throw new InvalidProjectPathError();
      await access(rootPath, constants.R_OK | constants.W_OK);
      if (!roots.some((allowedRoot) => isWithinRoot(rootPath, allowedRoot))) {
        throw new InvalidProjectPathError();
      }
      const rootIdentity = String(info.dev) + ":" + String(info.ino);
      const gitCommonDir = await gitCommonDirectory(rootPath);
      const workspaceKey = gitCommonDir === null
        ? "path:" + rootPath
        : "git:" + gitCommonDir;
      return { rootPath, rootIdentity, workspaceKey, gitCommonDir };
    } catch (error) {
      if (error instanceof InvalidProjectPathError) throw error;
      throw new InvalidProjectPathError();
    }
  }
}
