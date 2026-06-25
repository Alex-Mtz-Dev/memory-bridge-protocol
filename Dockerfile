# AIK Memory Bridge — cloud-deployable single-container image
# Build: docker build -t aik-memory-bridge .
# Run:   docker run -p 4317:4317 -v aik-data:/data \
#            -e AIK_API_KEYS=key1,key2 aik-memory-bridge

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json biome.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Store lives at /data — mount a volume or bind-mount here.
ENV AIK_MEMORY_BRIDGE_HOME=/data
# Comma-separated API keys. Empty = no auth (local dev only).
ENV AIK_API_KEYS=""
# Port the server binds to inside the container.
ENV PORT=4317
VOLUME ["/data"]
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1
CMD ["sh", "-c", "node dist/cli/aik.js memory-bridge serve --host 0.0.0.0 --port ${PORT}"]
