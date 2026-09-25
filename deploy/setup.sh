#!/usr/bin/env bash
# Первичная подготовка сервера (Debian/Ubuntu). Запускать от root из корня репозитория:
#   sudo bash deploy/setup.sh
# Повторный запуск безопасен: существующий env-файл не перезаписывается.
set -euo pipefail

APP_USER="${APP_USER:-recruiting}"
RUNNER_USER="${RUNNER_USER:-github-runner}"
APP_DIR="${APP_DIR:-/opt/recruiting-ats}"
ENV_DIR=/etc/recruiting-ats
SERVICE=recruiting-ats
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root: sudo bash deploy/setup.sh" >&2
  exit 1
fi

apt-get update -qq
apt-get install -y -qq curl ca-certificates git tar openssl

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "Node.js $(node -v)"

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
id "$RUNNER_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$RUNNER_USER"
# Чтение журнала сервиса при неудачном деплое.
usermod -aG systemd-journal "$RUNNER_USER"

# Релизы выкладывает runner, сервис их только читает.
install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 755 "$APP_DIR" "$APP_DIR/releases"

install -d -o root -g "$APP_USER" -m 750 "$ENV_DIR"
if [ ! -f "$ENV_DIR/env" ]; then
  sed \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 48)|" \
    -e "s|^ATS_API_KEY=.*|ATS_API_KEY=ats_$(openssl rand -hex 24)|" \
    "$SRC_DIR/env.production.example" > "$ENV_DIR/env"
  echo "Создан $ENV_DIR/env — заполните DATABASE_URL и Google-переменные."
fi
chown root:"$APP_USER" "$ENV_DIR/env"
chmod 640 "$ENV_DIR/env"

install -m 644 "$SRC_DIR/recruiting-ats.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

# Runner может только перезапускать сервис.
systemctl_bin="$(command -v systemctl)"
cat > /etc/sudoers.d/recruiting-ats <<SUDOERS
$RUNNER_USER ALL=(root) NOPASSWD: $systemctl_bin restart $SERVICE
SUDOERS
chmod 440 /etc/sudoers.d/recruiting-ats
visudo -cf /etc/sudoers.d/recruiting-ats >/dev/null

if [ -d /etc/nginx ]; then
  install -d /etc/nginx/snippets
  install -m 644 "$SRC_DIR/nginx-recruiting.conf" /etc/nginx/snippets/recruiting-ats.conf
  echo "nginx: добавьте 'include snippets/recruiting-ats.conf;' в server-блок portal.devexpert.kz, затем nginx -t && systemctl reload nginx"
else
  echo "nginx не найден: установите его и подключите deploy/nginx-recruiting.conf" >&2
fi

echo
echo "Дальше:"
echo "  1. Заполните $ENV_DIR/env."
echo "  2. Установите GitHub Actions runner под пользователем $RUNNER_USER с меткой recruiting-ats (см. deploy/README.md)."
echo "  3. Первый релиз: sudo -u $RUNNER_USER bash deploy/deploy.sh  (или Actions → Deploy → Run workflow)."
