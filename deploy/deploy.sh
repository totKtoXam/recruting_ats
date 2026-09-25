#!/usr/bin/env bash
# Выкладка релиза из текущего checkout. Запускается GitHub Actions runner'ом
# (или вручную под пользователем runner'а):
#   1. копирует код в $APP_DIR/releases/<id> и ставит production-зависимости;
#   2. переключает симлинк $APP_DIR/current и перезапускает сервис
#      (миграции БД применяются самим приложением при старте);
#   3. ждёт healthcheck; при неудаче возвращает предыдущий релиз.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/recruiting-ats}"
SERVICE="${SERVICE:-recruiting-ats}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/recruiting/healthz}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

revision="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo manual)"
release_dir="$APP_DIR/releases/$(date +%Y%m%d%H%M%S)-$revision"
previous="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"

echo "Релиз $release_dir"
mkdir -p "$release_dir"
tar -C "$SRC_DIR" -cf - package.json package-lock.json server web scripts | tar -C "$release_dir" -xf -
(cd "$release_dir" && npm ci --omit=dev --no-audit --no-fund)

activate() {
  ln -sfn "$1" "$APP_DIR/current.tmp"
  mv -Tf "$APP_DIR/current.tmp" "$APP_DIR/current"
  sudo -n systemctl restart "$SERVICE"
}

healthy() {
  for _ in $(seq 1 30); do
    curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

activate "$release_dir"

if ! healthy; then
  echo "Healthcheck $HEALTH_URL не прошёл, журнал сервиса:" >&2
  journalctl -u "$SERVICE" -n 50 --no-pager >&2 || true

  if [ -n "$previous" ] && [ -d "$previous" ]; then
    echo "Откат на $previous" >&2
    activate "$previous"
    rm -rf "$release_dir"
  fi
  exit 1
fi

# Оставляем последние релизы; активный — самый новый, поэтому не удаляется.
ls -1dt "$APP_DIR"/releases/*/ | tail -n +"$((KEEP_RELEASES + 1))" | xargs -r rm -rf
echo "Готово: $(readlink -f "$APP_DIR/current")"
