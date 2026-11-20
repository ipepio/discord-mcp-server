# Production image for Discord MCP Server.
#
# Multi-stage: build with devDependencies (TypeScript compiler), runtime with
# production dependencies only. Node version matches docker-compose.yml.
#
# The app never migrates at startup (docs/architecture/persistence.md).
# Migrations are an explicit operator step:
#   docker compose run --rm app npm run migrate
# node-pg-migrate is a production dependency and migrations/ ships in this image.

FROM node:22.22.0 AS build
WORKDIR /srv/app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:22.22.0
WORKDIR /srv/app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /srv/app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
