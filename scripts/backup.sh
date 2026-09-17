#!/usr/bin/env bash
#
# Резервное копирование базы данных.
#
# Создаёт дамп в формате custom (сжатый, позволяет выборочное
# восстановление) и удаляет копии старше заданного срока.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Значения берутся из .env, если он есть; переменные окружения имеют приоритет.
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

if [[ -z "$DATABASE_URL" ]]; then
  echo "Ошибка: не задан DATABASE_URL (проверьте .env)." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "Ошибка: pg_dump не найден. Установите клиент PostgreSQL." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d-%H%M%S)"
TARGET="$BACKUP_DIR/nnm-$STAMP.dump"

echo "Создаю резервную копию: $TARGET"

# Сначала пишем во временный файл: прерванный дамп не должен выглядеть
# как готовая копия и попасть под ротацию как валидный.
pg_dump "$DATABASE_URL" --format=custom --compress=6 --file="$TARGET.partial"
mv "$TARGET.partial" "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "Готово: $TARGET ($SIZE)"

if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  REMOVED="$(find "$BACKUP_DIR" -name 'nnm-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
  if [[ "$REMOVED" -gt 0 ]]; then
    echo "Удалено устаревших копий (старше $RETENTION_DAYS дн.): $REMOVED"
  fi
fi

echo
echo "Напоминание: копия хранится на этом же сервере и не защищает от отказа"
echo "диска. Скопируйте её в отдельное место. Файл .env в копию НЕ входит —"
echo "храните его в менеджере секретов отдельно."
