import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Database } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Простой и предсказуемый раннер миграций.
 *
 * Почему без ORM-миграций: схема здесь — первоклассный артефакт, её нужно
 * читать и ревьюить как SQL. Каждый файл содержит секции `-- +migrate Up`
 * и `-- +migrate Down`, применяется в транзакции и фиксируется в таблице
 * `schema_migrations` вместе с контрольной суммой: изменение уже применённой
 * миграции будет замечено, а не применено «молча».
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export interface MigrationFile {
  id: string;
  filename: string;
  up: string;
  down: string;
  checksum: string;
}

const UP_MARKER = '-- +migrate Up';
const DOWN_MARKER = '-- +migrate Down';

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await fs.readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const filename of files) {
    const raw = await fs.readFile(path.join(dir, filename), 'utf8');
    const upIndex = raw.indexOf(UP_MARKER);
    const downIndex = raw.indexOf(DOWN_MARKER);

    if (upIndex === -1) {
      throw new Error(`Миграция ${filename} не содержит секции "${UP_MARKER}"`);
    }

    const up =
      downIndex === -1
        ? raw.slice(upIndex + UP_MARKER.length)
        : raw.slice(upIndex + UP_MARKER.length, downIndex);
    const down = downIndex === -1 ? '' : raw.slice(downIndex + DOWN_MARKER.length);

    migrations.push({
      id: filename.replace(/\.sql$/, ''),
      filename,
      up: up.trim(),
      down: down.trim(),
      checksum: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    });
  }
  return migrations;
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export interface MigrationStatus {
  id: string;
  applied: boolean;
  appliedAt: string | null;
  checksumMatches: boolean;
}

export async function getStatus(db: Database): Promise<MigrationStatus[]> {
  await ensureMigrationsTable(db);
  const migrations = await loadMigrations();
  const applied = await db.many<{ id: string; checksum: string; applied_at: string }>(
    'SELECT id, checksum, applied_at FROM schema_migrations',
  );
  const appliedMap = new Map(applied.map((row) => [row.id, row]));

  return migrations.map((m) => {
    const record = appliedMap.get(m.id);
    return {
      id: m.id,
      applied: Boolean(record),
      appliedAt: record?.applied_at ?? null,
      checksumMatches: record ? record.checksum === m.checksum : true,
    };
  });
}

/** Применить все непримененные миграции. Возвращает список применённых id. */
export async function migrateUp(db: Database): Promise<string[]> {
  await ensureMigrationsTable(db);
  const migrations = await loadMigrations();
  const applied = await db.many<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations',
  );
  const appliedMap = new Map(applied.map((row) => [row.id, row.checksum]));

  const executed: string[] = [];

  for (const migration of migrations) {
    const existingChecksum = appliedMap.get(migration.id);

    if (existingChecksum !== undefined) {
      if (existingChecksum !== migration.checksum) {
        // Менять уже применённую миграцию нельзя — это расхождение схемы.
        throw new Error(
          `Миграция ${migration.filename} изменена после применения ` +
            `(ожидалась контрольная сумма ${existingChecksum}, получена ${migration.checksum}). ` +
            'Создайте новую миграцию вместо правки существующей.',
        );
      }
      continue;
    }

    logger.info({ migration: migration.id }, 'Применяю миграцию');
    await db.transaction(async (tx) => {
      await tx.query(migration.up);
      await tx.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
        migration.id,
        migration.checksum,
      ]);
    });
    executed.push(migration.id);
  }

  return executed;
}

/** Откатить последнюю применённую миграцию. */
export async function migrateDown(db: Database, steps = 1): Promise<string[]> {
  await ensureMigrationsTable(db);
  const migrations = await loadMigrations();
  const byId = new Map(migrations.map((m) => [m.id, m]));

  const applied = await db.many<{ id: string }>(
    'SELECT id FROM schema_migrations ORDER BY id DESC LIMIT $1',
    [steps],
  );

  const reverted: string[] = [];
  for (const row of applied) {
    const migration = byId.get(row.id);
    if (!migration) {
      throw new Error(`Файл миграции ${row.id} не найден — откат невозможен.`);
    }
    if (!migration.down) {
      throw new Error(`Миграция ${row.id} не содержит секции "${DOWN_MARKER}".`);
    }
    logger.info({ migration: migration.id }, 'Откатываю миграцию');
    await db.transaction(async (tx) => {
      await tx.query(migration.down);
      await tx.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    });
    reverted.push(migration.id);
  }
  return reverted;
}
