FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
# 建置時抓最新版工具頁；要固定版本可設 TOOLS_REF（build arg）
ARG TOOLS_REF=main
RUN sh scripts/sync-tools.sh "$TOOLS_REF"
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3460
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3460/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
