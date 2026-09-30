FROM node:22-alpine

ENV NODE_ENV=production
# В образе нет .git: коммит для «Настройки → Для разработчиков» — docker build --build-arg BUILD_COMMIT=$(git rev-parse HEAD) .
ARG BUILD_COMMIT=
ENV BUILD_COMMIT=$BUILD_COMMIT
ENV PORT=3040
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web
COPY scripts ./scripts

USER node
EXPOSE 3040

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3040/healthz || exit 1

CMD ["node", "server/index.js"]
