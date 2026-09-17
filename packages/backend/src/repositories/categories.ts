import { DEFAULT_CATEGORIES, type CategoryDefinition } from '@nnm/shared';
import type { Database } from '../db/pool.js';

export interface CategoryRecord extends CategoryDefinition {
  sortOrder: number;
  isActive: boolean;
  isSystem: boolean;
}

/**
 * Категории (ТЗ §5).
 *
 * Расширяются через настройки без изменения архитектуры: код нигде не
 * ветвится по конкретной категории, а работает со slug как с произвольной
 * строкой.
 */
export class CategoriesRepository {
  constructor(private readonly db: Database) {}

  async list(includeInactive = false): Promise<CategoryRecord[]> {
    const rows = await this.db.many(
      `SELECT * FROM categories
        WHERE ($1::boolean OR is_active)
        ORDER BY sort_order, title`,
      [includeInactive],
    );
    return rows.map(toRecord);
  }

  async findBySlug(slug: string): Promise<CategoryRecord | null> {
    const row = await this.db.maybeOne('SELECT * FROM categories WHERE slug = $1', [slug]);
    return row ? toRecord(row) : null;
  }

  async upsert(input: Partial<CategoryRecord> & { slug: string; title: string }): Promise<CategoryRecord> {
    const row = await this.db.one(
      `INSERT INTO categories (slug, title, color, emoji, default_importance, keywords, sort_order, is_active, is_system)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         color = EXCLUDED.color,
         emoji = EXCLUDED.emoji,
         default_importance = EXCLUDED.default_importance,
         keywords = EXCLUDED.keywords,
         sort_order = EXCLUDED.sort_order,
         is_active = EXCLUDED.is_active
       RETURNING *`,
      [
        input.slug,
        input.title,
        input.color ?? '#94a3b8',
        input.emoji ?? '📰',
        input.defaultImportance ?? 'MEDIUM',
        input.keywords ?? [],
        input.sortOrder ?? 100,
        input.isActive ?? true,
        input.isSystem ?? false,
      ],
    );
    return toRecord(row);
  }

  /**
   * Добавить недостающие категории, НЕ трогая существующие.
   *
   * Отличие от seedDefaults существенное: тот перезаписывает название,
   * цвет и ключевые слова значениями по умолчанию, и на старте процесса
   * это откатывало бы правки, сделанные в настройках. Здесь только
   * вставка недостающего.
   *
   * Нужно потому, что справочник категорий — не пользовательские данные,
   * а часть схемы по смыслу: на slug категории ссылается внешний ключ
   * source_posts.category_slug. Пустой справочник означает, что разбор
   * каждой публикации падает с нарушением этого ключа.
   */
  async ensureDefaults(): Promise<number> {
    let inserted = 0;
    for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
      const result = await this.db.query(
        `INSERT INTO categories
           (slug, title, color, emoji, default_importance, keywords, sort_order, is_active, is_system)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
         ON CONFLICT (slug) DO NOTHING`,
        [
          category.slug,
          category.title,
          category.color ?? '#94a3b8',
          category.emoji ?? '📰',
          category.defaultImportance ?? 'MEDIUM',
          category.keywords ?? [],
          index * 10,
          category.slug === 'other',
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  }

  /** Заполнить таблицу начальным набором категорий, обновив существующие. */
  async seedDefaults(): Promise<number> {
    let count = 0;
    for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
      await this.upsert({
        ...category,
        sortOrder: index * 10,
        isActive: true,
        // `other` — обязательный fallback, удалять его нельзя.
        isSystem: category.slug === 'other',
      });
      count += 1;
    }
    return count;
  }

  /** Системные категории не удаляются — на них опирается AI-классификация. */
  async remove(slug: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM categories WHERE slug = $1 AND NOT is_system', [
      slug,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}

function toRecord(row: Record<string, unknown>): CategoryRecord {
  return {
    slug: String(row.slug),
    title: String(row.title),
    color: String(row.color),
    emoji: String(row.emoji),
    defaultImportance: String(row.default_importance) as CategoryDefinition['defaultImportance'],
    keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
    sortOrder: Number(row.sort_order),
    isActive: row.is_active === true,
    isSystem: row.is_system === true,
  };
}
