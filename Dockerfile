# --- Build: compile TypeScript (server + browser) with tsc ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY server ./server
COPY web ./web
COPY test ./test
RUN npm run build

# --- Runtime: production dependencies + compiled output only ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 UPLOAD_DIR=/data/uploads
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/public ./dist/public
COPY migrations ./migrations
COPY public ./public
# Bill photos are stored on disk; mount a persistent volume here. The database is PostgreSQL (DATABASE_URL).
RUN mkdir -p /data/uploads && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# Migrations run automatically at startup.
CMD ["node", "--import", "./dist/server/instrument.js", "dist/server/index.js"]
