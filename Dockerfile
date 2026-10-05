FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY src ./src
COPY migrations ./migrations
COPY scripts/container-smoke.ts scripts/container-runner-test.ts ./scripts/
RUN mkdir /data /sessions && chown -R node:node /data /sessions /app
USER node
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/server.ts"]
