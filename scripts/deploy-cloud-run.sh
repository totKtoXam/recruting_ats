#!/usr/bin/env bash
# Деплой Recruiting ATS в Google Cloud Run.
#
#   1. Скопируйте .env.example в .env.cloudrun и заполните (файл в .gitignore).
#   2. gcloud auth login
#   3. PROJECT_ID=my-project ./scripts/deploy-cloud-run.sh
#
# Скрипт идемпотентен: повторный запуск обновляет секреты (только изменившиеся)
# и выкатывает новую ревизию из текущей рабочей копии.
set -euo pipefail

: "${PROJECT_ID:?Задайте PROJECT_ID — ID проекта Google Cloud}"
REGION="${REGION:-europe-west1}"          # Tier 1 регион: дешевле и входит в бесплатный лимит
SERVICE="${SERVICE:-recruiting-ats}"
ENV_FILE="${ENV_FILE:-.env.cloudrun}"
RUNTIME_SA_NAME="${SERVICE}-run"

cd "$(dirname "$0")/.."

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Не найден $ENV_FILE. Скопируйте .env.example и заполните значения." >&2
  exit 1
fi

# Читает значение переменной из env-файла (без интерпретации shell).
# Управляющие символы (например, CR из Windows-переводов строк) отбрасываются.
env_value() {
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '[:cntrl:]' || true
}

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "→ Включаю API (Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Drive)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com drive.googleapis.com

echo "→ Сервисный аккаунт, от имени которого работает сервис: $RUNTIME_SA"
if ! gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" --display-name "Recruiting ATS (Cloud Run)"
fi

# gcloud run deploy --source собирает образ от имени сервисного аккаунта Compute Engine.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${BUILD_SA}" --role roles/run.builder --condition None >/dev/null

# Секреты хранятся в Secret Manager, а не в переменных сервиса.
SECRETS=(SESSION_SECRET DATABASE_URL GOOGLE_CLIENT_SECRET GOOGLE_DRIVE_REFRESH_TOKEN ATS_API_KEY)
SECRET_FLAGS=()

for name in "${SECRETS[@]}"; do
  value="$(env_value "$name")"
  secret_id="ats-$(echo "$name" | tr '[:upper:]_' '[:lower:]-')"

  if [[ -z "$value" ]]; then
    echo "В $ENV_FILE не задан $name" >&2
    exit 1
  fi

  if ! gcloud secrets describe "$secret_id" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets create "$secret_id" --replication-policy automatic --data-file=- >/dev/null
    echo "→ Создан секрет $secret_id"
  elif [[ "$(gcloud secrets versions access latest --secret "$secret_id")" != "$value" ]]; then
    printf '%s' "$value" | gcloud secrets versions add "$secret_id" --data-file=- >/dev/null
    echo "→ Обновлён секрет $secret_id"
  fi

  gcloud secrets add-iam-policy-binding "$secret_id" \
    --member "serviceAccount:${RUNTIME_SA}" --role roles/secretmanager.secretAccessor >/dev/null
  SECRET_FLAGS+=("${name}=${secret_id}:latest")
done

# Адрес сервиса детерминирован, поэтому PUBLIC_URL известен до первого деплоя.
PUBLIC_URL="$(env_value PUBLIC_URL)"
PUBLIC_URL="${PUBLIC_URL:-https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app}"

# Разделитель "@" вместо запятой: в allowlist-переменных бывают запятые.
ENV_VARS="NODE_ENV=production@TRUST_PROXY=true@AUTH_MODE=google@DATABASE_SSL=true"
ENV_VARS+="@PUBLIC_URL=${PUBLIC_URL}"
ENV_VARS+="@APP_TIMEZONE=$(env_value APP_TIMEZONE)"
ENV_VARS+="@GOOGLE_CLIENT_ID=$(env_value GOOGLE_CLIENT_ID)"
ENV_VARS+="@AUTH_ALLOWED_DOMAINS=$(env_value AUTH_ALLOWED_DOMAINS)"
ENV_VARS+="@AUTH_ALLOWED_EMAILS=$(env_value AUTH_ALLOWED_EMAILS)"
ENV_VARS+="@GOOGLE_DRIVE_AUTH=$(env_value GOOGLE_DRIVE_AUTH)"
ENV_VARS+="@GOOGLE_DRIVE_ROOT_FOLDER_ID=$(env_value GOOGLE_DRIVE_ROOT_FOLDER_ID)"

echo "→ Сборка и деплой $SERVICE в $REGION"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 2 \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars "^@^${ENV_VARS}" \
  --set-secrets "$(IFS=,; echo "${SECRET_FLAGS[*]}")"

echo
echo "Готово: $PUBLIC_URL"
echo "Добавьте в OAuth-клиент Authorized redirect URI: ${PUBLIC_URL}/auth/google/callback"
