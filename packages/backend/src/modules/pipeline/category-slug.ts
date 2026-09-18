import { childLogger } from '../../lib/logger.js';

const log = childLogger({ module: 'category-slug' });

/**
 * Привести категорию из разбора к существующей в справочнике.
 *
 * Сравнение нестрогое: модель возвращает то название, которое ей
 * показали, но регистр и пробелы она сохраняет не всегда, а иногда
 * называет категорию по-русски — заголовком из того же справочника.
 * Совпадение по названию поэтому тоже принимается.
 *
 * Ничего не подошло — берётся `other`, обязательная системная категория.
 * Возврат null (справочник пуст) допустим: колонка обнуляемая.
 */
export function resolveCategorySlug(
  candidate: string | null | undefined,
  categories: Array<{ slug: string; title: string }>,
): string | null {
  if (categories.length === 0) return null;

  const wanted = (candidate ?? '').trim().toLowerCase();
  if (wanted) {
    const match = categories.find(
      (category) =>
        category.slug.toLowerCase() === wanted || category.title.trim().toLowerCase() === wanted,
    );
    if (match) return match.slug;
    log.warn({ candidate }, 'Категория из разбора отсутствует в справочнике — берётся other');
  }

  return categories.find((category) => category.slug === 'other')?.slug ?? null;
}

