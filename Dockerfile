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
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/public ./dist/public
COPY migrations ./migrations
COPY public ./public
# Everything, bill photos included, is stored in PostgreSQL (DATABASE_URL): no disk needed.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# Migrations run automatically at startup.
CMD ["node", "--import", "./dist/server/instrument.js", "dist/server/index.js"]
