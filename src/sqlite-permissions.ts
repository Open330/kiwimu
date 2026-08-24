import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";

const PRIVATE_FILE_MODE = 0o600;

function isFilesystemDatabase(dbPath: string): boolean {
  return process.platform !== "win32" && dbPath !== ":memory:" && !dbPath.startsWith("file:");
}

/** Create or tighten a SQLite database before opening it. */
export function preparePrivateSqliteFile(dbPath: string): void {
  if (!isFilesystemDatabase(dbPath)) return;

  let fd: number | undefined;
  try {
    fd = openSync(dbPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const metadata = lstatSync(dbPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`SQLite database path is not a regular file: ${dbPath}`);
    }
    // O_NOFOLLOW makes an existing project DB symlink fail closed instead of
    // changing or opening a file outside the project directory.
    fd = openSync(dbPath, constants.O_RDWR | constants.O_NOFOLLOW);
  }

  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`SQLite database path is not a regular file: ${dbPath}`);
    }
    fchmodSync(fd, PRIVATE_FILE_MODE);
  } finally {
    closeSync(fd);
  }
}

/** Tighten WAL/SHM files created while enabling WAL mode. */
export function hardenSqliteSidecars(dbPath: string): void {
  if (!isFilesystemDatabase(dbPath)) return;

  for (const suffix of ["-wal", "-shm"]) {
    const sidecarPath = `${dbPath}${suffix}`;
    let fd: number | undefined;
    try {
      const metadata = lstatSync(sidecarPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`SQLite sidecar path is not a regular file: ${sidecarPath}`);
      }
      fd = openSync(sidecarPath, constants.O_RDWR | constants.O_NOFOLLOW);
      if (!fstatSync(fd).isFile()) {
        throw new Error(`SQLite sidecar path is not a regular file: ${sidecarPath}`);
      }
      fchmodSync(fd, PRIVATE_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
