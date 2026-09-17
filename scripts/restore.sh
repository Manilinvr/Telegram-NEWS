#!/usr/bin/env bash
#
# Восстановление базы данных из резервной копии.
#
# ВНИМАНИЕ: операция перезаписывает текущие данные и запрашивает
# подтверждение.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

DUMP_FILE="${1:-}"
DATABASE_URL="${DATABASE_URL:-}"

if [[ -z "$DUMP_FILE" ]]; then
  echo "Использование: npm run restore -- <файл.dump>" >&2
  echo >&2
  echo "Доступные копии:" >&2
  ls -lh "${BACKUP_DIR:-$ROOT_DIR/backups}"/nnm-*.dump 2>/dev/null || echo "  (копий не найдено)" >&2
  exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Ошибка: файл не найден: $DUMP_FILE" >&2
  exit 1
fi

if [[ -z "$DATABASE_URL" ]]; then
  echo "Ошибка: не задан DATABASE_URL (проверьте .env)." >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "Ошибка: pg_restore не найден. Установите клиент PostgreSQL." >&2
  exit 1
fi

# Адрес показываем без пароля.
SAFE_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#(//[^:]+):[^@]*@#\1:***@#')"

echo "Восстановление ПЕРЕЗАПИШЕТ текущие данные."
echo "  База:  $SAFE_URL"
echo "  Копия: $DUMP_FILE"
echo
read -r -p "Введите 'да' для подтверждения: " CONFIRM

if [[ "$CONFIRM" != "да" ]]; then
  echo "Отменено."
  exit 0
fi

echo "Восстанавливаю…"

# --clean --if-exists убирает существующие объекты перед восстановлением.
# --no-owner позволяет восстановить дамп под другой учётной записью БД.
pg_restore \
  --dbname="$DATABASE_URL" \
  --clean --if-exists \
  --no-owner \
  --no-privileges \
  "$DUMP_FILE"

echo
echo "Восстановление завершено."
echo "Примените миграции, появившиеся после создания копии:"
echo "  npm run migrate"
