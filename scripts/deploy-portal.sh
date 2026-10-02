#!/usr/bin/env bash
# Выкладка Recruiting ATS на portal.devexpert.kz. Запускается на самом сервере:
# self-hosted раннером GitHub Actions (.github/workflows/deploy.yml) или вручную по SSH.
#
#   scripts/deploy-portal.sh [<sha>]     # без аргумента — origin/main
#
# Переменные (необязательные): HR_ATS_DIR (~/hr-ats), HR_ATS_SERVICE (hr-ats),
# HR_ATS_HEALTH_URL (http://127.0.0.1:3040/hr-ats/healthz), FORCE=1 — перезапустить,
# даже если этот коммит уже выложен.
set -euo pipefail

APP_DIR="${HR_ATS_DIR:-$HOME/hr-ats}"
SERVICE="${HR_ATS_SERVICE:-hr-ats}"
HEALTH_URL="${HR_ATS_HEALTH_URL:-http://127.0.0.1:3040/hr-ats/healthz}"
TARGET="${1:-origin/main}"

cd "$APP_DIR"

git fetch --quiet origin main
target_sha="$(git rev-parse --verify "${TARGET}^{commit}")"
previous_sha="$(git rev-parse HEAD)"

# Старый коммит из очереди не должен откатывать более новый: выкладываем только вперёд.
if [[ "${FORCE:-}" != "1" ]] && git merge-base --is-ancestor "$target_sha" "$previous_sha"; then
  echo "Коммит ${target_sha:0:7} уже выложен (на сервере ${previous_sha:0:7}) — ничего не делаю."
  exit 0
fi

echo "Выкладка ${previous_sha:0:7} -> ${target_sha:0:7}"
# Рабочая копия на сервере — только артефакт выкладки, истина в origin. reset (а не merge --ff-only)
# переживает и переписанную историю origin; игнорируемые файлы (.env, node_modules) не трогаются.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Внимание: на сервере есть правки отслеживаемых файлов — они будут отброшены:" >&2
  git status --short --untracked-files=no >&2
fi
git reset --hard --quiet "$target_sha"

npm ci --omit=dev --no-audit --no-fund

sudo systemctl restart "$SERVICE"

# Миграции БД выполняются при старте приложения — ждём, пока сервис ответит.
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Сервис $SERVICE отвечает (попытка $attempt): $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"
    exit 0
  fi
  sleep 2
done

echo "Сервис $SERVICE не ответил на $HEALTH_URL за 60 с. Последние строки журнала:" >&2
sudo journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
echo "Предыдущий коммит: $previous_sha — откат: git -C $APP_DIR reset --hard $previous_sha && npm ci --omit=dev && sudo systemctl restart $SERVICE" >&2
exit 1
