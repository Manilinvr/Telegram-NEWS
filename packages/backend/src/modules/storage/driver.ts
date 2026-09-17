import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../../config/env.js';
import { sha256 } from '../../lib/crypto.js';

/**
 * Хранилище медиа (ТЗ §18, §22).
 *
 * Абстракция намеренно минимальна: смена локального диска на S3/MinIO не
 * должна затрагивать код обработки. Общее для обоих драйверов правило —
 * файлы НЕ публичны: наружу отдаются только короткоживущие ссылки,
 * выдаваемые backend после проверки авторизации.
 */
export interface StorageDriver {
  readonly name: string;
  /** Сохранить объект и вернуть его ключ. */
  put(key: string, body: Buffer, contentType?: string): Promise<{ key: string; size: number }>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /**
   * Временная ссылка на объект.
   * Для локального драйвера — подписанный путь через API backend.
   */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Путь к файлу на диске, если драйвер поддерживает прямой доступ. */
  localPath?(key: string): Promise<string | null>;
}

/** Ключ объекта: разложение по датам не даёт каталогу разрастись. */
export function buildStorageKey(input: {
  sourceId: string;
  postId: string;
  filename: string;
  postedAt: Date;
}): string {
  const year = input.postedAt.getUTCFullYear();
  const month = String(input.postedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(input.postedAt.getUTCDate()).padStart(2, '0');
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  return `${year}/${month}/${day}/${input.postId}/${safeName}`;
}

/**
 * Локальный драйвер — для разработки и небольших установок.
 * Каталог хранения должен находиться вне веб-корня и не раздаваться
 * статикой напрямую.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Защита от выхода за пределы каталога хранения (path traversal). */
  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error(`Недопустимый ключ объекта: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer): Promise<{ key: string; size: number }> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    return { key, size: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /**
   * Ссылка вида `/api/media/<key>?exp=…&sig=…`.
   * Подпись проверяется backend, поэтому прямой доступ к каталогу не нужен.
   */
  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = signKey(key, expires);
    return `/api/media/${encodeURI(key)}?exp=${expires}&sig=${signature}`;
  }

  async localPath(key: string): Promise<string | null> {
    const target = this.resolve(key);
    try {
      await fs.access(target);
      return target;
    } catch {
      return null;
    }
  }

  createReadStream(key: string) {
    return createReadStream(this.resolve(key));
  }
}

/** Секрет подписи локальных ссылок. Задаётся при инициализации хранилища. */
let mediaSigningSecret = '';

export function configureMediaSigning(secret: string): void {
  mediaSigningSecret = secret;
}

export function signKey(key: string, expires: number): string {
  return sha256(`${mediaSigningSecret}:${key}:${expires}`).slice(0, 32);
}

/** Проверить подпись локальной ссылки на медиа. */
export function verifyMediaSignature(key: string, expires: number, signature: string): boolean {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  return signKey(key, expires) === signature;
}

/**
 * S3-совместимый драйвер (MinIO, S3).
 *
 * Клиент AWS SDK импортируется динамически: при `STORAGE_DRIVER=local`
 * пакет вообще не загружается и не влияет на время старта.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';
  private client: unknown;

  constructor(private readonly config: AppConfig) {}

  private async getClient() {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.client = new S3Client({
        region: this.config.S3_REGION,
        endpoint: this.config.S3_ENDPOINT,
        forcePathStyle: this.config.S3_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: this.config.S3_ACCESS_KEY_ID as string,
          secretAccessKey: this.config.S3_SECRET_ACCESS_KEY as string,
        },
      });
    }
    return this.client as import('@aws-sdk/client-s3').S3Client;
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<{ key: string; size: number }> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, size: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    const response = await client.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    await client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.getClient();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}

export function createStorageDriver(config: AppConfig): StorageDriver {
  if (config.STORAGE_DRIVER === 's3') {
    return new S3StorageDriver(config);
  }
  return new LocalStorageDriver(path.resolve(config.rootDir, config.STORAGE_LOCAL_PATH));
}
