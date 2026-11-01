import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';

/**
 * Original uploaded files (bank statements) on the NAS documents folder.
 * Content-addressed: <DOCUMENTS_DIR>/<companyId>/<sha256[0..2]>/<sha256>. Files are written to a temporary name, fsynced and
 * renamed, so a crash never leaves a half-written file under a real name; they are never modified or deleted, so a backup of
 * the folder taken after the database dump always contains every file the dump refers to.
 * Without DOCUMENTS_DIR (development, tests) bytes stay in the database row instead.
 */
@Injectable()
export class DocumentStore {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  get enabled() {
    return Boolean(this.config.DOCUMENTS_DIR);
  }

  private pathFor(key: string) {
    const root = resolve(this.config.DOCUMENTS_DIR!);
    const p = resolve(root, key);
    if (!p.startsWith(root + '/')) throw new InternalServerErrorException({ code: 'DOCUMENT_PATH', message: 'Invalid document path' });
    return p;
  }

  /** Store bytes; returns the storage key, or null when documents are kept in the database. */
  async put(companyId: string, sha256: string, bytes: Buffer): Promise<string | null> {
    if (!this.enabled) return null;
    if (!/^[0-9a-f]{64}$/.test(sha256) || !/^[0-9a-f-]{36}$/.test(companyId)) throw new InternalServerErrorException({ code: 'DOCUMENT_KEY', message: 'Invalid document key' });
    const key = join(companyId, sha256.slice(0, 2), sha256);
    const path = this.pathFor(key);
    try {
      if ((await stat(path)).size === bytes.length) return key; // same content already stored
    } catch {
      /* not there yet */
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, path);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    return key;
  }

  /** Read a stored document, checking it still matches its recorded SHA-256. */
  async get(row: { storageKey: string | null; content: Uint8Array | null; sha256: string }): Promise<Buffer> {
    if (row.content) return Buffer.from(row.content);
    if (!row.storageKey || !this.enabled) throw new InternalServerErrorException({ code: 'DOCUMENT_MISSING', message: 'The stored file is not available on this server (is DOCUMENTS_DIR mounted?)' });
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathFor(row.storageKey));
    } catch {
      throw new InternalServerErrorException({ code: 'DOCUMENT_MISSING', message: 'The stored file is missing from the documents folder. Restore it from a backup.' });
    }
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw new InternalServerErrorException({ code: 'DOCUMENT_CORRUPT', message: 'The stored file no longer matches its checksum. Restore it from a backup.' });
    }
    return bytes;
  }
}
