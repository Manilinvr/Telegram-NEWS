/**
 * @nnm/shared — общие типы и контракты backend и frontend.
 *
 * Пакет намеренно не содержит бизнес-логики и зависимостей от среды
 * выполнения: это позволяет переиспользовать его в будущем PWA и мобильном
 * приложении без изменения backend (ТЗ §26).
 */

export * from './domain/statuses.js';
export * from './domain/categories.js';
export * from './domain/types.js';
export * from './domain/views.js';
export * from './schemas/ai.js';
export * from './schemas/editorial.js';
export * from './schemas/filters.js';
export * from './constants.js';
